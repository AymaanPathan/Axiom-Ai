import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getIO } from "../config/socket.js";
import { RunModel } from "../models/run.model.js";
import {
  startMetricsLoop,
  stopMetricsLoop,
} from "../services/metrics-observer.service.js";

const CONTAINER_MEMORY = "512m";
const CONTAINER_CPUS = "1";
const READINESS_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 500;
const READY_LOG_PATTERN = /(listening|running|started|ready)\b/i;

const RUNNER_IMAGE = "axiom-runner:latest";
const OTEL_RUNNER_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../otel-runner",
);

const SIGNOZ_DOCKER_NETWORK =
  process.env.SIGNOZ_DOCKER_NETWORK || "signoz-network";

const SIGNOZ_OTLP_ENDPOINT =
  process.env.SIGNOZ_OTLP_ENDPOINT || "http://ingester:4318/v1/traces";

interface StartRunOptions {
  repositoryId: string;
  userId: string;
  localPath: string;
  envVars: Record<string, string>;
  appPort: number;
  serviceName: string;
  healthCheckPath?: string;
}

// Tracks runs this server process actually spawned, so /stop can signal
// the right child process and container without re-deriving state from
// the DB. Cleared automatically when the container exits on its own.
interface ActiveRun {
  child: ChildProcessWithoutNullStreams;
  containerName: string;
  repositoryId: string;
  manualStop: boolean;
}
const activeRuns = new Map<string, ActiveRun>();

export async function startDockerRun({
  repositoryId,
  userId,
  localPath,
  envVars,
  appPort,
  serviceName,
  healthCheckPath,
}: StartRunOptions): Promise<string> {
  const run = await RunModel.create({
    repositoryId,
    userId,
    status: "starting",
    port: appPort,
  });
  const runId = run._id.toString();
  const containerName = `axiom-run-${runId}`;

  void executeRun({
    runId,
    repositoryId,
    containerName,
    localPath,
    envVars,
    appPort,
    serviceName,
    healthCheckPath,
  }).catch(async (err) => {
    console.error(`Run ${runId} failed:`, err);
    await RunModel.findByIdAndUpdate(runId, {
      status: "error",
      errorMessage: err instanceof Error ? err.message : "Unknown error",
      finishedAt: new Date(),
    });
    getIO().to(`run:${runId}`).emit("run:status", { runId, status: "error" });
    getIO()
      .to(`repo:${repositoryId}`)
      .emit("run:status", { runId, status: "error" });
  });

  return runId;
}

// Manually stop (and, since containers run with --rm, delete) a run's
// container. Only works for runs this server process spawned — if the
// server restarted since the run started, activeRuns won't have it, and
// the caller gets `false` back so the route can report a clear error
// instead of hanging.
export async function stopDockerRun(runId: string): Promise<boolean> {
  const entry = activeRuns.get(runId);
  if (!entry) return false;

  entry.manualStop = true;
  await new Promise<void>((resolve) => {
    const kill = spawn("docker", ["kill", entry.containerName]);
    kill.on("close", () => resolve());
    kill.on("error", () => resolve()); // container may already be gone
  });
  return true;
}

async function pollHealthCheck(
  url: string,
  deadline: number,
): Promise<boolean> {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  return false;
}

async function executeRun({
  runId,
  repositoryId,
  containerName,
  localPath,
  envVars,
  appPort,
  serviceName,
  healthCheckPath,
}: {
  runId: string;
  repositoryId: string;
  containerName: string;
  localPath: string;
  envVars: Record<string, string>;
  appPort: number;
  serviceName: string;
  healthCheckPath?: string;
}) {
  const io = getIO();
  const tmpDir = path.join(os.tmpdir(), "axiom-runs", runId);
  const envFilePath = path.join(os.tmpdir(), "axiom-runs", `${runId}.env`);

  const emitBoth = (event: string, payload: object) => {
    io.to(`run:${runId}`).emit(event, payload);
    io.to(`repo:${repositoryId}`).emit(event, payload);
  };

  const emitServiceLog = (stream: "stdout" | "stderr", chunk: string) => {
    io.to(`repo:${repositoryId}`).emit("service:log", {
      repositoryId,
      stream,
      chunk,
      timestamp: Date.now(),
    });
  };

  await fs.mkdir(path.dirname(tmpDir), { recursive: true });
  await fs.cp(localPath, tmpDir, { recursive: true });

  const fullEnv: Record<string, string> = {
    ...envVars,
    OTEL_SERVICE_NAME: serviceName,
    OTEL_EXPORTER_OTLP_ENDPOINT: SIGNOZ_OTLP_ENDPOINT,
    OTEL_LOG_LEVEL: "debug", // TEMP — remove once export path is confirmed working
  };

  const envFileContents = Object.entries(fullEnv)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  await fs.writeFile(envFilePath, envFileContents, { mode: 0o600 });

  await RunModel.findByIdAndUpdate(runId, { status: "installing" });
  emitBoth("run:status", { runId, status: "installing" });

  const dockerArgs = [
    "run",
    "--rm",
    "--name",
    containerName,
    "--memory",
    CONTAINER_MEMORY,
    "--cpus",
    CONTAINER_CPUS,
    "--pids-limit",
    "256",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--network",
    SIGNOZ_DOCKER_NETWORK,
    "-p",
    `${appPort}:${appPort}`,
    "--env-file",
    envFilePath,
    "-v",
    `${tmpDir}:/app`,
    "-w",
    "/app",
    RUNNER_IMAGE,
    "sh",
    "-c",
    "npm install && (npm run build --if-present || true) && NODE_OPTIONS='--require /otel/tracing.js' npm start",
  ];

  const child = spawn("docker", dockerArgs);

  activeRuns.set(runId, {
    child,
    containerName,
    repositoryId,
    manualStop: false,
  });

  let readyEmitted = false;
  const markReady = async () => {
    if (readyEmitted) return;
    readyEmitted = true;
    await RunModel.findByIdAndUpdate(runId, { status: "running" });
    emitBoth("run:status", { runId, status: "running" });
    startMetricsLoop(repositoryId, containerName, serviceName);
  };

  // If a real healthcheck path is given, readiness is decided ENTIRELY by
  // whether that HTTP call actually succeeds — no blind fallback. A
  // failed/timed-out healthcheck now reports "error" instead of silently
  // being reported as "running" by the timer below, which was previously
  // masking real startup failures (crash loops, stuck `npm install`, port
  // never actually bound) as healthy.
  let healthCheckFailed = false;
  if (healthCheckPath) {
    void pollHealthCheck(
      `http://localhost:${appPort}${healthCheckPath}`,
      Date.now() + READINESS_TIMEOUT_MS,
    ).then(async (ok) => {
      if (ok) {
        markReady();
      } else {
        healthCheckFailed = true;
        if (!readyEmitted) {
          await RunModel.findByIdAndUpdate(runId, {
            status: "error",
            errorMessage: `Healthcheck at ${healthCheckPath} did not succeed within ${READINESS_TIMEOUT_MS}ms`,
          });
          emitBoth("run:status", { runId, status: "error" });
        }
      }
    });
  }

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();

    emitBoth("run:log", {
      runId,
      stream: "stdout",
      chunk: text,
    });

    emitServiceLog("stdout", text);

    if (!healthCheckPath && READY_LOG_PATTERN.test(text)) {
      markReady();
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();

    emitBoth("run:log", {
      runId,
      stream: "stderr",
      chunk: text,
    });

    emitServiceLog("stderr", text);
  });

  // Fallback timer ONLY applies when there's no real healthcheck to trust
  // (i.e. we're relying on the stdout regex match instead). When a real
  // healthCheckPath was given, its own resolution above is authoritative —
  // this timer must not override a pending/failed healthcheck with a fake
  // "running" status.
  setTimeout(() => {
    if (!readyEmitted && !healthCheckPath) markReady();
  }, READINESS_TIMEOUT_MS);

  child.on("close", async (exitCode) => {
    const wasManualStop = activeRuns.get(runId)?.manualStop ?? false;
    activeRuns.delete(runId);
    stopMetricsLoop(repositoryId);

    // A manual stop always reports "exited" (expected), not "error" —
    // even though `docker kill` produces a non-zero exit code.
    const status = wasManualStop
      ? "exited"
      : exitCode === 0
        ? "exited"
        : "error";

    await RunModel.findByIdAndUpdate(runId, {
      status,
      exitCode,
      finishedAt: new Date(),
    });
    emitBoth("run:status", { runId, status, exitCode });
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(envFilePath, { force: true }).catch(() => {});
  });
}

export function buildRunnerImage(): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log("📦 Building axiom-runner image (OpenTelemetry bootstrap)...");
    const build = spawn("docker", [
      "build",
      "-t",
      RUNNER_IMAGE,
      OTEL_RUNNER_DIR,
    ]);
    build.stdout.on("data", (d) => process.stdout.write(d));
    build.stderr.on("data", (d) => process.stderr.write(d));
    build.on("close", (code) => {
      if (code === 0) {
        console.log("✅ axiom-runner image ready");
        resolve();
      } else {
        reject(new Error(`docker build exited with code ${code}`));
      }
    });
  });
}
