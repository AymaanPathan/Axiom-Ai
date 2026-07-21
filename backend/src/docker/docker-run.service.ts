import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getIO } from "../config/socket.js";
import { RunModel } from "../models/run.model.js";
import { startMetricsLoop, stopMetricsLoop } from "../services/metrics-observer.service.js";

const MAX_RUN_DURATION_MS = 30 * 60 * 1000;
const CONTAINER_MEMORY = "512m";
const CONTAINER_CPUS = "1";
const READINESS_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 500;
const READY_LOG_PATTERN = /(listening|running|started|ready)\b/i;

// Custom image = node:20-alpine + OTel packages pre-installed under /otel,
// kept separate from the cloned repo's own node_modules so we never touch
// or collide with the user's dependency tree.
const RUNNER_IMAGE = "axiom-runner:latest";
const OTEL_RUNNER_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../otel-runner",
);

// Where the SigNoz OTel collector is reachable from *inside* a run
// container. host-gateway works cross-platform on Docker 20.10+ when the
// collector is running on the same host as this server (e.g. via the
// SigNoz docker-compose stack bound to localhost:4318).
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
  serviceName: string; // used as OTEL_SERVICE_NAME — must match what
  // signoz-observability.service.ts queries by
  healthCheckPath?: string;
}

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

  // Merge the user's own env vars with the OTel bootstrap vars. NODE_OPTIONS
  // gets inherited by whatever `node` process npm's start script spawns,
  // regardless of the app's own entrypoint or bundler.
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
    SIGNOZ_DOCKER_NETWORK, // <-- replaces the --add-host line
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

  const killTimer = setTimeout(() => {
    spawn("docker", ["kill", containerName]);
  }, MAX_RUN_DURATION_MS);

  let readyEmitted = false;
  const markReady = async () => {
    if (readyEmitted) return;
    readyEmitted = true;
    await RunModel.findByIdAndUpdate(runId, { status: "running" });
    emitBoth("run:status", { runId, status: "running" });
    startMetricsLoop(repositoryId, containerName, serviceName);
  };

  if (healthCheckPath) {
    void pollHealthCheck(
      `http://localhost:${appPort}${healthCheckPath}`,
      Date.now() + READINESS_TIMEOUT_MS,
    ).then((ok) => {
      if (ok) markReady();
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

  setTimeout(() => {
    if (!readyEmitted) markReady();
  }, READINESS_TIMEOUT_MS);

  child.on("close", async (exitCode) => {
    clearTimeout(killTimer);
    stopMetricsLoop(repositoryId); 
    await RunModel.findByIdAndUpdate(runId, {
      status: exitCode === 0 ? "exited" : "error",
      exitCode,
      finishedAt: new Date(),
    });
    emitBoth("run:status", {
      runId,
      status: exitCode === 0 ? "exited" : "error",
      exitCode,
    });
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(envFilePath, { force: true }).catch(() => {});
  });
}

// Builds the axiom-runner image (node:20-alpine + OTel bootstrap) once at
// server boot, so runs don't pay the OTel-install cost inline. Replaces
// the old pullBaseImage().
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
