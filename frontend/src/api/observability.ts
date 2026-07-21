// src/api/observability.ts
//
// ASSUMPTION: all of this sits behind your existing SigNoz query service
// layer, scoped by repositoryId. Endpoint paths below are placeholders —
// rename to whatever you actually exposed under routes/repos.routes.ts.
// Trace waterfalls are NOT reimplemented here on purpose: SigNoz already
// has a full trace explorer, so "Open in SigNoz" deep-links out to it and
// this page only shows a flat recent-traces list for triage.

import { apiClient } from "./client";

export interface MetricSnapshot {
  timestamp: number;
  cpuPercent: number;
  memoryMB: number;
  requestRate: number; // req/s
  errorRate: number; // 0..1
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface EndpointMetric {
  method: string;
  routePath: string;
  requestCount: number;
  errorCount: number;
  avgLatencyMs: number;
  p95Ms: number;
}

export interface ServiceHealth {
  status: "healthy" | "degraded" | "down" | "unknown";
  uptimeSeconds: number;
  lastSeenAt: string;
}

export interface SystemStatus {
  mongo: "connected" | "disconnected";
  redis: "connected" | "disconnected";
  container: {
    status: "running" | "stopped" | "restarting" | "unknown";
    image: string;
    port: number | null;
    startedAt: string | null;
  };
}

export interface TraceSummary {
  traceId: string;
  method: string;
  routePath: string;
  durationMs: number;
  status: "ok" | "error";
  timestamp: number;
}

export interface ErrorEvent {
  id: string;
  message: string;
  routePath?: string;
  method?: string;
  stack?: string;
  timestamp: number;
}

/** GET /repos/:id/observability/health */
export async function getServiceHealth(repositoryId: string): Promise<ServiceHealth> {
  const { data } = await apiClient.get<ServiceHealth>(
    `/repos/${repositoryId}/observability/health`,
  );
  return data;
}

/** GET /repos/:id/observability/system — Mongo/Redis/container status */
export async function getSystemStatus(repositoryId: string): Promise<SystemStatus> {
  const { data } = await apiClient.get<SystemStatus>(
    `/repos/${repositoryId}/observability/system`,
  );
  return data;
}

/** GET /repos/:id/observability/metrics/history?window=15m — backfill for charts */
export async function getMetricHistory(
  repositoryId: string,
  windowMinutes = 15,
): Promise<MetricSnapshot[]> {
  const { data } = await apiClient.get<{ points: MetricSnapshot[] }>(
    `/repos/${repositoryId}/observability/metrics/history`,
    { params: { window: `${windowMinutes}m` } },
  );
  return data.points;
}

/** GET /repos/:id/observability/endpoints — per-route breakdown */
export async function getEndpointMetrics(repositoryId: string): Promise<EndpointMetric[]> {
  const { data } = await apiClient.get<{ endpoints: EndpointMetric[] }>(
    `/repos/${repositoryId}/observability/endpoints`,
  );
  return data.endpoints;
}

/** GET /repos/:id/observability/traces?limit=20 */
export async function getRecentTraces(
  repositoryId: string,
  limit = 20,
): Promise<TraceSummary[]> {
  const { data } = await apiClient.get<{ traces: TraceSummary[] }>(
    `/repos/${repositoryId}/observability/traces`,
    { params: { limit } },
  );
  return data.traces;
}

/** GET /repos/:id/observability/errors?limit=20 */
export async function getRecentErrors(
  repositoryId: string,
  limit = 20,
): Promise<ErrorEvent[]> {
  const { data } = await apiClient.get<{ errors: ErrorEvent[] }>(
    `/repos/${repositoryId}/observability/errors`,
    { params: { limit } },
  );
  return data.errors;
}

/** Deep link out to the real SigNoz UI for a given trace/service. */
export function signozTraceUrl(traceId: string): string {
  const base = import.meta.env.VITE_SIGNOZ_URL || "http://localhost:3301";
  return `${base}/trace/${traceId}`;
}

export function signozServiceUrl(serviceName: string): string {
  const base = import.meta.env.VITE_SIGNOZ_URL || "http://localhost:3301";
  return `${base}/services/${encodeURIComponent(serviceName)}`;
}