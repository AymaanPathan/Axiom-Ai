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

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:5000";

export async function getConnectedFiles(
  repositoryId: string,
  file: string,
  line: number,
): Promise<ConnectedFilesResult> {
  const params = new URLSearchParams({ file, line: String(line) });
  const res = await fetch(
    `${API_BASE}/repos/${repositoryId}/connected-files?${params.toString()}`,
    { credentials: "include" },
  );

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load connected files");
  }

  return res.json();
}
