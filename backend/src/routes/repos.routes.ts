import { Router } from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { requireAuth, type AuthedRequest } from "../middleware/require-auth.js";
import { listUserRepos, getRepo } from "../github/github.service.js";
import { cloneRepo } from "../github/clone.service.js";
import { detectFramework } from "../parsing/framework-detect.js";
import { parseRoutes } from "../parsing/route-parser.js";
import { RepositoryModel } from "../models/repository.model.js";
import { detectRequiredEnvVars } from "../parsing/env-detect.js";
import { encryptEnvValue, decryptEnvValue } from "../utils/env-crypto.js";
import { startDockerRun, stopDockerRun } from "../docker/docker-run.service.js";
import { RunModel } from "../models/run.model.js";
import { detectAppPort } from "../parsing/detect-port.js";
import { resolveConnectedFiles } from "../parsing/connectedFiles.service.js";
import { explainEndpoint } from "../services/explain.service.js";
import { generateTrafficForRoute } from "../services/trafficGenerator.service.js";
import { getRouteTelemetry } from "../services/signoz.service.js";
import {
  getServiceHealth,
  getSystemStatus,
  getMetricHistory,
} from "../services/metrics-observer.service.js";
import {
  getEndpointMetrics,
  getRecentTraces,
  getRecentErrors,
} from "../services/signoz-observability.service.js";

const router = Router();

// How many lines of context to include above/below the target line when
// returning a source snippet — keeps the payload small for the UI panel.
const SOURCE_SNIPPET_CONTEXT_LINES = 15;

// GET /repos — list the logged-in user's GitHub repos
router.get("/", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const repos = await listUserRepos(req.user!.githubAccessToken);
    res.json({ repos });
  } catch (err) {
    console.error("Failed to list repos:", err);
    res.status(500).json({ error: "Failed to fetch GitHub repositories" });
  }
});

// POST /repos/:owner/:repo/connect — clone, detect framework, parse routes, persist
router.post(
  "/:owner/:repo/connect",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const { owner, repo } = req.params;
    const accessToken = req.user!.githubAccessToken;

    try {
      const repoInfo = await getRepo(accessToken, owner, repo);
      const { localPath } = await cloneRepo(
        repoInfo.cloneUrl,
        accessToken,
        owner,
        repo,
      );

      const framework = await detectFramework(localPath);
      if (framework !== "express") {
        return res.status(422).json({
          error: `Unsupported framework. Axiom currently supports Express only (detected: ${framework}).`,
        });
      }

      const discoveredRoutes = await parseRoutes(localPath);

      const requiredEnvVars = await detectRequiredEnvVars(localPath);
      const appPort = await detectAppPort(localPath);

      const repository = await RepositoryModel.create({
        userId: req.user!.githubId,
        githubFullName: repoInfo.fullName,
        defaultBranch: repoInfo.defaultBranch,
        localPath,
        discoveredRoutes,
        framework,
        requiredEnvVars,
        appPort,
      });

      res.status(201).json({
        repositoryId: repository._id,
        githubFullName: repository.githubFullName,
        framework: repository.framework,
        routes: discoveredRoutes,
        requiredEnvVars,
      });
    } catch (err) {
      console.error("Failed to connect repo:", err);
      res.status(500).json({ error: "Failed to connect and parse repository" });
    }
  },
);

// GET /repos/:id/routes — fetch previously discovered routes for a connected repo
router.get("/:id/routes", requireAuth, async (req: AuthedRequest, res) => {
  const repository = await RepositoryModel.findOne({
    _id: req.params.id,
    userId: req.user!.githubId,
  });

  if (!repository) {
    return res.status(404).json({ error: "Repository not found" });
  }

  res.json({
    githubFullName: repository.githubFullName,
    framework: repository.framework,
    routes: repository.discoveredRoutes,
  });
});

// GET /repos/:id/source — return a snippet of real source around a route's
// file:line so the frontend can show the actual handler instead of a stub.
// `file` must be one of the repo's own discovered route files — this is
// the guard against path traversal / reading arbitrary paths on disk.
router.get("/:id/source", requireAuth, async (req: AuthedRequest, res) => {
  const { file, line } = req.query as { file?: string; line?: string };

  if (!file) {
    return res.status(400).json({ error: "file query param is required" });
  }

  const repository = await RepositoryModel.findOne({
    _id: req.params.id,
    userId: req.user!.githubId,
  });
  if (!repository)
    return res.status(404).json({ error: "Repository not found" });

  const knownFiles = new Set(repository.discoveredRoutes.map((r) => r.file));
  if (!knownFiles.has(file)) {
    return res.status(400).json({ error: "Unknown file for this repository" });
  }

  // Resolve against the repo's own local checkout and re-verify the result
  // still lives inside it — belt-and-suspenders against `../` tricks.
  const absolutePath = path.resolve(repository.localPath, file);
  const repoRoot = path.resolve(repository.localPath);
  if (!absolutePath.startsWith(repoRoot + path.sep)) {
    return res.status(400).json({ error: "Invalid file path" });
  }

  try {
    const contents = await fs.readFile(absolutePath, "utf8");
    const allLines = contents.split("\n");

    const targetLine = Math.max(1, Number(line) || 1);
    const startLine = Math.max(1, targetLine - SOURCE_SNIPPET_CONTEXT_LINES);
    const endLine = Math.min(
      allLines.length,
      targetLine + SOURCE_SNIPPET_CONTEXT_LINES,
    );

    const snippet = allLines.slice(startLine - 1, endLine).join("\n");

    res.json({
      file,
      startLine,
      endLine,
      targetLine,
      content: snippet,
    });
  } catch (err) {
    console.error("Failed to read source file:", err);
    res.status(500).json({ error: "Failed to read source file" });
  }
});

// GET /repos/:id/connected-files — walk from the route's registration line
// into its controller (and one hop further, e.g. a service/model) via the
// file's own relative imports, and pull out any req.body field usage found
// in the controller. Best-effort/regex-based, not a full TS type checker —
// it won't catch every pattern, but it's real code from the real repo, not
// a stub.
router.get(
  "/:id/connected-files",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const { file, line } = req.query as { file?: string; line?: string };

    if (!file) {
      return res.status(400).json({ error: "file query param is required" });
    }

    const repository = await RepositoryModel.findOne({
      _id: req.params.id,
      userId: req.user!.githubId,
    });
    if (!repository)
      return res.status(404).json({ error: "Repository not found" });

    const knownFiles = new Set(repository.discoveredRoutes.map((r) => r.file));
    if (!knownFiles.has(file)) {
      return res
        .status(400)
        .json({ error: "Unknown file for this repository" });
    }

    const repoRoot = path.resolve(repository.localPath);
    const absoluteEntry = path.resolve(repoRoot, file);
    if (!absoluteEntry.startsWith(repoRoot + path.sep)) {
      return res.status(400).json({ error: "Invalid file path" });
    }

    try {
      const result = await resolveConnectedFiles(
        repoRoot,
        file,
        Math.max(1, Number(line) || 1),
      );
      res.json(result);
    } catch (err) {
      console.error("Failed to resolve connected files:", err);
      res.status(500).json({ error: "Failed to resolve connected files" });
    }
  },
);

// GET /repos/:id/explain — plain-language explanation of what this
// endpoint does, generated by Groq's free API from the same route ->
// controller -> service context used by /connected-files. Cached per
// repo+file+line on the server so repeat views don't re-hit the API.
router.get("/:id/explain", requireAuth, async (req: AuthedRequest, res) => {
  const { file, line } = req.query as { file?: string; line?: string };

  if (!file) {
    return res.status(400).json({ error: "file query param is required" });
  }

  const repository = await RepositoryModel.findOne({
    _id: req.params.id,
    userId: req.user!.githubId,
  });
  if (!repository)
    return res.status(404).json({ error: "Repository not found" });

  const knownFiles = new Set(repository.discoveredRoutes.map((r) => r.file));
  if (!knownFiles.has(file)) {
    return res.status(400).json({ error: "Unknown file for this repository" });
  }

  const repoRoot = path.resolve(repository.localPath);
  const absoluteEntry = path.resolve(repoRoot, file);
  if (!absoluteEntry.startsWith(repoRoot + path.sep)) {
    return res.status(400).json({ error: "Invalid file path" });
  }

  try {
    const explanation = await explainEndpoint(
      repoRoot,
      repository._id.toString(),
      file,
      Math.max(1, Number(line) || 1),
    );
    res.json({ explanation });
  } catch (err) {
    console.error("Failed to generate AI explanation:", err);
    const message =
      err instanceof Error ? err.message : "Failed to generate explanation";
    res.status(502).json({ error: message });
  }
});

// POST /repos/:id/traffic — generate real traffic against one route on the
// running container, so SigNoz has actual spans for it. Waits for the burst
// to finish and returns the exact time window it ran in, so the caller can
// hand that window straight to /telemetry.
router.post("/:id/traffic", requireAuth, async (req: AuthedRequest, res) => {
  const { routeIndex, requestCount } = req.body as {
    routeIndex?: number;
    requestCount?: number;
  };

  if (routeIndex === undefined) {
    return res.status(400).json({ error: "routeIndex is required" });
  }

  const repository = await RepositoryModel.findOne({
    _id: req.params.id,
    userId: req.user!.githubId,
  });
  if (!repository)
    return res.status(404).json({ error: "Repository not found" });

  const route = repository.discoveredRoutes[routeIndex];
  if (!route) return res.status(400).json({ error: "Unknown routeIndex" });

  try {
    const result = await generateTrafficForRoute({
      repositoryId: repository._id.toString(),
      appPort: repository.appPort,
      method: route.method,
      routePath: route.routePath,
      repoRoot: path.resolve(repository.localPath),
      routeFile: route.file,
      routeLine: route.line,
      requestCount: requestCount ?? 30,
    });
    res.json(result);
  } catch (err) {
    console.error("Failed to generate traffic:", err);
    res.status(500).json({ error: "Failed to generate traffic" });
  }
});

// GET /repos/:id/telemetry — pull real numbers from SigNoz for one route
// over a given window (typically the window returned by /traffic above).
router.get("/:id/telemetry", requireAuth, async (req: AuthedRequest, res) => {
  const { routeIndex, start, end, service } = req.query as {
    routeIndex?: string;
    start?: string;
    end?: string;
    service?: string;
  };

  if (routeIndex === undefined || !start || !end) {
    return res
      .status(400)
      .json({ error: "routeIndex, start, and end query params are required" });
  }

  const repository = await RepositoryModel.findOne({
    _id: req.params.id,
    userId: req.user!.githubId,
  });
  if (!repository)
    return res.status(404).json({ error: "Repository not found" });

  const route = repository.discoveredRoutes[Number(routeIndex)];
  if (!route) return res.status(400).json({ error: "Unknown routeIndex" });

  // Best-guess service name if the caller doesn't override it — check the
  // Services list in your SigNoz instance to confirm this matches what
  // your instrumentation actually reports (OTEL_SERVICE_NAME, etc.).
  const serviceName = service || repository.githubFullName.split("/")[1];

  try {
    const telemetry = await getRouteTelemetry(
      serviceName,
      route.method,
      route.routePath,
      Number(start),
      Number(end),
    );
    res.json(telemetry);
  } catch (err) {
    console.error("Failed to fetch SigNoz telemetry:", err);
    const message =
      err instanceof Error ? err.message : "Failed to fetch telemetry";
    res.status(502).json({ error: message });
  }
});

// GET /repos/:id/env — which vars are required vs already provided
router.get("/:id/env", requireAuth, async (req: AuthedRequest, res) => {
  const repository = await RepositoryModel.findOne({
    _id: req.params.id,
    userId: req.user!.githubId,
  });
  if (!repository)
    return res.status(404).json({ error: "Repository not found" });

  const providedKeys = repository.envVars.map((e) => e.key);
  const missing = repository.requiredEnvVars.filter(
    (k) => !providedKeys.includes(k),
  );

  res.json({
    requiredEnvVars: repository.requiredEnvVars,
    providedKeys,
    missing,
  });
});

// POST /repos/:id/env — submit values for missing (or updated) vars
router.post("/:id/env", requireAuth, async (req: AuthedRequest, res) => {
  const { envVars } = req.body as { envVars: Record<string, string> };
  if (!envVars || typeof envVars !== "object") {
    return res.status(400).json({ error: "envVars object is required" });
  }

  const repository = await RepositoryModel.findOne({
    _id: req.params.id,
    userId: req.user!.githubId,
  });
  if (!repository)
    return res.status(404).json({ error: "Repository not found" });

  for (const [key, value] of Object.entries(envVars)) {
    if (!value) continue;
    const encrypted = encryptEnvValue(value);
    const existingIndex = repository.envVars.findIndex((e) => e.key === key);
    if (existingIndex >= 0) {
      repository.envVars[existingIndex] = { key, ...encrypted };
    } else {
      repository.envVars.push({ key, ...encrypted });
    }
  }

  await repository.save();

  const providedKeys = repository.envVars.map((e) => e.key);
  const missing = repository.requiredEnvVars.filter(
    (k) => !providedKeys.includes(k),
  );
  res.json({ providedKeys, missing });
});

// POST /repos/:id/run — start a sandboxed run once all env vars are set
router.post("/:id/run", requireAuth, async (req: AuthedRequest, res) => {
  const repository = await RepositoryModel.findOne({
    _id: req.params.id,
    userId: req.user!.githubId,
  });
  if (!repository)
    return res.status(404).json({ error: "Repository not found" });

  const providedKeys = repository.envVars.map((e) => e.key);
  const missing = repository.requiredEnvVars.filter(
    (k) => !providedKeys.includes(k),
  );
  if (missing.length > 0) {
    return res
      .status(400)
      .json({ error: "Missing required env vars", missing });
  }

  const decrypted: Record<string, string> = {};
  for (const entry of repository.envVars) {
    decrypted[entry.key] = decryptEnvValue(entry);
  }

  const serviceName = repository.githubFullName.split("/")[1];

  const runId = await startDockerRun({
    repositoryId: repository._id.toString(),
    userId: req.user!.githubId,
    localPath: repository.localPath,
    envVars: decrypted,
    appPort: repository.appPort,
    serviceName,
  });

  res.status(202).json({ runId, status: "starting", port: repository.appPort });
});

// POST /repos/:id/stop — stop (and delete, since runs use --rm) the
// repository's currently active container.
router.post("/:id/stop", requireAuth, async (req: AuthedRequest, res) => {
  const repository = await RepositoryModel.findOne({
    _id: req.params.id,
    userId: req.user!.githubId,
  });
  if (!repository)
    return res.status(404).json({ error: "Repository not found" });

  const activeRun = await RunModel.findOne({
    repositoryId: req.params.id,
    status: { $in: ["starting", "installing", "running"] },
  }).sort({ createdAt: -1 });

  if (!activeRun) {
    return res.status(404).json({ error: "No active run for this repository" });
  }

  const stopped = await stopDockerRun(activeRun._id.toString());
  if (!stopped) {
    return res.status(409).json({
      error: "Run is not tracked by this server instance (may have restarted). Restart the run to stop it cleanly.",
    });
  }

  res.json({ success: true, runId: activeRun._id.toString() });
});

// GET /repos/:id/runs/:runId — polling fallback / initial state before socket connects
router.get("/:id/runs/:runId", requireAuth, async (req: AuthedRequest, res) => {
  const run = await RunModel.findOne({
    _id: req.params.runId,
    repositoryId: req.params.id,
  });
  if (!run) return res.status(404).json({ error: "Run not found" });
  res.json(run);
});

router.get(
  "/:id/observability/endpoints",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const repository = await RepositoryModel.findOne({
      _id: req.params.id,
      userId: req.user!.githubId,
    });
    if (!repository)
      return res.status(404).json({ error: "Repository not found" });

    const serviceName = repository.githubFullName.split("/")[1];

    try {
      const endpoints = await getEndpointMetrics(
        serviceName,
        repository.discoveredRoutes,
      );
      res.json({ endpoints });
    } catch (err) {
      console.error("Failed to fetch endpoint metrics:", err);
      res.status(502).json({ error: "Failed to fetch endpoint metrics" });
    }
  },
);

// GET /repos/:id/observability/traces
router.get(
  "/:id/observability/traces",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const repository = await RepositoryModel.findOne({
      _id: req.params.id,
      userId: req.user!.githubId,
    });
    if (!repository)
      return res.status(404).json({ error: "Repository not found" });

    const serviceName = repository.githubFullName.split("/")[1];
    const limit = Number(req.query.limit) || 20;

    try {
      const { traces, warnings } = await getRecentTraces(
        serviceName,
        15,
        limit,
      );
      if (warnings.length) console.warn("[observability/traces]", warnings);
      res.json({ traces });
    } catch (err) {
      console.error("Failed to fetch recent traces:", err);
      res.status(502).json({ error: "Failed to fetch recent traces" });
    }
  },
);

// GET /repos/:id/observability/errors
router.get(
  "/:id/observability/errors",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const repository = await RepositoryModel.findOne({
      _id: req.params.id,
      userId: req.user!.githubId,
    });
    if (!repository)
      return res.status(404).json({ error: "Repository not found" });

    const serviceName = repository.githubFullName.split("/")[1];
    const limit = Number(req.query.limit) || 20;

    try {
      const { errors, warnings } = await getRecentErrors(
        serviceName,
        15,
        limit,
      );
      if (warnings.length) console.warn("[observability/errors]", warnings);
      res.json({ errors });
    } catch (err) {
      console.error("Failed to fetch recent errors:", err);
      res.status(502).json({ error: "Failed to fetch recent errors" });
    }
  },
);

router.get(
  "/:id/observability/health",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const repository = await RepositoryModel.findOne({
      _id: req.params.id,
      userId: req.user!.githubId,
    });
    if (!repository)
      return res.status(404).json({ error: "Repository not found" });

    const health = await getServiceHealth(repository._id.toString());
    res.json(health);
  },
);

router.get(
  "/:id/observability/system",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const repository = await RepositoryModel.findOne({
      _id: req.params.id,
      userId: req.user!.githubId,
    }); 
    if (!repository)
      return res.status(404).json({ error: "Repository not found" });

    const system = await getSystemStatus(repository._id.toString());
    res.json(system);
  },
);

router.get(
  "/:id/observability/metrics/history",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const repository = await RepositoryModel.findOne({
      _id: req.params.id,
      userId: req.user!.githubId,
    });
    if (!repository)
      return res.status(404).json({ error: "Repository not found" });

    const points = getMetricHistory(repository._id.toString());
    res.json({ points });
  },
);

export default router;
