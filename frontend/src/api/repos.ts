import { apiClient } from "./client";

export interface GithubRepo {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string;
}

export interface DiscoveredRoute {
  method: string;
  routePath: string;
  file: string;
  line: number;
}

export interface ConnectedRepository {
  repositoryId: string;
  githubFullName: string;
  framework: string;
  routes: DiscoveredRoute[];
  requiredEnvVars: string[];
}

export interface EnvStatus {
  requiredEnvVars: string[];
  providedKeys: string[];
  missing: string[];
}

export interface ConnectedFile {
  path: string;
  role: "route" | "controller" | "service" | "other";
  content: string;
  startLine: number;
  endLine: number;
  highlightLine?: number;
}

export interface ConnectedFilesResult {
  files: ConnectedFile[];
  requestBodyFields: string[];
}

export interface RunState {
  errorMessage: string | undefined;
  runId: string;
  status: "starting" | "installing" | "running" | "exited" | "error";
  exitCode?: number;
  port?: number;
}

export interface TrafficResult {
  method: string;
  routePath: string;
  requestsSent: number;
  successCount: number;
  errorCount: number;
  windowStart: number;
  windowEnd: number;
}

export interface RouteTelemetry {
  service: string;
  method: string;
  routePath: string;
  window: { start: number; end: number };
  requestCount: number;
  errorCount: number;
  errorRatePercent: number;
  latencyMs: { p50: number; p95: number; p99: number; avg: number };
  db: { avgDurationMs: number | null; callCount: number };
  external: { avgDurationMs: number | null; callCount: number };
  warnings: string[];
}

export interface LoadScriptResult {
  requestsSent: number;
  successCount: number;
  errorCount: number;
  windowStart: number;
  windowEnd: number;
  avgDurationMs: number;
  p95DurationMs: number | null;
  p99DurationMs: number | null;
  requestsPerSecond: number | null;
  errorRate: number;
  thresholdsPassed: boolean | null;
  scriptErrorCount: number;
}

export interface PerformanceReport {
  rootCause: string;
  severity: "critical" | "warning" | "info";
  evidence: string[];
  suggestedFix: {
    title: string;
    description: string;
    estimatedImprovementPercent: { min: number; max: number };
  };
  diff: {
    filePath: string;
    originalCode: string;
    newCode: string;
    unifiedDiff: string;
  } | null;
  confidence: "high" | "medium" | "low";
  computed: {
    requestsSent: number;
    dbSpansPerRequest: number | null;
    dbTimeSharePercent: number | null;
    dbCallsOverlap: boolean;
    dbCumulativeTimeMs: number | null;
    externalSpansPerRequest: number | null;
    externalTimeSharePercent: number | null;
    externalCallsOverlap: boolean;
    p95Ms: number | null;
    avgMs: number;
    errorRatePercent: number;
  };
  dbBreakdown: DbOperationBreakdown[];
}

export interface ApplyFixResult {
  applied: boolean;
  filePath?: string;
  runResult?: LoadScriptResult;
  telemetry?: RouteTelemetry | null;
  error?: string;
}

export interface DbOperationBreakdown {
  operation: string;
  callCount: number;
  avgDurationMs: number;
  totalDurationMs: number;
}

export interface OptimizationStrategy {
  id: string;
  title: string;
  approach: string;
  description: string;
  estimatedImprovementPercent: { min: number; max: number };
  diff: {
    filePath: string;
    originalCode: string;
    newCode: string;
    unifiedDiff: string;
  };
  confidence: "high" | "medium" | "low";
}

export interface StrategyGenerationResult {
  rootCause: string;
  severity: "critical" | "warning" | "info";
  strategies: OptimizationStrategy[];
}

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
}

export interface ArenaResult {
  arenaId: string;
  candidates: ArenaCandidateResult[];
  winnerStrategyId: string | null;
}

// api/repos.ts — ADD these types + function, and you can delete the old
// `runOptimizationArena` (the blocking one) since ArenaLive replaces it.

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

export interface ArenaCandidateStatusEvent {
  arenaId: string;
  strategyId: string;
  stage: ArenaStage;
  message?: string;
  error?: string;
  runId?: string;
}

export interface ArenaMetricSampleEvent {
  arenaId: string;
  strategyId: string;
  cpuPercent: number;
  memoryMB: number;
  timestamp: number;
}

export interface ArenaTelemetryEvent {
  arenaId: string;
  strategyId: string;
  telemetry: RouteTelemetry;
}

export interface ArenaCandidateLogEvent {
  arenaId: string;
  strategyId: string;
  index: number;
  status: number;
  ok: boolean;
  method: string | null;
  url: string | null;
  durationMs: number | null;
  responseBodySummary: string | null;
  timestamp: number;
}

export async function generateStrategies(
  repositoryId: string,
  routeIndex: number,
  runResult: LoadScriptResult,
  telemetry: RouteTelemetry | null,
): Promise<StrategyGenerationResult> {
  const { data } = await apiClient.post<StrategyGenerationResult>(
    `/repos/${repositoryId}/generate-strategies`,
    { routeIndex, runResult, telemetry },
  );
  return data;
}

/** GET /repos — list the signed-in user's GitHub repositories */
export async function listRepos(): Promise<GithubRepo[]> {
  const { data } = await apiClient.get<{ repos: GithubRepo[] }>("/repos");
  return data.repos;
}

/** POST /repos/:owner/:repo/connect — clone, detect framework, parse routes */
export async function connectRepo(
  owner: string,
  repo: string,
): Promise<ConnectedRepository> {
  const { data } = await apiClient.post<ConnectedRepository>(
    `/repos/${owner}/${repo}/connect`,
  );
  return data;
}

/** GET /repos/:id/routes — previously discovered routes for a connected repo */
export async function getRepoDetail(
  repositoryId: string,
): Promise<ConnectedRepository> {
  const [{ data }, { data: env }] = await Promise.all([
    apiClient.get<{
      githubFullName: string;
      framework: string;
      routes: DiscoveredRoute[];
    }>(`/repos/${repositoryId}/routes`),
    apiClient.get<{ requiredEnvVars: string[] }>(`/repos/${repositoryId}/env`),
  ]);
  return { repositoryId, requiredEnvVars: env.requiredEnvVars, ...data };
}

export async function getRun(
  repositoryId: string,
  runId: string,
): Promise<RunState> {
  const { data } = await apiClient.get<RunState>(
    `/repos/${repositoryId}/runs/${runId}`,
  );
  return data;
}

export async function getEnvStatus(repositoryId: string): Promise<EnvStatus> {
  const res = await apiClient.get<EnvStatus>(`/repos/${repositoryId}/env`);
  return res.data;
}

export async function submitEnvVars(
  repositoryId: string,
  envVars: Record<string, string>,
): Promise<Pick<EnvStatus, "providedKeys" | "missing">> {
  const res = await apiClient.post<Pick<EnvStatus, "providedKeys" | "missing">>(
    `/repos/${repositoryId}/env`,
    { envVars },
  );
  return res.data;
}

export async function startRun(repositoryId: string): Promise<RunState> {
  const res = await apiClient.post<RunState>(`/repos/${repositoryId}/run`);
  return res.data;
}

export async function stopRun(
  repositoryId: string,
): Promise<{ success: boolean; runId: string }> {
  const { data } = await apiClient.post<{ success: boolean; runId: string }>(
    `/repos/${repositoryId}/stop`,
  );
  return data;
}

/** POST /repos/:id/traffic — generate real traffic against one route */
export async function generateTraffic(
  repositoryId: string,
  routeIndex: number,
  requestCount = 30,
): Promise<TrafficResult> {
  const { data } = await apiClient.post<TrafficResult>(
    `/repos/${repositoryId}/traffic`,
    { routeIndex, requestCount },
  );
  return data;
}

/** GET /repos/:id/telemetry — pull SigNoz numbers for a route over a window */
export async function getTelemetry(
  repositoryId: string,
  routeIndex: number,
  start: number,
  end: number,
  service?: string,
): Promise<RouteTelemetry> {
  const { data } = await apiClient.get<RouteTelemetry>(
    `/repos/${repositoryId}/telemetry`,
    { params: { routeIndex, start, end, ...(service ? { service } : {}) } },
  );
  return data;
}

export async function getExplanation(
  repositoryId: string,
  file: string,
  line: number,
): Promise<string> {
  const { data } = await apiClient.get<{ explanation: string }>(
    `/repos/${repositoryId}/explain`,
    { params: { file, line } },
  );
  return data.explanation;
}

export async function getConnectedFiles(
  repositoryId: string,
  file: string,
  line: number,
): Promise<ConnectedFilesResult> {
  const { data } = await apiClient.get<ConnectedFilesResult>(
    `/repos/${repositoryId}/connected-files`,
    { params: { file, line } },
  );
  return data;
}

export async function generateLoadScript(
  repositoryId: string,
  routeIndex: number,
  description: string,
): Promise<{ script: string; authRequired: boolean }> {
  const { data } = await apiClient.post<{
    script: string;
    authRequired: boolean;
  }>(`/repos/${repositoryId}/generate-load-script`, {
    routeIndex,
    description,
  });
  return data;
}

export async function runLoadScript(
  repositoryId: string,
  script: string,
  authToken?: string,
): Promise<LoadScriptResult> {
  const { data } = await apiClient.post<LoadScriptResult>(
    `/repos/${repositoryId}/run-load-script`,
    { script, authToken },
  );
  return data;
}

export async function analyzePerformance(
  repositoryId: string,
  routeIndex: number,
  runResult: LoadScriptResult,
  telemetry: RouteTelemetry | null,
): Promise<PerformanceReport> {
  const { data } = await apiClient.post<PerformanceReport>(
    `/repos/${repositoryId}/analyze-performance`,
    { routeIndex, runResult, telemetry },
  );
  return data;
}

export async function applyFixAndRetest(
  repositoryId: string,
  routeIndex: number,
  filePath: string,
  originalCode: string,
  newCode: string,
  script: string,
  authToken?: string,
): Promise<ApplyFixResult> {
  const { data } = await apiClient.post<ApplyFixResult>(
    `/repos/${repositoryId}/apply-fix-and-retest`,
    { routeIndex, filePath, originalCode, newCode, script, authToken },
  );
  return data;
}

export async function initArena(
  repositoryId: string,
  routeIndex: number,
): Promise<{ arenaId: string }> {
  const { data } = await apiClient.post<{ arenaId: string }>(
    `/repos/${repositoryId}/init-arena`,
    { routeIndex },
  );
  return data;
}

export async function runArenaCandidate(
  repositoryId: string,
  arenaId: string,
  strategy: OptimizationStrategy,
  script: string,
  authToken?: string,
): Promise<ArenaCandidateResult> {
  const { data } = await apiClient.post<{ result: ArenaCandidateResult }>(
    `/repos/${repositoryId}/run-arena-candidate`,
    { arenaId, strategy, script, authToken },
  );
  return data.result;
}

export async function finalizeArena(
  repositoryId: string,
  arenaId: string,
): Promise<ArenaResult> {
  const { data } = await apiClient.post<ArenaResult>(
    `/repos/${repositoryId}/finalize-arena`,
    { arenaId },
  );
  return data;
}