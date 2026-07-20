export interface TrafficResult {
  method: string;
  routePath: string;
  requestsSent: number;
  successCount: number;
  errorCount: number;
  windowStart: number;
  windowEnd: number;
}

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:5000";

export async function generateTraffic(
  repositoryId: string,
  routeIndex: number,
  requestCount = 30,
): Promise<TrafficResult> {
  const res = await fetch(`${API_BASE}/repos/${repositoryId}/traffic`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ routeIndex, requestCount }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to generate traffic");
  }

  return res.json();
}
