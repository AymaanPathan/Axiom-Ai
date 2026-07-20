import { apiClient, API_BASE_URL } from "./client";

export interface GithubUser {
  githubId: string;
  username: string;
  avatarUrl: string;
}

interface MeResponse {
  authenticated: boolean;
  user?: GithubUser;
}

/**
 * Full-page redirect target for "Connect GitHub". This is a real navigation
 * (not an XHR) since it kicks off the GitHub OAuth authorize flow, which
 * eventually redirects back to FRONTEND_URL with the session cookie set.
 */
export function getGithubConnectUrl(): string {
  return `${API_BASE_URL}/auth/github`;
}

export async function fetchCurrentUser(): Promise<MeResponse> {
  try {
    const { data } = await apiClient.get<MeResponse>("/auth/me");
    return data;
  } catch {
    // /auth/me returns 401 when there's no valid session — treat as signed out.
    return { authenticated: false };
  }
}

export async function logout(): Promise<void> {
  await apiClient.post("/auth/logout");
}
