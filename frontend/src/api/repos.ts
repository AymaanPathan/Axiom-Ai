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