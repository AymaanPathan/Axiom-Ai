import {
  getRouteTelemetry,
  runRawTraceQuerySafe,
  extractRawRows,
  SERVICE_ATTRIBUTE,
  ROUTE_ATTRIBUTE,
  SEMCONV,
  DURATION_ATTRIBUTE,
  nanoToMs,
  type RouteTelemetry,
} from "./signoz.service.js";
import { TtlCache } from "./signozCache.service.js";

export interface EndpointMetricResult {
  method: string;
  routePath: string;
  requestCount: number;
  errorCount: number;
  avgLatencyMs: number;
  p95Ms: number;
}

export interface TraceSummaryResult {
  traceId: string;
  method: string;
  routePath: string;
  durationMs: number;
  status: "ok" | "error";
  timestamp: number;
}

export interface ErrorEventResult {
  id: string;
  message: string;
  routePath?: string;
  method?: string;
  stack?: string;
  timestamp: number;
}

// --- caching --------------------------------------------------------------
//
// SigNoz calls are all funneled through signoz.service.ts's internal
// enqueueSignozCall queue, which already serializes every fetch to the
// SigNoz API (that's the real fix for the "parallel query execution
// failed" bug — github.com/SigNoz/signoz/issues/11509). This cache sits on
// top of that: it stops repeat panel mounts / tight poll loops from
// joining that queue at all for data that's still fresh. Endpoint metrics
// move slower than traces/errors, so it gets a longer TTL.
const endpointMetricsCache = new TtlCache<EndpointMetricResult[]>(10_000);
const tracesCache = new TtlCache<{
  traces: TraceSummaryResult[];
  warnings: string[];
}>(5_000);
const errorsCache = new TtlCache<{
  errors: ErrorEventResult[];
  warnings: string[];
}>(5_000);

/** Call after a fix is applied / container is restarted for a repo, so the
 * next dashboard read isn't served stale pre-fix numbers out of cache. */
export function invalidateObservabilityCache(serviceName: string): void {
  endpointMetricsCache.invalidatePrefix(`${serviceName}:`);
  tracesCache.invalidatePrefix(`${serviceName}:`);
  errorsCache.invalidatePrefix(`${serviceName}:`);
}

// --- concurrency ------------------------------------------------------------

// Runs `fn` over `items` with at most `limit` in flight at once. Belt-and-
// suspenders alongside signoz.service.ts's own enqueueSignozCall queue:
// that queue guarantees the actual fetch() calls never overlap regardless
// of what happens here, but capping how many getRouteTelemetry() calls are
// *outstanding* at once still bounds memory/log noise for repos with a lot
// of routes.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index]) };
      } catch (reason) {
        console.error(
          `[Observability] mapWithConcurrency: item ${index} FAILED:`,
          reason instanceof Error ? reason.message : reason,
        );
        results[index] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );

  const failedCount = results.filter((r) => r.status === "rejected").length;
  if (failedCount > 0) {
    console.warn(
      `[Observability] mapWithConcurrency: ${failedCount}/${items.length} item(s) failed`,
    );
  }

  return results;
}

const SIGNOZ_QUERY_CONCURRENCY = 4;

// One retry on a transient failure before giving up on a single route's
// telemetry — SigNoz's query_range path has a documented history of
// intermittent 5xxs under its own internal parallelism bugs (see
// github.com/SigNoz/signoz/issues/11509), so a lone route failing on its
// first attempt shouldn't drop it from the dashboard if a second attempt
// 300ms later would have succeeded.
async function withOneRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    await new Promise((r) => setTimeout(r, 300));
    return fn();
  }
}

export async function getEndpointMetrics(
  serviceName: string,
  routes: { method: string; routePath: string }[],
  windowMinutes = 15,
): Promise<EndpointMetricResult[]> {
  const cacheKey = `${serviceName}:endpoints:${windowMinutes}:${routes
    .map((r) => `${r.method} ${r.routePath}`)
    .join(",")}`;

  return endpointMetricsCache.getOrFetch(cacheKey, async () => {
    const end = Date.now();
    const start = end - windowMinutes * 60 * 1000;

    const results = await mapWithConcurrency(
      routes,
      SIGNOZ_QUERY_CONCURRENCY,
      (r) =>
        withOneRetry(() =>
          getRouteTelemetry(serviceName, r.method, r.routePath, start, end),
        ),
    );

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<RouteTelemetry> =>
        r.status === "fulfilled",
    );

    if (fulfilled.length < routes.length) {
      console.warn(
        `[Observability] getEndpointMetrics(${serviceName}): only ${fulfilled.length}/${routes.length} route(s) returned telemetry`,
      );
    }

    return fulfilled
      .map((r) => r.value)
      .map((t) => ({
        method: t.method,
        routePath: t.routePath,
        requestCount: t.requestCount,
        errorCount: t.errorCount,
        avgLatencyMs: t.latencyMs.avg,
        p95Ms: t.latencyMs.p95,
      }));
  });
}

// De-duplicate by traceID/spanID pair — SigNoz's query_range path has a
// confirmed, still-open bug where the same span can be returned more than
// once for a given filter (github.com/SigNoz/signoz/issues/10449). The
// trace-detail UI works around this with SELECT DISTINCT ON (span_id); we
// do the client-side equivalent since we go through query_range directly.
function dedupeRows(
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    const spanId = String(row["spanID"] ?? "");
    const traceId = String(row["traceID"] ?? "");
    const key = spanId ? `${traceId}:${spanId}` : JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

const METHOD_FIELD = SEMCONV.method; // "httpMethod" — same constant getRouteTelemetry filters on

export async function getRecentTraces(
  serviceName: string,
  windowMinutes = 15,
  limit = 20,
): Promise<{ traces: TraceSummaryResult[]; warnings: string[] }> {
  const cacheKey = `${serviceName}:traces:${windowMinutes}:${limit}`;

  return tracesCache.getOrFetch(cacheKey, async () => {
    const end = Date.now();
    const start = end - windowMinutes * 60 * 1000;
    const warnings: string[] = [];
    const escapedService = serviceName.replace(/'/g, "\\'");

    const raw = await runRawTraceQuerySafe(
      start,
      end,
      `${SERVICE_ATTRIBUTE} = '${escapedService}' AND ${ROUTE_ATTRIBUTE} EXISTS`,
      [
        "traceID",
        "spanID",
        METHOD_FIELD,
        ROUTE_ATTRIBUTE,
        DURATION_ATTRIBUTE,
        "hasError",
        "timestamp",
      ],
      limit,
      "recent traces (raw list)",
      warnings,
    );

    if (raw === null) {
      console.error(
        `[Observability] getRecentTraces(${serviceName}): raw query failed, returning empty result. warnings:`,
        warnings,
      );
      return { traces: [], warnings };
    }

    const rows = dedupeRows(extractRawRows(raw));
    if (rows.length === 0) {
      const msg =
        "recent traces: query succeeded but returned zero rows — check the service name and that traffic exists in this window";
      warnings.push(msg);
    }

    const traces: TraceSummaryResult[] = rows.map((row) => ({
      traceId: String(row["traceID"] ?? ""),
      method: String(row[METHOD_FIELD] ?? ""),
      routePath: String(row[ROUTE_ATTRIBUTE] ?? ""),
      durationMs: nanoToMs(Number(row[DURATION_ATTRIBUTE] ?? 0)),
      status: row["hasError"] === true ? "error" : "ok",
      timestamp: Number(row["timestamp"] ?? Date.now()),
    }));

    return { traces, warnings };
  });
}

export async function getRecentErrors(
  serviceName: string,
  windowMinutes = 15,
  limit = 20,
): Promise<{ errors: ErrorEventResult[]; warnings: string[] }> {
  const cacheKey = `${serviceName}:errors:${windowMinutes}:${limit}`;

  return errorsCache.getOrFetch(cacheKey, async () => {
    const end = Date.now();
    const start = end - windowMinutes * 60 * 1000;
    const warnings: string[] = [];
    const escapedService = serviceName.replace(/'/g, "\\'");

    const raw = await runRawTraceQuerySafe(
      start,
      end,
      `${SERVICE_ATTRIBUTE} = '${escapedService}' AND hasError = true`,
      [
        "traceID",
        "spanID",
        METHOD_FIELD,
        ROUTE_ATTRIBUTE,
        "timestamp",
        "statusMessage",
        "exception.message",
        "exception.stacktrace",
      ],
      limit,
      "recent errors (raw list)",
      warnings,
    );

    if (raw === null) {
      console.error(
        `[Observability] getRecentErrors(${serviceName}): raw query failed, returning empty result. warnings:`,
        warnings,
      );
      return { errors: [], warnings };
    }

    const rows = dedupeRows(extractRawRows(raw));
    if (rows.length === 0) {
      const msg =
        "recent errors: query succeeded but returned zero rows — check the service name and that errors exist in this window";
      warnings.push(msg);
    }

    const errors: ErrorEventResult[] = rows.map((row) => ({
      id: String(row["spanID"] ?? row["traceID"] ?? Math.random()),
      message: String(
        row["exception.message"] ?? row["statusMessage"] ?? "Unknown error",
      ),
      routePath: row[ROUTE_ATTRIBUTE]
        ? String(row[ROUTE_ATTRIBUTE])
        : undefined,
      method: row[METHOD_FIELD] ? String(row[METHOD_FIELD]) : undefined,
      stack: row["exception.stacktrace"]
        ? String(row["exception.stacktrace"])
        : undefined,
      timestamp: Number(row["timestamp"] ?? Date.now()),
    }));

    return { errors, warnings };
  });
}
