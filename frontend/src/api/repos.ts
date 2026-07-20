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
}

export interface EnvStatus {
  requiredEnvVars: string[];
  providedKeys: string[];
  missing: string[];
}

export interface RunState {
  runId: string;
  status: "starting" | "installing" | "running" | "exited" | "error";
  exitCode?: number;
  port?: number;
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
  const { data } = await apiClient.get<{
    githubFullName: string;
    framework: string;
    routes: DiscoveredRoute[];
  }>(`/repos/${repositoryId}/routes`);
  return { repositoryId, ...data };
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
    { envVars }
  );
  return res.data;
}

export async function startRun(repositoryId: string): Promise<RunState> {
  const res = await apiClient.post<RunState>(`/repos/${repositoryId}/run`);
  return res.data;
}