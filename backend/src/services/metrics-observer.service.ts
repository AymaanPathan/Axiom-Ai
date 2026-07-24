
import mongoose from "mongoose";
import { getIO } from "../config/socket.js";
import { RunModel } from "../models/run.model.js";
import {
  runScalarTraceQuerySafe,
  runScalarMetricQuerySafe,
  extractScalarValues,
  SERVICE_ATTRIBUTE,
  DURATION_ATTRIBUTE,
  CONTAINER_NAME_ATTRIBUTE,
  nanoToMs,
} from "./signoz.service.js";

export interface MetricSnapshot {
  timestamp: number;
  cpuPercent: number;
  memoryMB: number;
  requestRate: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface ServiceHealth {
  status: "healthy" | "degraded" | "down" | "unknown";
  uptimeSeconds: number;
  lastSeenAt: string;
}

export interface SystemStatus {
  mongo: "connected" | "disconnected";
  redis: "connected" | "disconnected";
  container: {
    status: "running" | "stopped" | "restarting" | "unknown";
    image: string;
    port: number | null;
    startedAt: string | null;
  };
}

const PUSH_INTERVAL_MS = 5_000;
const AGGREGATE_WINDOW_MS = 60_000; // trailing 60s window for rate/latency calc
const MAX_HISTORY_POINTS = 180; // ~15 min at 5s interval
const ERROR_RATE_DEGRADED_THRESHOLD = 0.05; // 5%

interface RepoLoopState {
  intervalHandle: NodeJS.Timeout;
  containerName: string;
  serviceName: string;
  runStartedAt: number;
  history: MetricSnapshot[];
}

const loops = new Map<string, RepoLoopState>();

// --- SigNoz container resource metrics (replaces `docker stats`) -------
//
// Needs the OTel Collector's `docker_stats` receiver running against the
// Docker socket and exporting to SigNoz. `container.cpu.utilization` is a
// 0..1 gauge (Docker's %CPU / 100). `container.memory.usage.total` is
// bytes and excludes cache, matching what `docker stats` shows as
// MemUsage. Both are keyed by the `container.name` resource attribute.
//
// NOTE: if this comes back empty/zero, check how `container.name` is
// actually populated for your containers in SigNoz's explorer — Docker's
// own API returns names with a leading "/", and depending on collector
// version that may or may not be stripped before ingestion.
const CONTAINER_METRIC_WINDOW_MS = 30_000; // must exceed the collector's scrape interval

async function getContainerResourceMetrics(
  containerName: string,
): Promise<{ cpuPercent: number; memoryMB: number } | null> {
  const end = Date.now();
  const start = end - CONTAINER_METRIC_WINDOW_MS;
  const warnings: string[] = [];
  const escapedName = containerName.replace(/'/g, "\\'");


  const bareName = containerName.replace(/^\/+/, "");
  const escapedBare = bareName.replace(/'/g, "\\'");
  const escapedSlashed = `/${bareName}`.replace(/'/g, "\\'");
  const filter = `(${CONTAINER_NAME_ATTRIBUTE} = '${escapedBare}' OR ${CONTAINER_NAME_ATTRIBUTE} = '${escapedSlashed}')`;

  const [cpuRaw, memRaw] = await Promise.all([
    runScalarMetricQuerySafe(
      start,
      end,
      filter,
      {
        metricName: "container.cpu.utilization",
        timeAggregation: "avg",
        spaceAggregation: "avg",
        reduceTo: "last",
      },
      "container CPU utilization",
      warnings,
    ),
    runScalarMetricQuerySafe(
      start,
      end,
      filter,
      {
        metricName: "container.memory.usage.total",
        timeAggregation: "avg",
        spaceAggregation: "avg",
        reduceTo: "last",
      },
      "container memory usage",
      warnings,
    ),
  ]);

  if (warnings.length > 0) {
    console.warn(
      `[MetricsObserver] getContainerResourceMetrics(${containerName}) warnings:`,
      warnings,
    );
  }

  const cpuValues = extractScalarValues(cpuRaw, [{ alias: "value" }]);
  const memValues = extractScalarValues(memRaw, [{ alias: "value" }]);

  const cpuFraction = cpuValues.value; // 0..1
  const memBytes = memValues.value;

  if (cpuFraction === null && memBytes === null) return null;

  return {
    cpuPercent:
      cpuFraction !== null ? Math.round(cpuFraction * 10000) / 100 : 0,
    memoryMB:
      memBytes !== null ? Math.round((memBytes / 1024 / 1024) * 100) / 100 : 0,
  };
}

// --- SigNoz aggregate (whole service, no route filter) ----------------

async function getServiceAggregate(
  serviceName: string,
  windowMs: number,
): Promise<{
  requestRate: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}> {
  const end = Date.now();
  const start = end - windowMs;
  const warnings: string[] = [];
  const escapedService = serviceName.replace(/'/g, "\\'");
  const filter = `${SERVICE_ATTRIBUTE} = '${escapedService}'`;

  const latencyAggregations = [
    { expression: `p50(${DURATION_ATTRIBUTE})`, alias: "p50" },
    { expression: `p95(${DURATION_ATTRIBUTE})`, alias: "p95" },
    { expression: `p99(${DURATION_ATTRIBUTE})`, alias: "p99" },
    { expression: "count()", alias: "request_count" },
  ];
  const latencyRaw = await runScalarTraceQuerySafe(
    start,
    end,
    filter,
    latencyAggregations,
    "service aggregate latency/request count",
    warnings,
  );
  const latencyValues = extractScalarValues(latencyRaw, latencyAggregations);

  const errorAggregations = [{ expression: "count()", alias: "error_count" }];
  const errorRaw = await runScalarTraceQuerySafe(
    start,
    end,
    `${filter} AND hasError = true`,
    errorAggregations,
    "service aggregate error count",
    warnings,
  );
  const errorValues = extractScalarValues(errorRaw, errorAggregations);

  const requestCount = latencyValues.request_count ?? 0;
  const errorCount = errorValues.error_count ?? 0;
  const windowSeconds = windowMs / 1000;

  return {
    requestRate: requestCount / windowSeconds,
    errorRate: requestCount > 0 ? errorCount / requestCount : 0,
    p50Ms: nanoToMs(latencyValues.p50),
    p95Ms: nanoToMs(latencyValues.p95),
    p99Ms: nanoToMs(latencyValues.p99),
  };
}

// --- lifecycle ----------------------------------------------------------

export function startMetricsLoop(
  repositoryId: string,
  containerName: string,
  serviceName: string,
): void {
  stopMetricsLoop(repositoryId); // clear any stale loop first

  const state: RepoLoopState = {
    containerName,
    serviceName,
    runStartedAt: Date.now(),
    history: [],
    intervalHandle: setInterval(async () => {
      const [stats, aggregate] = await Promise.all([
        getContainerResourceMetrics(containerName).catch(() => null),
        getServiceAggregate(serviceName, AGGREGATE_WINDOW_MS).catch(() => ({
          requestRate: 0,
          errorRate: 0,
          p50Ms: 0,
          p95Ms: 0,
          p99Ms: 0,
        })),
      ]);

      const snapshot: MetricSnapshot = {
        timestamp: Date.now(),
        cpuPercent: stats?.cpuPercent ?? 0,
        memoryMB: stats?.memoryMB ?? 0,
        ...aggregate,
      };

      const loop = loops.get(repositoryId);
      if (!loop) return; // stopped mid-flight
      loop.history.push(snapshot);
      if (loop.history.length > MAX_HISTORY_POINTS) loop.history.shift();

      getIO()
        .to(`repo:${repositoryId}`)
        .emit("service:metrics", { repositoryId, ...snapshot });
    }, PUSH_INTERVAL_MS),
  };

  loops.set(repositoryId, state);
}

export function stopMetricsLoop(repositoryId: string): void {
  const existing = loops.get(repositoryId);
  if (existing) {
    clearInterval(existing.intervalHandle);
    loops.delete(repositoryId);
  }
}

// --- REST-facing reads ----------------------------------------------------

export function getMetricHistory(repositoryId: string): MetricSnapshot[] {
  return loops.get(repositoryId)?.history ?? [];
}

export async function getServiceHealth(
  repositoryId: string,
): Promise<ServiceHealth> {
  const loop = loops.get(repositoryId);
  const latestRun = await RunModel.findOne({ repositoryId }).sort({
    createdAt: -1,
  });

  if (!loop || !latestRun || latestRun.status !== "running") {
    return {
      status: latestRun?.status === "running" ? "degraded" : "down",
      uptimeSeconds: 0,
      lastSeenAt: new Date().toISOString(),
    };
  }

  const latest = loop.history[loop.history.length - 1];
  const status =
    latest && latest.errorRate > ERROR_RATE_DEGRADED_THRESHOLD
      ? "degraded"
      : "healthy";

  return {
    status,
    uptimeSeconds: Math.floor((Date.now() - loop.runStartedAt) / 1000),
    lastSeenAt: new Date(latest?.timestamp ?? Date.now()).toISOString(),
  };
}

export async function getSystemStatus(
  repositoryId: string,
): Promise<SystemStatus> {
  const latestRun = await RunModel.findOne({ repositoryId }).sort({
    createdAt: -1,
  });
  const loop = loops.get(repositoryId);

  return {
    mongo: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    // TODO: wire to your actual Redis client's status if it exposes one
    // (e.g. redisClient.status === "ready"). Defaulting to "connected"
    // since the backend itself wouldn't have booted without it per
    // connectRedis() in server.ts.
    redis: "connected",
    container: {
      status:
        latestRun?.status === "running"
          ? "running"
          : latestRun?.status === "error"
            ? "restarting"
            : latestRun
              ? "stopped"
              : "unknown",
      image: "axiom-runner:latest",
      port: latestRun?.port ?? null,
      startedAt: loop ? new Date(loop.runStartedAt).toISOString() : null,
    },
  };
}
