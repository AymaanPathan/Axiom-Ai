import { Router } from "express";
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

const router = Router();

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
  if (!repository) return res.status(404).json({ error: "Repository not found" });

  const providedKeys = repository.envVars.map((e) => e.key);
  const missing = repository.requiredEnvVars.filter((k) => !providedKeys.includes(k));

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
  if (!repository) return res.status(404).json({ error: "Repository not found" });

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
  const missing = repository.requiredEnvVars.filter((k) => !providedKeys.includes(k));
  res.json({ providedKeys, missing });
});

// POST /repos/:id/run — start a sandboxed run once all env vars are set
router.post("/:id/run", requireAuth, async (req: AuthedRequest, res) => {
  const repository = await RepositoryModel.findOne({
    _id: req.params.id,
    userId: req.user!.githubId,
  });
  if (!repository) return res.status(404).json({ error: "Repository not found" });

  const providedKeys = repository.envVars.map((e) => e.key);
  const missing = repository.requiredEnvVars.filter((k) => !providedKeys.includes(k));
  if (missing.length > 0) {
    return res.status(400).json({ error: "Missing required env vars", missing });
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
  const run = await RunModel.findOne({ _id: req.params.runId, repositoryId: req.params.id });
  if (!run) return res.status(404).json({ error: "Run not found" });
  res.json(run);
});

export default router;
