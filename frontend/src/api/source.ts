// Thin fetch wrapper for the /repos/:id/source endpoint. Kept separate from
// api/repos.ts since this is queried lazily, per-panel, rather than as part
// of the main repo-detail load.

export interface SourceSnippet {
  file: string;
  startLine: number;
  endLine: number;
  targetLine: number;
  content: string;
}

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:5000";

export async function getSourceSnippet(
  repositoryId: string,
  file: string,
  line: number,
): Promise<SourceSnippet> {
  const params = new URLSearchParams({ file, line: String(line) });
  const res = await fetch(
    `${API_BASE}/repos/${repositoryId}/source?${params.toString()}`,
    { credentials: "include" },
  );

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load source snippet");
  }

  return res.json();
}
