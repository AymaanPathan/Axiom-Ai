// signoz.service.ts — parsing fix
//
// ROOT CAUSE OF "everything shows 0": SigNoz v5 scalar responses do NOT
// embed the aggregation alias anywhere in the JSON. Each column comes back
// as { name: "__result_0", aggregationIndex: 0, ... } and the actual
// numbers live in a positional array: data: [[val0, val1, val2, ...]].
// The old findAliasValue() searched the tree for an object key literally
// matching the alias string ("p50", "request_count", etc.) — that key
// never exists in this shape, so it always returned null, and every call
// site silently fell back to `?? 0`. Real telemetry was being fetched
// successfully the whole time; it just never got read out of the response.
//
// Fix: extract by position. The order of the "columns"/"data" arrays in
// the response matches the order of the `aggregations` array you sent in
// the request, so aggregationIndex N corresponds to aggregations[N].

export interface RouteTelemetry {
  service: string;
  method: string;
  routePath: string;
  window: { start: number; end: number };
  requestCount: number;
  errorCount: number;
  errorRatePercent: number;
  latencyMs: { p50: number; p95: number; p99: number; avg: number };
  db: { avgDurationMs: number | null; callCount: number };
  external: { avgDurationMs: number | null; callCount: number };
  warnings: string[];
}

export const SEMCONV = {
  method: "httpMethod",
  statusCode: "responseStatusCode",
};

export const ROUTE_ATTRIBUTE = "http.route";
export const SERVICE_ATTRIBUTE = "service.name";
export const DURATION_ATTRIBUTE = "durationNano";

interface Aggregation {
  expression: string;
  alias: string;
}

let signozQueue: Promise<void> = Promise.resolve();

function enqueueSignozCall<T>(fn: () => Promise<T>): Promise<T> {
  const run = signozQueue.then(fn, fn);
  signozQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function getConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.SIGNOZ_API_URL;
  const apiKey = process.env.SIGNOZ_API_KEY;
  if (!baseUrl || !apiKey) {
    console.error(
      "[SigNoz] CONFIG ERROR: missing SIGNOZ_API_URL and/or SIGNOZ_API_KEY.",
      {
        hasBaseUrl: Boolean(baseUrl),
        hasApiKey: Boolean(apiKey),
      },
    );
    throw new Error(
      "SIGNOZ_API_URL and SIGNOZ_API_KEY must be set in the backend .env. " +
        "Get an API key from SigNoz under Settings -> Service Accounts.",
    );
  }
  console.log("[SigNoz] config loaded, baseUrl:", baseUrl.replace(/\/$/, ""));
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

const DEBUG = process.env.SIGNOZ_DEBUG !== "false";

export function debugLog(...args: unknown[]): void {
  if (DEBUG) console.log("[SigNoz]", ...args);
}

export async function runScalarTraceQuery(
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
  console.log("[SigNoz] scalar query -->", filterExpression);

  let res: Response;
  try {
    res = await enqueueSignozCall(() =>
      fetch(`${baseUrl}/api/v5/query_range`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "SIGNOZ-API-KEY": apiKey,
        },
        body: JSON.stringify(body),
      }),
    );
  } catch (networkErr) {
    console.error(
      "[SigNoz] NETWORK ERROR calling query_range (scalar):",
      networkErr instanceof Error ? networkErr.message : networkErr,
    );
    throw networkErr;
  }

  const rawText = await res.text();

  if (!res.ok) {
    console.error(
      `[SigNoz] API ERROR ${res.status} on scalar query:`,
      rawText.slice(0, 500),
    );
    debugLog("<-- ERROR", res.status, rawText.slice(0, 500));
    throw new Error(
      `SigNoz API error (${res.status}): ${rawText.slice(0, 300)}`,
    );
  }

  debugLog("<-- 200 OK, raw body:", rawText.slice(0, 1000));
  console.log("[SigNoz] scalar query <-- 200 OK");

  try {
    return JSON.parse(rawText);
  } catch (parseErr) {
    console.error(
      "[SigNoz] JSON PARSE ERROR on scalar response:",
      parseErr instanceof Error ? parseErr.message : parseErr,
      "raw:",
      rawText.slice(0, 500),
    );
    throw parseErr;
  }
}

// NEW: list-mode query — returns individual span rows instead of a scalar
// aggregate. Used for "recent traces" and "recent errors" where you need
// one row per request, not a single number.
export async function runRawTraceQuery(
  start: number,
  end: number,
  filterExpression: string,
  selectFields: string[],
  limit: number,
): Promise<unknown> {
  const { baseUrl, apiKey } = getConfig();

  const body = {
    start,
    end,
    requestType: "raw",
    compositeQuery: {
      queries: [
        {
          type: "builder_query",
          spec: {
            name: "A",
            signal: "traces",
            selectFields: selectFields.map((f) => ({ name: f })),
            filter: { expression: filterExpression },
            limit,
            order: [{ key: { name: "timestamp" }, direction: "desc" }],
            disabled: false,
          },
        },
      ],
    },
  };

  debugLog("--> [raw list] filter:", filterExpression, "limit:", limit);
  console.log(
    "[SigNoz] raw list query -->",
    filterExpression,
    "fields:",
    selectFields,
    "limit:",
    limit,
  );

  let res: Response;
  try {
    res = await enqueueSignozCall(() =>
      fetch(`${baseUrl}/api/v5/query_range`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "SIGNOZ-API-KEY": apiKey,
        },
        body: JSON.stringify(body),
      }),
    );
  } catch (networkErr) {
    console.error(
      "[SigNoz] NETWORK ERROR calling query_range (raw):",
      networkErr instanceof Error ? networkErr.message : networkErr,
    );
    throw networkErr;
  }

  const rawText = await res.text();

  if (!res.ok) {
    console.error(
      `[SigNoz] API ERROR ${res.status} on raw list query:`,
      rawText.slice(0, 500),
    );
    debugLog("<-- ERROR", res.status, rawText.slice(0, 500));
    throw new Error(
      `SigNoz API error (${res.status}): ${rawText.slice(0, 300)}`,
    );
  }

  debugLog("<-- [raw list] 200 OK, raw body:", rawText.slice(0, 1500));
  console.log(
    "[SigNoz] raw list query <-- 200 OK, body length:",
    rawText.length,
  );

  try {
    return JSON.parse(rawText);
  } catch (parseErr) {
    console.error(
      "[SigNoz] JSON PARSE ERROR on raw list response:",
      parseErr instanceof Error ? parseErr.message : parseErr,
      "raw:",
      rawText.slice(0, 500),
    );
    throw parseErr;
  }
}

export async function runScalarTraceQuerySafe(
  start: number,
  end: number,
  filterExpression: string,
  aggregations: Aggregation[],
  label: string,
  warnings: string[],
): Promise<unknown> {
  debugLog(`=== [${label}] running ===`);
  console.log(`[SigNoz] [${label}] starting scalar query`);
  try {
    const result = await runScalarTraceQuery(
      start,
      end,
      filterExpression,
      aggregations,
    );
    debugLog(`=== [${label}] succeeded ===`);
    console.log(`[SigNoz] [${label}] succeeded`);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    debugLog(`=== [${label}] FAILED:`, message, "===");
    console.error(`[SigNoz] [${label}] FAILED:`, message);
    warnings.push(`${label}: ${message}`);
    return null;
  }
}

export async function runRawTraceQuerySafe(
  start: number,
  end: number,
  filterExpression: string,
  selectFields: string[],
  limit: number,
  label: string,
  warnings: string[],
): Promise<unknown> {
  debugLog(`=== [${label}] running ===`);
  console.log(`[SigNoz] [${label}] starting raw list query`);
  try {
    const result = await runRawTraceQuery(
      start,
      end,
      filterExpression,
      selectFields,
      limit,
    );
    debugLog(`=== [${label}] succeeded ===`);
    console.log(`[SigNoz] [${label}] succeeded`);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    debugLog(`=== [${label}] FAILED:`, message, "===");
    console.error(`[SigNoz] [${label}] FAILED:`, message);
    warnings.push(`${label}: ${message}`);
    return null;
  }
}

// DEPRECATED: kept only in case anything external still imports it. Do not
// use for new code — it cannot parse SigNoz v5 scalar responses (see file
// header). Prefer extractScalarValues() below.
export function findAliasValue(node: unknown, alias: string): number | null {
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

// Extracts values from a SigNoz v5 scalar response by POSITION, matching
// the order of the `aggregations` array you sent in the request. This is
// the correct way to read a scalar response — the JSON has no alias-keyed
// fields to search for.
//
// Response shape (scalar, single row):
//   { status, data: { data: { results: [ { columns: [...], data: [[v0, v1, ...]] } ] } } }
export function extractScalarValues(
  raw: unknown,
  aggregations: { alias: string }[],
): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  for (const agg of aggregations) result[agg.alias] = null;

  if (!raw || typeof raw !== "object") return result;

  const results = (raw as Record<string, any>)?.data?.data?.results;
  if (!Array.isArray(results) || results.length === 0) {
    debugLog("extractScalarValues: no results[] in response");
    return result;
  }

  const rows: unknown[][] | undefined = results[0]?.data;
  if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(rows[0])) {
    debugLog("extractScalarValues: no data row in results[0]");
    return result;
  }

  const row = rows[0];
  aggregations.forEach((agg, i) => {
    const val = row[i];
    if (typeof val === "number" && !Number.isNaN(val)) {
      result[agg.alias] = val;
    } else if (typeof val === "string" && val.trim() !== "") {
      const num = Number(val);
      result[agg.alias] = Number.isNaN(num) ? null : num;
    } else {
      result[agg.alias] = null; // covers null, undefined, ""
    }
  });

  return result;
}

export function nanoToMs(nano: number | null): number {
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

export async function getRouteTelemetry(
  service: string,
  method: string,
  routePath: string,
  start: number,
  end: number,
): Promise<RouteTelemetry> {
  console.log(
    `[SigNoz] getRouteTelemetry(${service}, ${method}, ${routePath}) window=${windowLabel(start, end)}`,
  );

  const routeFilter = buildRouteFilter(service, method, routePath);
  const escapedService = service.replace(/'/g, "\\'");
  const warnings: string[] = [];

  const latencyAggregations: Aggregation[] = [
    { expression: `p50(${DURATION_ATTRIBUTE})`, alias: "p50" },
    { expression: `p95(${DURATION_ATTRIBUTE})`, alias: "p95" },
    { expression: `p99(${DURATION_ATTRIBUTE})`, alias: "p99" },
    { expression: `avg(${DURATION_ATTRIBUTE})`, alias: "avg" },
    { expression: "count()", alias: "request_count" },
  ];
  const latencyRaw = await runScalarTraceQuerySafe(
    start,
    end,
    routeFilter,
    latencyAggregations,
    "latency/request count",
    warnings,
  );
  const latencyValues = extractScalarValues(latencyRaw, latencyAggregations);

  const errorAggregations: Aggregation[] = [
    { expression: "count()", alias: "error_count" },
  ];
  const errorRaw = await runScalarTraceQuerySafe(
    start,
    end,
    `${routeFilter} AND hasError = true`,
    errorAggregations,
    "error count",
    warnings,
  );
  const errorValues = extractScalarValues(errorRaw, errorAggregations);

  const dbAggregations: Aggregation[] = [
    { expression: `avg(${DURATION_ATTRIBUTE})`, alias: "db_avg_duration" },
    { expression: "count()", alias: "db_call_count" },
  ];
  const dbRaw = await runScalarTraceQuerySafe(
    start,
    end,
    `${SERVICE_ATTRIBUTE} = '${escapedService}' AND dbSystem EXISTS`,
    dbAggregations,
    "DB span timings (no db.* spans ingested yet for this service?)",
    warnings,
  );
  const dbValues = extractScalarValues(dbRaw, dbAggregations);

  const externalAggregations: Aggregation[] = [
    {
      expression: `avg(${DURATION_ATTRIBUTE})`,
      alias: "external_avg_duration",
    },
    { expression: "count()", alias: "external_call_count" },
  ];
  const externalRaw = await runScalarTraceQuerySafe(
    start,
    end,
    `${SERVICE_ATTRIBUTE} = '${escapedService}' AND http.url EXISTS AND ${ROUTE_ATTRIBUTE} NOT EXISTS`,
    externalAggregations,
    "external call timings (no outbound http.url spans ingested yet?)",
    warnings,
  );
  const externalValues = extractScalarValues(externalRaw, externalAggregations);

  const requestCount = latencyValues.request_count ?? 0;
  const errorCount = errorValues.error_count ?? 0;
  const dbAvg = dbValues.db_avg_duration ?? null;
  const externalAvg = externalValues.external_avg_duration ?? null;

  if (requestCount === 0) {
    debugLog(
      "requestCount is 0 — filter matched no spans (or no traffic in window). Check service name / attribute names / time window.",
    );
    console.warn(
      `[SigNoz] getRouteTelemetry(${service}, ${method}, ${routePath}): requestCount is 0 — filter matched no spans (or no traffic in window).`,
    );
  }

  if (warnings.length > 0) {
    console.warn(
      `[SigNoz] getRouteTelemetry(${service}, ${method}, ${routePath}) warnings:`,
      warnings,
    );
  }

  console.log(
    `[SigNoz] getRouteTelemetry(${service}, ${method}, ${routePath}) result: requestCount=${requestCount}, errorCount=${errorCount}, dbAvg=${dbAvg}, externalAvg=${externalAvg}`,
  );

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
      p50: nanoToMs(latencyValues.p50),
      p95: nanoToMs(latencyValues.p95),
      p99: nanoToMs(latencyValues.p99),
      avg: nanoToMs(latencyValues.avg),
    },
    db: {
      avgDurationMs: dbAvg !== null ? nanoToMs(dbAvg) : null,
      callCount: dbValues.db_call_count ?? 0,
    },
    external: {
      avgDurationMs: externalAvg !== null ? nanoToMs(externalAvg) : null,
      callCount: externalValues.external_call_count ?? 0,
    },
    warnings,
  };
}

function windowLabel(start: number, end: number): string {
  return `${new Date(start).toISOString()}..${new Date(end).toISOString()} (${end - start}ms)`;
}
