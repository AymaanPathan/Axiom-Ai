// backend/src/services/optimizationArena.service.ts
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { applySnippetReplace } from "./codePatch.service.js";
import { startDockerRun, stopDockerRun } from "../docker/docker-run.service.js";
import { RunModel } from "../models/run.model.js";
import { runLoadScript } from "./loadScriptRunner.service.js";
import { getRouteTelemetry, RouteTelemetry } from "./signoz.service.js";
import { getIO } from "../config/socket.js";
import type { LoadScriptResult } from "./loadScriptRunner.service.js";
import type { OptimizationStrategy } from "./performanceAnalysis.service.js";

const ARENA_TMP_ROOT = path.join(os.tmpdir(), "axiom-arena");
const HEALTHCHECK_RETRIES = 120;
const HEALTHCHECK_INTERVAL_MS = 1800;
const CONTAINER_BOOT_WAIT_MS = 2000;
const METRICS_POLL_INTERVAL_MS = 1000;

export type ArenaStage =
  | "queued"
  | "copying"
  | "patching"
  | "provisioning"
  | "healthcheck"
  | "benchmarking"
  | "telemetry"
  | "completed"
  | "failed";

export interface ArenaCandidateResult {
  strategyId: string;
  title: string;
  status: "completed" | "failed";
  error?: string;
  runResult?: LoadScriptResult;
  telemetry?: RouteTelemetry | null;
  cpuPercent?: number | null;
  memoryMB?: number | null;
  score?: number;
  metricsHistory?: {
    cpuPercent: number;
    memoryMB: number;
    timestamp: number;
  }[]; // NEW
}

export interface ArenaResult {
  arenaId: string;
  candidates: ArenaCandidateResult[];
  winnerStrategyId: string | null;
}

function emitArena(arenaId: string, event: string, payload: object) {
  getIO()
    .to(`arena:${arenaId}`)
    .emit(event, { arenaId, ...payload });
}

function emitCandidateStatus(
  arenaId: string,
  strategyId: string,
  stage: ArenaStage,
  extra?: { message?: string; error?: string; runId?: string },
) {
  emitArena(arenaId, "arena:candidate:status", { strategyId, stage, ...extra });
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForAppReady(port: number, runId: string): Promise<boolean> {
  for (let i = 0; i < HEALTHCHECK_RETRIES; i++) {
    const run = await RunModel.findById(runId);
    if (run?.status === "error") return false;
    // Trust the run's own status once docker-run.service.ts's healthcheck
    // has marked it running — don't re-derive readiness from a second,
    // independently-timed fetch loop that can disagree with it.
    if (run?.status === "running") return true;

    try {
      await fetch(`http://localhost:${port}/`, {
        signal: AbortSignal.timeout(1500),
      });
      return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, HEALTHCHECK_INTERVAL_MS));
  }
  return false;
}

// Installs deps once into a shared, read-only cache that every candidate
// container mounts at /app/node_modules — strategies only ever patch
// source files, never package.json, so re-installing per-candidate is
// pure wasted wall-clock time. Returns null on failure so callers fall
// back to per-container installs instead of hard-failing the arena.
async function prewarmNodeModules(
  repositoryId: string,
  sourceLocalPath: string,
): Promise<string | null> {
  const cachePath = path.join(
    ARENA_TMP_ROOT,
    repositoryId,
    "node_modules_cache",
  );
  await fs.rm(cachePath, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(cachePath, { recursive: true });

  return new Promise((resolve) => {
    const child = spawn("docker", [
      "run",
      "--rm",
      "-v",
      `${sourceLocalPath}:/app/src:ro`,
      "-v",
      `${cachePath}:/app/node_modules`,
      "-w",
      "/app",
      "axiom-runner:latest",
      "sh",
      "-c",
      "cp /app/src/package.json /app/ && (cp /app/src/package-lock.json /app/ 2>/dev/null || true) && npm install",
    ]);
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? cachePath : null));
  });
}

function retargetScriptPort(script: string, port: number): string {
  return script.replace(
    /const BASE_URL\s*=\s*["'`]http:\/\/localhost:\d+["'`]/,
    `const BASE_URL = "http://localhost:${port}"`,
  );
}

function startLiveMetricsPolling(
  arenaId: string,
  strategyId: string,
  serviceName: string,
  onSample: (sample: {
    cpuPercent: number;
    memoryMB: number;
    timestamp: number;
  }) => void,
): () => void {
  let stopped = false;
  const timer = setInterval(async () => {
    if (stopped) return;
    const metrics =
      (await getContainerResourceMetricsSafe(serviceName)) ??
      (await getDockerStatsFallback(serviceName));
    if (!metrics || stopped) return;
    const sample = {
      cpuPercent: metrics.cpuPercent,
      memoryMB: metrics.memoryMB,
      timestamp: Date.now(),
    };
    onSample(sample);
    emitArena(arenaId, "arena:candidate:metrics", { strategyId, ...sample });
  }, METRICS_POLL_INTERVAL_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
async function runOneCandidate(opts: {
  arenaId: string;
  repositoryId: string;
  userId: string;
  sourceLocalPath: string;
  strategy: OptimizationStrategy;
  script: string;
  authToken?: string;
  envVars: Record<string, string>;
  method: string;
  routePath: string;
  appPort: number;
  nodeModulesCachePath: string | null;
}): Promise<ArenaCandidateResult> {
  const { strategy, arenaId } = opts;
  const isolatedPath = path.join(
    ARENA_TMP_ROOT,
    opts.repositoryId,
    strategy.id,
    randomUUID(),
  );
  const serviceName =
    `arena-${opts.repositoryId.slice(-6)}-${strategy.id}`.toLowerCase();
  let runId: string | null = null;
  let stopMetricsPolling: (() => void) | null = null;

  const fail = (error: string): ArenaCandidateResult => {
    emitCandidateStatus(arenaId, strategy.id, "failed", { error });
    return {
      strategyId: strategy.id,
      title: strategy.title,
      status: "failed",
      error,
      metricsHistory,
    };
  };
  const metricsHistory: {
    cpuPercent: number;
    memoryMB: number;
    timestamp: number;
  }[] = [];

  try {
    emitCandidateStatus(arenaId, strategy.id, "copying");
    await fs.mkdir(isolatedPath, { recursive: true });
    await fs.cp(opts.sourceLocalPath, isolatedPath, { recursive: true });

    emitCandidateStatus(arenaId, strategy.id, "patching");
    const patch = await applySnippetReplace(
      isolatedPath,
      strategy.diff.filePath,
      strategy.diff.originalCode,
      strategy.diff.newCode,
    );
    if (!patch.applied) return fail(patch.error ?? "Patch failed to apply");

    emitCandidateStatus(arenaId, strategy.id, "provisioning");
    const hostPort = await getFreePort();
    runId = await startDockerRun({
      repositoryId: opts.repositoryId,
      userId: opts.userId,
      localPath: isolatedPath,
      envVars: { ...opts.envVars, OTEL_SERVICE_NAME: serviceName },
      appPort: opts.appPort,
      hostPort,
      serviceName,
      healthCheckPath: "/",
      containerName: serviceName,
      nodeModulesCachePath: opts.nodeModulesCachePath ?? undefined,
    });
    emitCandidateStatus(arenaId, strategy.id, "provisioning", { runId });

    await new Promise((r) => setTimeout(r, CONTAINER_BOOT_WAIT_MS));
    emitCandidateStatus(arenaId, strategy.id, "healthcheck", { runId });
    const ready = await waitForAppReady(hostPort, runId);
    if (!ready) return fail("Container did not become healthy");

    emitCandidateStatus(arenaId, strategy.id, "benchmarking", { runId });
   stopMetricsPolling = startLiveMetricsPolling(
     arenaId,
     strategy.id,
     serviceName,
     (sample) => metricsHistory.push(sample),
   );
   const stopTelemetryPolling = startLiveTelemetryPolling(
     arenaId,
     strategy.id,
     serviceName,
     opts.method,
     opts.routePath,
     Date.now(),
   );
    const retargeted = retargetScriptPort(opts.script, hostPort);
    const runResult = await runLoadScript({
      repositoryId: opts.repositoryId,
      script: retargeted,
      authToken: opts.authToken,
      // Tags every live traffic:progress event from this run with the
      // strategy it belongs to and routes it to the arena room, so the
      // Arena UI can show real running requests/success/error/avg-latency
      // numbers WHILE this candidate is benchmarking, not just after.
      arena: { arenaId, strategyId: strategy.id },
    });
    stopMetricsPolling();
    stopMetricsPolling = null;
    stopTelemetryPolling();

    emitCandidateStatus(arenaId, strategy.id, "telemetry", { runId });
    let telemetry: RouteTelemetry | null = null;
    try {
      telemetry = await getRouteTelemetry(
        serviceName,
        opts.method,
        opts.routePath,
        runResult.windowStart,
        runResult.windowEnd,
      );
    } catch (err) {
      console.error(`[Arena ${strategy.id}] telemetry fetch failed:`, err);
    }

   let resourceMetrics = await getContainerResourceMetricsSafe(serviceName);
   if (!resourceMetrics) {
     resourceMetrics = await getDockerStatsFallback(serviceName);
   }

    const result: ArenaCandidateResult = {
      strategyId: strategy.id,
      title: strategy.title,
      status: "completed",
      runResult,
      telemetry,
      cpuPercent: resourceMetrics?.cpuPercent ?? null,
      memoryMB: resourceMetrics?.memoryMB ?? null,
      metricsHistory,
    };
    emitCandidateStatus(arenaId, strategy.id, "completed", { runId });
    return result;
  } catch (err) {
    console.error(`[Arena ${strategy.id}] failed:`, err);
    return fail(err instanceof Error ? err.message : "Unknown arena error");
  } finally {
    if (stopMetricsPolling) stopMetricsPolling();
    if (runId) await stopDockerRun(runId).catch(() => {});
    await fs.rm(isolatedPath, { recursive: true, force: true }).catch(() => {});
  }
}

const WEIGHTS = { avg: 0.4, p95: 0.3, cpu: 0.15, mem: 0.15 };

function scoreCandidates(
  candidates: ArenaCandidateResult[],
): ArenaCandidateResult[] {
  const completed = candidates.filter(
    (c) => c.status === "completed" && c.runResult,
  );
  if (completed.length === 0) return candidates;

  const bestAvg = Math.min(...completed.map((c) => c.runResult!.avgDurationMs));
  const bestP95 = Math.min(
    ...completed.map(
      (c) => c.runResult!.p95DurationMs ?? c.runResult!.avgDurationMs,
    ),
  );
  const bestCpu = Math.min(...completed.map((c) => c.cpuPercent ?? 1));
  const bestMem = Math.min(...completed.map((c) => c.memoryMB ?? 1));

  return candidates.map((c) => {
    if (c.status !== "completed" || !c.runResult) return c;
    const avg = c.runResult.avgDurationMs || 1;
    const p95 = c.runResult.p95DurationMs ?? avg;
    const cpu = c.cpuPercent && c.cpuPercent > 0 ? c.cpuPercent : bestCpu || 1;
    const mem = c.memoryMB && c.memoryMB > 0 ? c.memoryMB : bestMem || 1;

    let score =
      100 *
      (WEIGHTS.avg * (bestAvg / avg) +
        WEIGHTS.p95 * (bestP95 / p95) +
        WEIGHTS.cpu * (bestCpu / cpu) +
        WEIGHTS.mem * (bestMem / mem));

    if (c.runResult.errorCount > 0) score *= 0.5;

    return { ...c, score: Math.round(score) };
  });
}

export async function runOptimizationArena(opts: {
  arenaId: string;
  repositoryId: string;
  userId: string;
  sourceLocalPath: string;
  strategies: OptimizationStrategy[];
  script: string;
  authToken?: string;
  envVars: Record<string, string>;
  method: string;
  routePath: string;
  appPort: number;
}): Promise<ArenaResult> {
  for (const s of opts.strategies) {
    emitCandidateStatus(opts.arenaId, s.id, "queued");
  }

  // One npm install for the whole arena instead of one per strategy —
  // strategies only ever patch source files, never package.json/lockfile,
  // so this is pure shared cost. Front-loading it also means candidates
  // don't eat their own healthcheck budget on install time.
  emitArena(opts.arenaId, "arena:prewarm", {
    message: "Installing dependencies once for all strategies…",
  });
  const nodeModulesCachePath = await prewarmNodeModules(
    opts.repositoryId,
    opts.sourceLocalPath,
  );
  emitArena(opts.arenaId, "arena:prewarm:done", {
    cached: nodeModulesCachePath !== null,
  });

  const candidates: ArenaCandidateResult[] = [];
  for (const strategy of opts.strategies) {
    const result = await runOneCandidate({
      arenaId: opts.arenaId,
      repositoryId: opts.repositoryId,
      userId: opts.userId,
      sourceLocalPath: opts.sourceLocalPath,
      strategy,
      script: opts.script,
      authToken: opts.authToken,
      envVars: opts.envVars,
      method: opts.method,
      routePath: opts.routePath,
      appPort: opts.appPort,
      nodeModulesCachePath,
    });
    candidates.push(result);
  }

  if (nodeModulesCachePath) {
    await fs
      .rm(nodeModulesCachePath, { recursive: true, force: true })
      .catch(() => {});
  }

  const scored = scoreCandidates(candidates);
  const winner = scored
    .filter((c) => c.status === "completed" && typeof c.score === "number")
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];

  return {
    arenaId: opts.arenaId,
    candidates: scored,
    winnerStrategyId: winner?.strategyId ?? null,
  };
}
async function getContainerResourceMetricsSafe(
  serviceName: string,
): Promise<{ cpuPercent: number; memoryMB: number } | null> {
  const {
    runScalarMetricQuerySafe,
    extractScalarValues,
    CONTAINER_NAME_ATTRIBUTE,
  } = await import("./signoz.service.js");
  const end = Date.now();
  const start = end - 30_000;
  const warnings: string[] = [];
  const filter = `${CONTAINER_NAME_ATTRIBUTE} = '${serviceName}'`;
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
      "arena cpu",
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
      "arena mem",
      warnings,
    ),
  ]);
  const cpu = extractScalarValues(cpuRaw, [{ alias: "value" }]).value;
  const mem = extractScalarValues(memRaw, [{ alias: "value" }]).value;
  if (cpu === null && mem === null) return null;
  return {
    cpuPercent: cpu !== null ? Math.round(cpu * 10000) / 100 : 0,
    memoryMB: mem !== null ? Math.round((mem / 1024 / 1024) * 100) / 100 : 0,
  };
}


interface ArenaSession {
  repositoryId: string;
  userId: string;
  sourceLocalPath: string;
  nodeModulesCachePath: string | null;
  envVars: Record<string, string>;
  method: string;
  routePath: string;
  appPort: number;
  results: Map<string, ArenaCandidateResult>;
}

const arenaSessions = new Map<string, ArenaSession>();

export async function initArenaEnvironment(opts: {
  arenaId: string;
  repositoryId: string;
  userId: string;
  sourceLocalPath: string;
  envVars: Record<string, string>;
  method: string;
  routePath: string;
  appPort: number;
}): Promise<void> {
  emitArena(opts.arenaId, "arena:prewarm", {
    message: "Installing dependencies once for all strategies…",
  });
  const nodeModulesCachePath = await prewarmNodeModules(
    opts.repositoryId,
    opts.sourceLocalPath,
  );
  emitArena(opts.arenaId, "arena:prewarm:done", {
    cached: nodeModulesCachePath !== null,
  });

  arenaSessions.set(opts.arenaId, {
    repositoryId: opts.repositoryId,
    userId: opts.userId,
    sourceLocalPath: opts.sourceLocalPath,
    nodeModulesCachePath,
    envVars: opts.envVars,
    method: opts.method,
    routePath: opts.routePath,
    appPort: opts.appPort,
    results: new Map(),
  });
}

export async function runArenaCandidate(opts: {
  arenaId: string;
  strategy: OptimizationStrategy;
  script: string;
  authToken?: string;
}): Promise<ArenaCandidateResult> {
  const session = arenaSessions.get(opts.arenaId);
  if (!session) {
    throw new Error("Arena session not found — call init-arena first");
  }

  const result = await runOneCandidate({
    arenaId: opts.arenaId,
    repositoryId: session.repositoryId,
    userId: session.userId,
    sourceLocalPath: session.sourceLocalPath,
    strategy: opts.strategy,
    script: opts.script,
    authToken: opts.authToken,
    envVars: session.envVars,
    method: session.method,
    routePath: session.routePath,
    appPort: session.appPort,
    nodeModulesCachePath: session.nodeModulesCachePath,
  });

  session.results.set(opts.strategy.id, result);
  return result;
}

export async function finalizeArena(arenaId: string): Promise<ArenaResult> {
  const session = arenaSessions.get(arenaId);
  if (!session) throw new Error("Arena session not found");

  const candidates = Array.from(session.results.values());
  const scored = scoreCandidates(candidates);
  const winner = scored
    .filter((c) => c.status === "completed" && typeof c.score === "number")
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];

  if (session.nodeModulesCachePath) {
    await fs
      .rm(session.nodeModulesCachePath, { recursive: true, force: true })
      .catch(() => {});
  }
  arenaSessions.delete(arenaId);

  const result: ArenaResult = {
    arenaId,
    candidates: scored,
    winnerStrategyId: winner?.strategyId ?? null,
  };
  emitArena(arenaId, "arena:complete", { arenaId, result });
  return result;
}


// Fallback when SigNoz's container-metrics pipeline is lagging or not
// scraping — `docker stats` is synchronous truth, no OTEL dependency.
async function getDockerStatsFallback(
  containerName: string,
): Promise<{ cpuPercent: number; memoryMB: number } | null> {
  return new Promise((resolve) => {
    const child = spawn("docker", [
      "stats", "--no-stream", "--format", "{{json .}}", containerName,
    ]);
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", (code) => {
      if (code !== 0 || !out.trim()) return resolve(null);
      try {
        const stats = JSON.parse(out.trim());
        const cpuPercent = parseFloat(stats.CPUPerc.replace("%", "")) || 0;
        const m = /^([\d.]+)(KiB|MiB|GiB)/.exec(stats.MemUsage);
        let memoryMB = 0;
        if (m) {
          const val = parseFloat(m[1]);
          memoryMB = m[2] === "GiB" ? val * 1024 : m[2] === "KiB" ? val / 1024 : val;
        }
        resolve({ cpuPercent, memoryMB: Math.round(memoryMB * 100) / 100 });
      } catch {
        resolve(null);
      }
    });
    child.on("error", () => resolve(null));
  });
}

// Polls SigNoz for the route's p50/p95/error rate DURING benchmarking,
// not just after — same query used by getTelemetry, on a 2.5s tick,
// scoped to the arena room only.
function startLiveTelemetryPolling(
  arenaId: string,
  strategyId: string,
  serviceName: string,
  method: string,
  routePath: string,
  windowStart: number,
): () => void {
  let stopped = false;
  const timer = setInterval(async () => {
    if (stopped) return;
    try {
      const t = await getRouteTelemetry(
        serviceName, method, routePath, windowStart, Date.now(),
      );
      if (!stopped) {
        emitArena(arenaId, "arena:candidate:telemetry", { strategyId, telemetry: t });
      }
    } catch {
      // keep last good value, retry next tick
    }
  }, 2500);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}