// backend/src/services/optimizationArena.service.ts
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { applyStrategyChanges } from "./codePatch.service.js";
import { startDockerRun, stopDockerRun } from "../docker/docker-run.service.js";
import { RunModel } from "../models/run.model.js";
import { runLoadScript } from "./loadScriptRunner.service.js";
import {
  getOrCreateRouteDashboardUrl,
  getRouteTelemetry,
  RouteTelemetry,
} from "./signoz.service.js";
import { getIO } from "../config/socket.js";
import type { LoadScriptResult } from "./loadScriptRunner.service.js";
import type { OptimizationStrategy } from "./performanceAnalysis.service.js";

const ARENA_TMP_ROOT = path.join(os.tmpdir(), "axiom-arena");
const HEALTHCHECK_RETRIES = 120;
const HEALTHCHECK_INTERVAL_MS = 1800;
const CONTAINER_BOOT_WAIT_MS = 2000;
const METRICS_POLL_INTERVAL_MS = 1000;
const TELEMETRY_POLL_INTERVAL_MS = 2500;

// A SigNoz scalar query rejects start === end ("start time must be before
// end time"). windowStart is captured with Date.now() and the live-poll
// tick fires synchronously right after (see startLiveTelemetryPolling) —
// millisecond-resolution clocks make it very common for both calls to
// land in the same millisecond, especially on the very first tick. Every
// telemetry window built in this file goes through this helper so that
// invariant (end > start, by a real margin) can never be silently broken
// again.
const MIN_TELEMETRY_WINDOW_MS = 1000;
function widenWindowEnd(start: number, end: number): number {
  return Math.max(end, start + MIN_TELEMETRY_WINDOW_MS);
}

// Spans go through OTel's BatchSpanProcessor before being exported (see
// OTEL_BSP_SCHEDULE_DELAY in docker-run.service.ts), then still need
// collector ingest + SigNoz indexing before they're queryable. A fast
// candidate benchmark can finish and have this function called before
// that pipeline has caught up, which would otherwise report a spurious
// requestCount=0 even though the run genuinely produced traffic. Retries
// a few times with a short delay before accepting a zero result as real.
const TELEMETRY_SETTLE_RETRIES = 3;
const TELEMETRY_SETTLE_DELAY_MS = 800;
async function getRouteTelemetryWithRetry(
  serviceName: string,
  method: string,
  routePath: string,
  start: number,
  end: number,
): Promise<RouteTelemetry> {
  const widenedEnd = widenWindowEnd(start, end);
  let last: RouteTelemetry = await getRouteTelemetry(
    serviceName,
    method,
    routePath,
    start,
    widenedEnd,
  );
  for (
    let attempt = 1;
    attempt < TELEMETRY_SETTLE_RETRIES && last.requestCount === 0;
    attempt++
  ) {
    await new Promise((r) => setTimeout(r, TELEMETRY_SETTLE_DELAY_MS));
    // Re-widen against "now" too, in case very little time has passed —
    // the ingest lag is what we're waiting out, not wall-clock coverage
    // of the original window.
    last = await getRouteTelemetry(
      serviceName,
      method,
      routePath,
      start,
      widenWindowEnd(start, Date.now()),
    );
  }
  return last;
}

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

const LOCALHOST_URL_PATTERN = /http:\/\/localhost:\d+/g;

function retargetScriptPort(
  script: string,
  port: number,
): { script: string; replacements: number } {
  let replacements = 0;
  const retargeted = script.replace(LOCALHOST_URL_PATTERN, () => {
    replacements++;
    return `http://localhost:${port}`;
  });
  return { script: retargeted, replacements };
}

// Re-checks a strategy's file-existence assumptions against what's
// ACTUALLY on disk in this candidate's freshly-copied isolatedPath, right
// before patching. Strategy plans are validated once against
// existingFilePaths/knownFilePaths at generate-strategies time, but that
// snapshot can go stale by the time a candidate actually runs — most
// commonly because a successful /apply-fix-and-retest call (which patches
// repository.localPath permanently and does NOT revert on success) added
// a file the strategy's "create" targets, after the strategy was already
// generated and handed to the arena.
//
// Without this check, applyStrategyChanges' createNewFile guard still
// catches the collision — that safety net was never broken — but it
// surfaces as a bare "Cannot create X — a file already exists" with no
// indication of WHY, several pipeline stages after the plan was made.
// This gives the same protection with an actionable message instead.
async function findStaleCreateTargets(
  isolatedPath: string,
  strategy: OptimizationStrategy,
): Promise<string[]> {
  const stale: string[] = [];
  for (const change of strategy.changes) {
    if (change.changeType !== "create") continue;
    const exists = await fs
      .access(path.join(isolatedPath, change.filePath))
      .then(() => true)
      .catch(() => false);
    if (exists) stale.push(change.filePath);
  }
  return stale;
}

// FIXED: previously used a bare setInterval, which only fires AFTER the
// first full interval elapses (1000ms here). Fast benchmarks — e.g. a
// small VU count that finishes in a few hundred ms — could complete and
// call stopMetricsPolling() before a single tick ever ran, meaning the
// live CPU/Mem panel and metricsHistory stayed empty for the entire
// candidate even though the container was up and being sampled-for. Now
// we fire one sample immediately, then fall into the normal interval.
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

  const tick = async () => {
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
  };

  void tick(); // sample immediately instead of waiting a full interval
  const timer = setInterval(tick, METRICS_POLL_INTERVAL_MS);

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

  const metricsHistory: {
    cpuPercent: number;
    memoryMB: number;
    timestamp: number;
  }[] = [];

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

  try {
    emitCandidateStatus(arenaId, strategy.id, "copying");
    await fs.mkdir(isolatedPath, { recursive: true });
    await fs.cp(opts.sourceLocalPath, isolatedPath, { recursive: true });

    emitCandidateStatus(arenaId, strategy.id, "patching");

    const staleCreates = await findStaleCreateTargets(isolatedPath, strategy);
    if (staleCreates.length > 0) {
      return fail(
        `This strategy's plan is stale: ${staleCreates.join(", ")} already exist${staleCreates.length === 1 ? "s" : ""} in the repository now, even though ${staleCreates.length === 1 ? "it" : "they"} didn't when this strategy was generated (most likely a fix was applied to the repo since then). Regenerate strategies and retry.`,
      );
    }

    const patch = await applyStrategyChanges(isolatedPath, strategy.changes);
    if (!patch.applied) {
      return fail(
        patch.error
          ? `Failed to apply "${patch.failedFilePath ?? "a file"}": ${patch.error}`
          : "Patch failed to apply",
      );
    }

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
    const { script: retargeted, replacements } = retargetScriptPort(
      opts.script,
      hostPort,
    );
    if (replacements === 0) {
      stopMetricsPolling();
      stopMetricsPolling = null;
      stopTelemetryPolling();
      return fail(
        `Load script for "${strategy.title}" contains no "http://localhost:<port>" URL to retarget — ` +
          `the benchmark would have run against whatever port was hard-coded into the generated script, ` +
          `not this candidate's actual container (port ${hostPort}). Failing loudly instead of silently ` +
          `benchmarking nothing. Check the load-script generation prompt/template for how it builds its base URL.`,
      );
    }
    console.log(
      `[Arena ${strategy.id}] retargetScriptPort: rewrote ${replacements} localhost URL(s) → port ${hostPort}`,
    );

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
      // Uses the settle/retry wrapper (not getRouteTelemetry directly):
      // this call runs immediately after the load test finishes, and
      // spans emitted right up to the end of the run may not have
      // cleared OTel's BatchSpanProcessor + collector ingest + SigNoz
      // indexing yet. Querying too early here would report a spurious
      // requestCount=0 for a candidate that genuinely handled traffic.
      // widenWindowEnd() inside the wrapper also guards against
      // runResult.windowStart/windowEnd ever collapsing to a zero-width
      // window, which SigNoz's API rejects outright (400: "start time
      // must be before end time").
      telemetry = await getRouteTelemetryWithRetry(
        serviceName,
        opts.method,
        opts.routePath,
        runResult.windowStart,
        runResult.windowEnd,
      );
      telemetry.dashboardUrl = await getOrCreateRouteDashboardUrl(
        serviceName,
        opts.method,
        opts.routePath,
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

// FIXED: previously `if (cpu === null && mem === null) return null;` — this
// only fell back to `docker stats` when BOTH SigNoz metrics were missing.
// If your SigNoz instance isn't scraping one of container.cpu.utilization /
// container.memory.usage.total (a very common setup gap — those come from
// a host/container metrics receiver, not from the trace exporter), one
// query could come back null while the other spuriously resolves, and the
// `??` below would silently bake in a wrong "0" for the missing one
// instead of falling through to the accurate docker-stats fallback. Now
// EITHER metric being null triggers the fallback for the whole reading.
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
  if (cpu === null || mem === null) return null;
  return {
    cpuPercent: Math.round(cpu * 10000) / 100,
    memoryMB: Math.round((mem / 1024 / 1024) * 100) / 100,
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
      "stats",
      "--no-stream",
      "--format",
      "{{json .}}",
      containerName,
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
          memoryMB =
            m[2] === "GiB" ? val * 1024 : m[2] === "KiB" ? val / 1024 : val;
        }
        resolve({ cpuPercent, memoryMB: Math.round(memoryMB * 100) / 100 });
      } catch {
        resolve(null);
      }
    });
    child.on("error", () => resolve(null));
  });
}

// FIXED (immediate-sample): same fast-benchmark issue as
// startLiveMetricsPolling above — previously used a bare
// setInterval(..., 2500ms), so a benchmark that finished inside 2.5s
// never got a single telemetry emit and the arena UI's SigNoz panel sat
// on "Waiting for spans…" for the entire run even once spans were
// actually being exported. Fires once immediately, then on the normal
// interval.
//
// FIXED (zero-width window): the immediate `void tick()` call fires in
// the same synchronous tick as the `windowStart = Date.now()` capture at
// the call site below — millisecond-resolution clocks make it common for
// `windowStart` and the `Date.now()` used as `end` inside tick() to be
// bit-identical. SigNoz's API hard-rejects start === end with a 400
// ("start time must be before end time"), which is exactly what showed
// up in the logs for every arena candidate's first poll. widenWindowEnd()
// guarantees the window is always at least MIN_TELEMETRY_WINDOW_MS wide.
function startLiveTelemetryPolling(
  arenaId: string,
  strategyId: string,
  serviceName: string,
  method: string,
  routePath: string,
  windowStart: number,
): () => void {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const t = await getRouteTelemetry(
        serviceName,
        method,
        routePath,
        windowStart,
        widenWindowEnd(windowStart, Date.now()),
      );
      t.dashboardUrl = await getOrCreateRouteDashboardUrl(
        serviceName,
        method,
        routePath,
      );
      if (!stopped) {
        emitArena(arenaId, "arena:candidate:telemetry", {
          strategyId,
          telemetry: t,
        });
      }
    } catch {
      // keep last good value, retry next tick
    }
  };

  void tick(); // sample immediately instead of waiting a full interval
  const timer = setInterval(tick, TELEMETRY_POLL_INTERVAL_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
