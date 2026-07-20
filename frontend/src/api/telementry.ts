export interface RouteTelemetry {
  service: string;
  method: string;
  routePath: string;
  window: { start: number; end: number };
  requestCount: number;
  errorCount: number;
  errorRatePercent: number;
  latencyMs: { p50: number; p95: number; p99: number };
  db: { avgDurationMs: number | null; callCount: number };
  external: { avgDurationMs: number | null; callCount: number };
}

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:5000";

export async function getTelemetry(
  repositoryId: string,
  routeIndex: number,
  start: number,
  end: number,
): Promise<RouteTelemetry> {
  const params = new URLSearchParams({
    routeIndex: String(routeIndex),
    start: String(start),
    end: String(end),
  });
  const res = await fetch(
    `${API_BASE}/repos/${repositoryId}/telemetry?${params.toString()}`,
    { credentials: "include" },
  );

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to fetch telemetry");
  }

  return res.json();
}
