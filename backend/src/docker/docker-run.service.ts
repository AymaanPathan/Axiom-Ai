import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getIO } from "../config/socket.js";
import { RunModel } from "../models/run.model.js";

const MAX_RUN_DURATION_MS = 5 * 60 * 1000; // 5 min hard cap
const CONTAINER_MEMORY = "512m";
const CONTAINER_CPUS = "1";

// How long to wait for the app to signal it's ready before giving up and
// flipping to "running" anyway (better a false-positive than a stuck UI).
const READINESS_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 500;

// Fallback for apps with no discovered /health route — matches the common
// "listening on ...", "server started", "running on ..." startup log lines.
const READY_LOG_PATTERN = /(listening|running|started|ready)\b/i;

interface StartRunOptions {
  repositoryId: string;
  userId: string;
  localPath: string;
  envVars: Record<string, string>;
  appPort: number;
  healthCheckPath?: string; // e.g. "/health", if discovered in the repo's routes
}

export async function startDockerRun({
  repositoryId,
  userId,
  localPath,
  envVars,
  appPort,
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

  // Fire-and-forget — the route handler responds immediately with runId.
  void executeRun({
    runId,
    containerName,
    localPath,
    envVars,
    appPort,
    healthCheckPath,
  }).catch(async (err) => {
    console.error(`Run ${runId} failed:`, err);
    await RunModel.findByIdAndUpdate(runId, {
      status: "error",
      errorMessage: err instanceof Error ? err.message : "Unknown error",
      finishedAt: new Date(),
    });
    getIO().to(`run:${runId}`).emit("run:status", { runId, status: "error" });
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
      // Any response at all — even a 404 or 500 — means something is bound
      // to the port and answering HTTP. That's "ready" for our purposes;
      // app-level errors are the user's problem to see in the logs, not
      // ours to gate readiness on.
      if (res) return true;
    } catch {
      // Not up yet, or port not bound — keep polling.
    }
    await new Promise((resolve) =>
      setTimeout(resolve, HEALTH_POLL_INTERVAL_MS),
    );
  }
  return false;
}

async function executeRun({
  runId,
  containerName,
  localPath,
  envVars,
  appPort,
  healthCheckPath,
}: {
  runId: string;
  containerName: string;
  localPath: string;
  envVars: Record<string, string>;
  appPort: number;
  healthCheckPath?: string;
}) {
  const io = getIO();
  const tmpDir = path.join(os.tmpdir(), "axiom-runs", runId);
  const envFilePath = path.join(os.tmpdir(), "axiom-runs", `${runId}.env`);

  await fs.mkdir(path.dirname(tmpDir), { recursive: true });
  await fs.cp(localPath, tmpDir, { recursive: true });

  const envFileContents = Object.entries(envVars)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  await fs.writeFile(envFilePath, envFileContents, { mode: 0o600 });

  await RunModel.findByIdAndUpdate(runId, { status: "installing" });
  io.to(`run:${runId}`).emit("run:status", { runId, status: "installing" });

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
    "-p",
    `${appPort}:${appPort}`,
    "--env-file",
    envFilePath,
    "-v",
    `${tmpDir}:/app`,
    "-w",
    "/app",
    "node:20-alpine",
    "sh",
    "-c",
    "npm install && (npm run build --if-present || true) && npm start",
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
    io.to(`run:${runId}`).emit("run:status", { runId, status: "running" });
  };

  // Readiness path A: poll the discovered health endpoint if we have one —
  // this is the strongest signal since it confirms the port is actually
  // bound and answering, not just that a log line looked promising.
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
    io.to(`run:${runId}`).emit("run:log", {
      runId,
      stream: "stdout",
      chunk: text,
    });

    // Readiness path B: no health route discovered — fall back to log
    // pattern matching. Skipped entirely if we're already polling /health.
    if (!healthCheckPath && READY_LOG_PATTERN.test(text)) {
      markReady();
    }
  });

  child.stderr.on("data", (chunk) => {
    io.to(`run:${runId}`).emit("run:log", {
      runId,
      stream: "stderr",
      chunk: chunk.toString(),
    });
  });

  // Fallback: if nothing confirmed readiness within the timeout, flip to
  // "running" anyway rather than leaving the UI stuck on "installing"
  // forever — an unusual startup log shouldn't block the whole flow.
  setTimeout(() => {
    if (!readyEmitted) markReady();
  }, READINESS_TIMEOUT_MS);

  child.on("close", async (exitCode) => {
    clearTimeout(killTimer);
    await RunModel.findByIdAndUpdate(runId, {
      status: exitCode === 0 ? "exited" : "error",
      exitCode,
      finishedAt: new Date(),
    });
    io.to(`run:${runId}`).emit("run:status", {
      runId,
      status: exitCode === 0 ? "exited" : "error",
      exitCode,
    });

    // Cleanup — never leave decrypted secrets or run copies on disk.
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(envFilePath, { force: true }).catch(() => {});
  });
}

// Pulls the base image once at server boot so the first real run doesn't
// pay the pull-time cost inline.
export function pullBaseImage(): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log("📦 Pulling node:20-alpine base image...");
    const pull = spawn("docker", ["pull", "node:20-alpine"]);
    pull.on("close", (code) => {
      if (code === 0) {
        console.log("✅ Base image ready");
        resolve();
      } else {
        reject(new Error(`docker pull exited with code ${code}`));
      }
    });
  });
}
  