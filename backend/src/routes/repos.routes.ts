import { Router } from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { requireAuth, type AuthedRequest } from "../middleware/require-auth.js";
import { listUserRepos, getRepo } from "../github/github.service.js";
import { cloneRepo } from "../github/clone.service.js";
import { detectFramework } from "../parsing/framework-detect.js";
import { parseRoutes } from "../parsing/route-parser.js";
import { RepositoryModel } from "../models/repository.model.js";
import { generateInstrumentation } from "../instrumental/Instrumentation.service.js";
import { detectRequiredEnvVars } from "../parsing/env-detect.js";
import { encryptEnvValue, decryptEnvValue } from "../utils/env-crypto.js";
import { startDockerRun } from "../docker/docker-run.service.js";
import { RunModel } from "../models/run.model.js";
import { detectAppPort } from "../parsing/detect-port.js";
import { resolveConnectedFiles } from "../parsing/connectedFiles.service.js";
import { explainEndpoint } from "../services/explain.service.js";

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

// POST /repos/:id/instrument — generate OTel instrumentation files for SigNoz
router.post("/:id/instrument", requireAuth, async (req: AuthedRequest, res) => {
  const repository = await RepositoryModel.findOne({
    _id: req.params.id,
    userId: req.user!.githubId,
  });

  if (!repository) {
    return res.status(404).json({ error: "Repository not found" });
  }

  try {
    const result = generateInstrumentation(repository.githubFullName);

    // Track that instrumentation has been generated for this repo so the
    // frontend can show "Instrumented" on revisit without regenerating.
    repository.instrumentationGeneratedAt = new Date();
    await repository.save();

    res.json(result);
  } catch (err) {
    console.error("Failed to generate instrumentation:", err);
    res.status(500).json({ error: "Failed to generate instrumentation" });
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

  const runId = await startDockerRun({
    repositoryId: repository._id.toString(),
    userId: req.user!.githubId,
    localPath: repository.localPath,
    envVars: decrypted,
    appPort: repository.appPort,
  });

  res.status(202).json({ runId, status: "starting", port: repository.appPort });
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

export default router;
