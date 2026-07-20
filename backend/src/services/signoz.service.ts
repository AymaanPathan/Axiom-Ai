/**
 * signoz.client.ts
 * -----------------
 * Talks to a real SigNoz instance's Traces API (POST /api/v5/query_range)
 * and normalizes the result into one clean telemetry object per route.
 *
 * Reference: https://signoz.io/docs/apm-and-distributed-tracing/traces-api/
 *            https://signoz.io/docs/traces-management/trace-api/payload-model/
 *            https://signoz.io/docs/traces-management/trace-api/aggregate-traces/
 *
 * Two things in here are environment-specific and you WILL likely need to
 * tune them against your own SigNoz instance — see the ASSUMPTIONS block
 * below. I can't verify these against your live SigNoz/OTel setup from
 * here, so they're built to be obvious to adjust rather than hidden.
 *
 * ============================ ASSUMPTIONS ============================
 * 1. Span duration column: `durationNano` — this one IS confirmed, it's
 *    used directly in SigNoz's own documented ClickHouse sample query
 *    (`avg(durationNano)`), so p50/p95/p99/avg all aggregate on it.
 *
 * 2. HTTP semantic-convention attribute names — OTel renamed these in the
 *    1.21 stable HTTP semconv. Auto-instrumented Node/Express apps on an
 *    older SDK version will emit `http.method` / `http.status_code`;
 *    newer ones emit `http.request.method` / `http.response.status_code`.
 *    Toggle via SIGNOZ_SEMCONV=legacy in your .env if numbers come back
 *    empty — check a trace's span attributes in SigNoz's UI to confirm
 *    which your instrumentation actually uses.
 *
 * 3. DB / external call timings are NOT trace-correlated to a specific
 *    route here — they're scoped by SERVICE + TIME WINDOW instead. A DB
 *    span doesn't carry `http.route`, so isolating "DB calls caused by
 *    /checkout" properly needs trace-matching (SigNoz's `->` descendant
 *    operator). Rather than guess at that query shape, this client relies
 *    on the traffic generator hitting ONE route at a time in a tight
 *    window — so "DB spans for this service during this window" is a
 *    correct proxy for "DB spans caused by this route," as long as
 *    nothing else was hitting the service at the same time.
 * =======================================================================
 */

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
  warnings: string[];
}

const SEMCONV =
  process.env.SIGNOZ_SEMCONV === "legacy"
    ? { method: "http.method", statusCode: "http.status_code" }
    : {
        method: "http.request.method",
        statusCode: "http.response.status_code",
      };

const ROUTE_ATTRIBUTE = "http.route"; // stable across semconv versions
const SERVICE_ATTRIBUTE = "service.name";
const DURATION_ATTRIBUTE = "durationNano";

interface Aggregation {
  expression: string;
  alias: string;
}

function getConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.SIGNOZ_API_URL;
  const apiKey = process.env.SIGNOZ_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error(
      "SIGNOZ_API_URL and SIGNOZ_API_KEY must be set in the backend .env. " +
        "Get an API key from SigNoz under Settings -> Service Accounts.",
    );
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

const DEBUG = process.env.SIGNOZ_DEBUG !== "false"; // on by default while wiring this up

function debugLog(...args: unknown[]): void {
  if (DEBUG) console.log("[SigNoz]", ...args);
}

async function runScalarTraceQuery(
  start: number,
  end: number,
  filterExpression: string,
  aggregations: Aggregation[],
): Promise<unknown> {
  const { baseUrl, apiKey } = getConfig();

  const body = {
    start,
    end,
    requestType: "scalar",
    compositeQuery: {
      queries: [
        {
          type: "builder_query",
          spec: {
            name: "A",
            signal: "traces",
            aggregations,
            filter: { expression: filterExpression },
            disabled: false,
          },
        },
      ],
    },
  };

  debugLog(
    "-->",
    `window ${new Date(start).toISOString()} .. ${new Date(end).toISOString()}`,
    `(${end - start}ms span)`,
  );
  debugLog("--> filter:", filterExpression);
  debugLog("--> aggregations:", JSON.stringify(aggregations));

  const res = await fetch(`${baseUrl}/api/v5/query_range`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "SIGNOZ-API-KEY": apiKey,
    },
    body: JSON.stringify(body),
  });

  const rawText = await res.text();

  if (!res.ok) {
    debugLog("<-- ERROR", res.status, rawText.slice(0, 500));
    throw new Error(
      `SigNoz API error (${res.status}): ${rawText.slice(0, 300)}`,
    );
  }

  debugLog("<-- 200 OK, raw body:", rawText.slice(0, 1000));

  return JSON.parse(rawText);
}

// SigNoz throws an internal error (`failed to get tbl statement`) when a
// filter references an attribute its query planner has never seen ingested
// — e.g. `db.system EXISTS` when no DB client spans have ever been
// recorded for this service. That's a real "no data for this yet" signal,
// not a transient failure, so each query is isolated and degrades to a
// null/zero result with a warning instead of taking the whole response
// down with it.
async function runScalarTraceQuerySafe(
  start: number,
  end: number,
  filterExpression: string,
  aggregations: Aggregation[],
  label: string,
  warnings: string[],
): Promise<unknown> {
  debugLog(`=== [${label}] running ===`);
  try {
    const result = await runScalarTraceQuery(
      start,
      end,
      filterExpression,
      aggregations,
    );
    debugLog(`=== [${label}] succeeded ===`);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    debugLog(`=== [${label}] FAILED:`, message, "===");
    warnings.push(`${label}: ${message}`);
    return null;
  }
}
// SigNoz's documented examples only show request payload shapes, not
// response bodies, so the exact response shape for `requestType: "scalar"` isn't
// nailed down here. Rather than hard-code a shape that might not match
// your instance's version, this walks the response tree looking for a key
// matching the aggregation's alias — works regardless of whether it comes
// back as a flat row, a table, or a single-point series.
function findAliasValue(node: unknown, alias: string): number | null {
  if (node === null || node === undefined) return null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findAliasValue(item, alias);
      if (found !== null) return found;
    }
    return null;
  }

  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      if (
        key.toLowerCase() === alias.toLowerCase() &&
        (typeof value === "number" || typeof value === "string")
      ) {
        const num = Number(value);
        if (!Number.isNaN(num)) return num;
      }
    }
    for (const value of Object.values(obj)) {
      const found = findAliasValue(value, alias);
      if (found !== null) return found;
    }
  }

  return null;
}

function nanoToMs(nano: number | null): number {
  if (nano === null) return 0;
  return Math.round((nano / 1_000_000) * 100) / 100;
}

function buildRouteFilter(
  service: string,
  method: string,
  routePath: string,
): string {
  const escapedService = service.replace(/'/g, "\\'");
  const escapedRoute = routePath.replace(/'/g, "\\'");
  return `${SERVICE_ATTRIBUTE} = '${escapedService}' AND ${SEMCONV.method} = '${method}' AND ${ROUTE_ATTRIBUTE} = '${escapedRoute}'`;
}

/**
 * Pulls latency percentiles + error rate for one route, and DB/external
 * call timings for the service over the same window (see assumption #3
 * above on why those aren't route-scoped).
 */
export async function getRouteTelemetry(
  service: string,
  method: string,
  routePath: string,
  start: number,
  end: number,
): Promise<RouteTelemetry> {
  const routeFilter = buildRouteFilter(service, method, routePath);
  const escapedService = service.replace(/'/g, "\\'");
  const warnings: string[] = [];

  const [latencyResult, errorResult, dbResult, externalResult] =
    await Promise.all([
      runScalarTraceQuerySafe(
        start,
        end,
        routeFilter,
        [
          { expression: `p50(${DURATION_ATTRIBUTE})`, alias: "p50" },
          { expression: `p95(${DURATION_ATTRIBUTE})`, alias: "p95" },
          { expression: `p99(${DURATION_ATTRIBUTE})`, alias: "p99" },
          { expression: "count()", alias: "request_count" },
        ],
        "latency/request count",
        warnings,
      ),
      runScalarTraceQuerySafe(
        start,
        end,
        `${routeFilter} AND hasError = true`,
        [{ expression: "count()", alias: "error_count" }],
        "error count",
        warnings,
      ),
      runScalarTraceQuerySafe(
        start,
        end,
        `${SERVICE_ATTRIBUTE} = '${escapedService}' AND db.system EXISTS`,
        [
          {
            expression: `avg(${DURATION_ATTRIBUTE})`,
            alias: "db_avg_duration",
          },
          { expression: "count()", alias: "db_call_count" },
        ],
        "DB span timings (no db.* spans ingested yet for this service?)",
        warnings,
      ),
      runScalarTraceQuerySafe(
        start,
        end,
        `${SERVICE_ATTRIBUTE} = '${escapedService}' AND http.url EXISTS AND ${ROUTE_ATTRIBUTE} NOT EXISTS`,
        [
          {
            expression: `avg(${DURATION_ATTRIBUTE})`,
            alias: "external_avg_duration",
          },
          { expression: "count()", alias: "external_call_count" },
        ],
        "external call timings (no outbound http.url spans ingested yet?)",
        warnings,
      ),
    ]);

  const requestCount = findAliasValue(latencyResult, "request_count") ?? 0;
  const errorCount = findAliasValue(errorResult, "error_count") ?? 0;
  const dbAvg = findAliasValue(dbResult, "db_avg_duration");
  const externalAvg = findAliasValue(externalResult, "external_avg_duration");

  debugLog("route filter used:", routeFilter);
  debugLog("extracted values:", {
    requestCount,
    errorCount,
    p50: findAliasValue(latencyResult, "p50"),
    p95: findAliasValue(latencyResult, "p95"),
    p99: findAliasValue(latencyResult, "p99"),
    dbAvg,
    externalAvg,
  });
  if (requestCount === 0) {
    debugLog(
      "requestCount is 0 — the filter matched no spans. Most likely causes:",
      "(1) service name doesn't match SigNoz's Services list for this app,",
      `(2) '${SEMCONV.method}' or '${ROUTE_ATTRIBUTE}' isn't the attribute name your instrumentation actually emits — check a span's attributes in the SigNoz UI,`,
      "(3) the time window doesn't overlap when the traffic was actually sent/ingested.",
    );
  }

  return {
    service,
    method,
    routePath,
    window: { start, end },
    requestCount,
    errorCount,
    errorRatePercent:
      requestCount > 0
        ? Math.round((errorCount / requestCount) * 10000) / 100
        : 0,
    latencyMs: {
      p50: nanoToMs(findAliasValue(latencyResult, "p50")),
      p95: nanoToMs(findAliasValue(latencyResult, "p95")),
      p99: nanoToMs(findAliasValue(latencyResult, "p99")),
    },
    db: {
      avgDurationMs: dbAvg !== null ? nanoToMs(dbAvg) : null,
      callCount: findAliasValue(dbResult, "db_call_count") ?? 0,
    },
    external: {
      avgDurationMs: externalAvg !== null ? nanoToMs(externalAvg) : null,
      callCount: findAliasValue(externalResult, "external_call_count") ?? 0,
    },
    warnings,
  };
}
