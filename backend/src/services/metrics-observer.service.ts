import mongoose from "mongoose";
import { spawn } from "node:child_process";
import { getIO } from "../config/socket.js";
import { RunModel } from "../models/run.model.js";
import {
  runScalarTraceQuerySafe,
  extractScalarValues,
  SERVICE_ATTRIBUTE,
  DURATION_ATTRIBUTE,
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

// --- Container resource metrics via `docker stats` ----------------------
//
// Queries Docker directly for the one container we actually started —
// no OTel collector, no receiver config, no attribute-name guessing.
// `docker stats <name> --no-stream` returns one JSON line for that
// container's current CPU/memory, which is exactly what we need since we
// already know containerName from activeRuns.

const DOCKER_STATS_TIMEOUT_MS = 5_000;

interface DockerStatsLine {
  CPUPerc?: string; // e.g. "12.34%"
  MemUsage?: string; // e.g. "123.4MiB / 512MiB"
}

// Converts docker stats' human-readable units ("123.4MiB", "1.2GiB",
// "512KiB") to MB. Falls back to 0 for anything unrecognized rather than
// throwing — a parse miss here shouldn't take down the whole metrics tick.
function parseMemToMB(raw: string): number {
  const match = raw.trim().match(/^([\d.]+)\s*([KMGT]?i?B)$/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const multiplierToMB: Record<string, number> = {
    B: 1 / (1024 * 1024),
    KB: 1 / 1024,
    KIB: 1 / 1024,
    MB: 1,
    MIB: 1,
    GB: 1024,
    GIB: 1024,
    TB: 1024 * 1024,
    TIB: 1024 * 1024,
  };
  return Math.round(value * (multiplierToMB[unit] ?? 1) * 100) / 100;
}

async function getContainerResourceMetrics(
  containerName: string,
): Promise<{ cpuPercent: number; memoryMB: number } | null> {
  return new Promise((resolve) => {
    const child = spawn("docker", [
      "stats",
      containerName,
      "--no-stream",
      "--format",
      "{{json .}}",
    ]);

    let stdout = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve(null);
    }, DOCKER_STATS_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      console.error(
        `[MetricsObserver] docker stats spawn error for ${containerName}:`,
        err.message,
      );
      resolve(null);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      // Non-zero exit or empty output almost always means the container
      // already stopped between this tick and the last one — treat as
      // "no data right now" rather than logging noise every 5s.
      if (code !== 0 || !stdout.trim()) {
        resolve(null);
        return;
      }

      try {
        const stat: DockerStatsLine = JSON.parse(stdout.trim().split("\n")[0]);
        const cpuPercent =
          parseFloat(String(stat.CPUPerc ?? "0").replace("%", "")) || 0;
        const memUsedRaw =
          String(stat.MemUsage ?? "0MiB").split("/")[0]?.trim() ?? "0MiB";
        resolve({ cpuPercent, memoryMB: parseMemToMB(memUsedRaw) });
      } catch (err) {
        console.error(
          `[MetricsObserver] Failed to parse docker stats output for ${containerName}:`,
          err,
          "raw:",
          stdout.slice(0, 300),
        );
        resolve(null);
      }
    });
  });
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
