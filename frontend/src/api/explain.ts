export interface ExplainResult {
  explanation: string;
}

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:5000";

export async function getExplanation(
  repositoryId: string,
  file: string,
  line: number,
): Promise<ExplainResult> {
  const params = new URLSearchParams({ file, line: String(line) });
  const res = await fetch(
    `${API_BASE}/repos/${repositoryId}/explain?${params.toString()}`,
    { credentials: "include" },
  );

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to generate explanation");
  }

  return res.json();
}
