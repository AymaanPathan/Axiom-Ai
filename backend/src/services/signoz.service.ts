import { randomUUID } from "node:crypto";
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
  dashboardUrl?: string | null;
}

// NOTE: these two were previously hardcoded, unverified guesses — see
// ensureFieldKeysVerified() below, which checks them against this
// workspace's real trace field keys (the same signoz_get_field_keys path
// that already confirmed ROUTE_ATTRIBUTE/DURATION_ATTRIBUTE below) and
// self-corrects them once, on first real use, instead of trusting the
// guess for the lifetime of the process.
export const SEMCONV = {
  method: "http_method", // unverified guess — corrected by ensureFieldKeysVerified() if wrong
  statusCode: "response_status_code",
};

export const ROUTE_ATTRIBUTE = "http.route"; // confirmed via signoz_get_field_keys(signal="traces", searchText="route")
export let SERVICE_ATTRIBUTE = "service.name"; // unverified guess — corrected by ensureFieldKeysVerified() if wrong

// Runs once (memoized), best-effort: asks the SigNoz MCP server what the
// real "method" and "service" field keys are for this workspace's traces,
// and corrects SEMCONV.method / SERVICE_ATTRIBUTE in place if they were
// wrong. If the MCP server isn't running, this is a no-op and every filter
// in this file keeps using the hardcoded guesses exactly as before — same
// "enrichment, not dependency" contract used everywhere else MCP is
// touched in this codebase. Every exported function below that builds a
// filter using SEMCONV.method or SERVICE_ATTRIBUTE calls this first.
let fieldKeyVerification: Promise<void> | null = null;

export async function ensureFieldKeysVerified(): Promise<void> {
  if (fieldKeyVerification) return fieldKeyVerification;

  fieldKeyVerification = (async () => {
    try {
      const { discoverMethodFieldKey, discoverServiceFieldKey } =
        await import("./signozMcp.service.js");
      const [methodKey, serviceKey] = await Promise.all([
        discoverMethodFieldKey().catch(() => null),
        discoverServiceFieldKey().catch(() => null),
      ]);

      if (methodKey && methodKey !== SEMCONV.method) {
        console.warn(
          `[SigNoz] "method" field key was wrong: guessed "${SEMCONV.method}", ` +
            `live workspace uses "${methodKey}" — every filter using it was ` +
            `silently matching zero spans. Correcting for this process.`,
        );
        SEMCONV.method = methodKey;
      } else if (!methodKey) {
        console.warn(
          `[SigNoz] Could not verify the "method" field key (MCP server unreachable?). ` +
            `Still using unverified guess "${SEMCONV.method}" — if dashboards/telemetry ` +
            `show no data, check the real key via the SigNoz UI's filter-bar autocomplete.`,
        );
      }

      if (serviceKey && serviceKey !== SERVICE_ATTRIBUTE) {
        console.warn(
          `[SigNoz] "service" field key was wrong: guessed "${SERVICE_ATTRIBUTE}", ` +
            `live workspace uses "${serviceKey}". Correcting for this process.`,
        );
        SERVICE_ATTRIBUTE = serviceKey;
      }
    } catch (err) {
      console.warn(
        "[SigNoz] Field-key self-verification skipped (MCP server unreachable) — " +
          "keeping existing guesses:",
        err instanceof Error ? err.message : err,
      );
    }
  })();

  return fieldKeyVerification;
}
// "duration_nano" confirmed via signoz_get_field_keys(signal="traces",
// searchText="duration") against this workspace's live SigNoz instance —
// it's the only duration-related field that exists (span-context, unit ns).
// Previous value "durationNano" (camelCase) was the same unverified-guess
// pattern as the old SEMCONV.method value, and it's used inside every
// latency/duration AGGREGATION in this file (p50/p95/p99/avg in
// getRouteTelemetry, getServiceAggregate; avg/total in
// getDbOperationBreakdown) — not just an equality filter, so this one was
// silently returning 0 for every latency number in the file rather than
// erroring or just failing to match a filter.
export const DURATION_ATTRIBUTE = "duration_nano";

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

// --- SigNoz dashboard creation ---------------------------------------------
// Template shape confirmed against a live-exported dashboard from this
// SigNoz instance. Only widget titles, filter expressions, and fresh
// ids change per call — everything else is copied from the confirmed
// export so we don't drift from what this SigNoz version accepts.
const dashboardUrlCache = new Map<string, string>();

function buildTracesWidget(opts: {
  title: string;
  panelTypes: "graph" | "value";
  aggregationExpression: string;
  filterExpression: string;
}) {
  const widgetId = randomUUID();
  // count() on a "value" panel (Request Count / Error Count) should SUM
  // across the window, not average per-bucket — "avg" here was silently
  // showing an averaged-per-bucket count instead of a true total.
  const reduceTo = opts.panelTypes === "value" ? "sum" : "avg";
  return {
    id: widgetId,
    title: opts.title,
    description: "",
    panelTypes: opts.panelTypes,
    isLogScale: false,
    opacity: "1",
    nullZeroValues: "zero",
    fillSpans: false,
    stackedBarChart: false,
    softMin: 0,
    softMax: 0,
    bucketCount: 30,
    bucketWidth: 0,
    thresholds: [],
    yAxisUnit: "",
    timePreferance: "GLOBAL_TIME",
    query: {
      queryType: "builder",
      unit: "",
      builder: {
        queryData: [
          {
            queryName: "A",
            dataSource: "traces",
            aggregations: [
              {
                expression: opts.aggregationExpression,
                metricName: "",
                temporality: "",
                timeAggregation: "avg",
                spaceAggregation: "sum",
                reduceTo,
              },
            ],
            filter: { expression: opts.filterExpression },
            groupBy: [],
            having: { expression: "" },
            orderBy: [],
            limit: null,
            stepInterval: null,
            functions: [],
            expression: "A",
            disabled: false,
            source: "",
            legend: "",
          },
        ],
        queryFormulas: [],
        queryTraceOperator: [],
      },
      promql: [{ name: "A", query: "", legend: "", disabled: false }],
      clickhouse_sql: [{ name: "A", query: "", legend: "", disabled: false }],
    },
    selectedTracesFields: [
      {
        name: "service.name",
        fieldContext: "resource",
        fieldDataType: "string",
        signal: "traces",
      },
      {
        name: "name",
        fieldContext: "span",
        fieldDataType: "string",
        signal: "traces",
      },
      {
        name: "duration_nano",
        fieldContext: "span",
        fieldDataType: "",
        signal: "traces",
      },
      {
        name: "http_method",
        fieldContext: "span",
        fieldDataType: "",
        signal: "traces",
      },
      {
        name: "response_status_code",
        fieldContext: "span",
        fieldDataType: "",
        signal: "traces",
      },
    ],
    selectedLogFields: [
      {
        name: "timestamp",
        fieldContext: "log",
        fieldDataType: "",
        signal: "logs",
        isIndexed: false,
        dataType: "",
      },
      {
        name: "body",
        fieldContext: "log",
        fieldDataType: "",
        signal: "logs",
        isIndexed: false,
        dataType: "",
      },
    ],
    columnUnits: {},
    customLegendColors: {},
    contextLinks: { linksData: [] },
    decimalPrecision: 2,
    legendPosition: "bottom",
    lineInterpolation: "spline",
    lineStyle: "solid",
    mergeAllActiveQueries: false,
    showPoints: false,
    spanGaps: true,
  };
}

function buildRouteDashboardPayload(
  serviceName: string,
  method: string,
  routePath: string,
) {
  const escService = serviceName.replace(/'/g, "\\'");
  const escRoute = routePath.replace(/'/g, "\\'");
  const baseFilter = `${SERVICE_ATTRIBUTE} = '${escService}' AND ${SEMCONV.method} = '${method}' AND ${ROUTE_ATTRIBUTE} = '${escRoute}'`;

  const latencyWidget = buildTracesWidget({
    title: "P95 Latency (ms)",
    panelTypes: "graph",
    aggregationExpression: `p95(${DURATION_ATTRIBUTE})`,
    filterExpression: baseFilter,
  });
  const requestCountWidget = buildTracesWidget({
    title: "Request Count",
    panelTypes: "value",
    aggregationExpression: "count()",
    filterExpression: baseFilter,
  });
  const errorCountWidget = buildTracesWidget({
    title: "Error Count",
    panelTypes: "value",
    aggregationExpression: "count()",
    filterExpression: `${baseFilter} AND has_error = true`,
  });

  return {
    name: `Axiom — ${method} ${routePath} (${serviceName})`,
    description: "Auto-created by Axiom AI for live route telemetry.",
    tags: ["axiom-ai"],
    variables: {},
    widgets: [latencyWidget, requestCountWidget, errorCountWidget],
    layout: [
      {
        i: latencyWidget.id,
        x: 0,
        y: 0,
        w: 6,
        h: 6,
        moved: false,
        static: false,
      },
      {
        i: requestCountWidget.id,
        x: 6,
        y: 0,
        w: 3,
        h: 6,
        moved: false,
        static: false,
      },
      {
        i: errorCountWidget.id,
        x: 9,
        y: 0,
        w: 3,
        h: 6,
        moved: false,
        static: false,
      },
    ],
    panelMap: {},
    version: "v5",
    title: `Axiom — ${method} ${routePath} (${serviceName})`,
  };
}

export async function getOrCreateRouteDashboardUrl(
  serviceName: string,
  method: string,
  routePath: string,
): Promise<string | null> {
  const cacheKey = `${serviceName}:${method}:${routePath}`;
  const cached = dashboardUrlCache.get(cacheKey);
  if (cached) return cached;

  await ensureFieldKeysVerified();
  const { baseUrl, apiKey } = getConfig();

  try {
    const res = await fetch(`${baseUrl}/api/v1/dashboards`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "SIGNOZ-API-KEY": apiKey },
      body: JSON.stringify(
        buildRouteDashboardPayload(serviceName, method, routePath),
      ),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.warn(
        `[SigNoz] Dashboard creation failed (${res.status}) for ${cacheKey}: ${errText.slice(0, 300)}`,
      );
      return null;
    }

    const data = await res.json();
    const dashboardId = data?.data?.id ?? data?.id;
    if (!dashboardId) {
      console.warn(
        "[SigNoz] Dashboard created but no id in response:",
        JSON.stringify(data).slice(0, 300),
      );
      return null;
    }

    const url = `${baseUrl}/dashboard/${dashboardId}`;
    dashboardUrlCache.set(cacheKey, url);
    return url;
  } catch (err) {
    console.warn(
      "[SigNoz] Dashboard creation errored, link omitted:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
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

export interface DbOperationBreakdown {
  operation: string;
  callCount: number;
  avgDurationMs: number;
  totalDurationMs: number;
}

// Grouped scalar query — same builder_query shape as runScalarTraceQuery,
// but with a groupBy clause so SigNoz returns one row PER distinct value
// of the group field (e.g. one row per db.operation / query name) instead
// of a single aggregate row. This is what makes "Product.find() called 74
// times, avg 2.1ms" possible instead of a single blended DB average.
export async function runGroupedScalarTraceQuery(
  start: number,
  end: number,
  filterExpression: string,
  aggregations: Aggregation[],
  groupByField: string,
  limit: number,
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
            groupBy: [{ name: groupByField }],
            filter: { expression: filterExpression },
            limit,
            order: [
              {
                key: { name: aggregations[0]?.alias ?? "count" },
                direction: "desc",
              },
            ],
            disabled: false,
          },
        },
      ],
    },
  };

  debugLog("--> [grouped] filter:", filterExpression, "groupBy:", groupByField);
  console.log(
    "[SigNoz] grouped scalar query -->",
    filterExpression,
    "groupBy:",
    groupByField,
  );

  const res = await fetch(`${baseUrl}/api/v5/query_range`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "SIGNOZ-API-KEY": apiKey },
    body: JSON.stringify(body),
  });

  const rawText = await res.text();
  if (!res.ok) {
    console.error(
      `[SigNoz] API ERROR ${res.status} on grouped query:`,
      rawText.slice(0, 500),
    );
    throw new Error(
      `SigNoz API error (${res.status}): ${rawText.slice(0, 300)}`,
    );
  }

  debugLog("<-- [grouped] 200 OK, raw body:", rawText.slice(0, 1500));
  return JSON.parse(rawText);
}

export async function runGroupedScalarTraceQuerySafe(
  start: number,
  end: number,
  filterExpression: string,
  aggregations: Aggregation[],
  groupByField: string,
  limit: number,
  label: string,
  warnings: string[],
): Promise<unknown> {
  try {
    return await enqueueSignozCall(() =>
      runGroupedScalarTraceQuery(
        start,
        end,
        filterExpression,
        aggregations,
        groupByField,
        limit,
      ),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[SigNoz] [${label}] FAILED:`, message);
    warnings.push(`${label}: ${message}`);
    return null;
  }
}

// Extracts grouped rows. Each row's leading column(s) (columnType !==
// "aggregation") carry the group-by value itself; the remaining columns
// are aggregation results in the same order as the `aggregations` array,
// same positional convention as extractScalarValues.
function extractGroupedRows(
  raw: unknown,
  aggregations: Aggregation[],
): { groupValue: string; values: Record<string, number | null> }[] {
  const rows: { groupValue: string; values: Record<string, number | null> }[] =
    [];
  const results = (raw as Record<string, any>)?.data?.data?.results;
  if (!Array.isArray(results) || results.length === 0) return rows;

  const columns: { name: string; columnType?: string }[] =
    results[0]?.columns ?? [];
  const dataRows: unknown[][] = results[0]?.data ?? [];

  const groupColIndexes = columns
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.columnType !== "aggregation")
    .map(({ i }) => i);
  const aggColIndexes = columns
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.columnType === "aggregation")
    .map(({ i }) => i);

  for (const row of dataRows) {
    if (!Array.isArray(row)) continue;
    const groupValue =
      groupColIndexes.map((i) => String(row[i] ?? "unknown")).join(" ") ||
      "unknown";
    const values: Record<string, number | null> = {};
    aggregations.forEach((agg, idx) => {
      const colIndex = aggColIndexes[idx];
      const val = colIndex !== undefined ? row[colIndex] : undefined;
      values[agg.alias] =
        typeof val === "number" && !Number.isNaN(val)
          ? val
          : val
            ? Number(val)
            : null;
    });
    rows.push({ groupValue, values });
  }

  return rows;
}

// Breaks DB span time down by operation (db.operation / db.statement's
// operation prefix / span name — whichever attribute your instrumentation
// populates). Falls back gracefully if the group field doesn't exist on
// this service's spans — returns an empty array rather than throwing, so
// callers can treat "no breakdown available" as a normal case.
export async function getDbOperationBreakdown(
  serviceName: string,
  start: number,
  end: number,
  limit = 10,
): Promise<{ breakdown: DbOperationBreakdown[]; warnings: string[] }> {
  const escapedService = serviceName.replace(/'/g, "\\'");
  const warnings: string[] = [];

  const aggregations: Aggregation[] = [
    { expression: "count()", alias: "call_count" },
    { expression: `avg(${DURATION_ATTRIBUTE})`, alias: "avg_duration" },
    { expression: `sum(${DURATION_ATTRIBUTE})`, alias: "total_duration" },
  ];

  // "db.operation" is the standard OTEL semantic-convention attribute for
  // the query verb (find, insert, aggregate, ...). If your instrumentation
  // populates a different field for query identity (e.g. "db.statement" or
  // the span "name" itself), swap this string — everything else here is
  // attribute-name agnostic.
  const GROUP_FIELD = "db.operation";

  const raw = await runGroupedScalarTraceQuerySafe(
    start,
    end,
    `${SERVICE_ATTRIBUTE} = '${escapedService}' AND dbSystem EXISTS`,
    aggregations,
    GROUP_FIELD,
    limit,
    "DB operation breakdown",
    warnings,
  );

  if (raw === null) return { breakdown: [], warnings };

  const rows = extractGroupedRows(raw, aggregations);
  if (rows.length === 0) {
    warnings.push(
      `DB operation breakdown: query succeeded but returned no grouped rows — "${GROUP_FIELD}" may not be populated by this service's instrumentation`,
    );
  }

  const breakdown: DbOperationBreakdown[] = rows
    .map((r) => ({
      operation: r.groupValue,
      callCount: r.values.call_count ?? 0,
      avgDurationMs: nanoToMs(r.values.avg_duration),
      totalDurationMs: nanoToMs(r.values.total_duration),
    }))
    .filter((b) => b.callCount > 0)
    .sort((a, b) => b.totalDurationMs - a.totalDurationMs);

  return { breakdown, warnings };
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

// Extracts EVERY row from a SigNoz v5 raw/list response, keyed by the exact
// column names the response reports — which match the `selectFields` you
// requested, since you control the query. This is the raw-query counterpart
// to extractScalarValues() above: same `results[0]: { columns, data }`
// positional shape, just N rows instead of 1.
//
// Response shape (raw/list, N rows):
//   { status, data: { data: { results: [ { columns: [{name, ...}, ...], data: [[v0, v1, ...], [v0, v1, ...], ...] } ] } } }
//
// Because this zips against `columns[i].name` rather than guessing at
// nesting, callers can index results with the exact strings they passed to
// selectFields (e.g. row["traceID"], row["http.route"]) — no fuzzy
// substring matching needed.
export function extractRawRows(raw: unknown): Record<string, unknown>[] {
  if (!raw || typeof raw !== "object") return [];

  const results = (raw as Record<string, any>)?.data?.data?.results;
  if (!Array.isArray(results) || results.length === 0) {
    debugLog("extractRawRows: no results[] in response");
    return [];
  }

  const columns: { name: string }[] = results[0]?.columns ?? [];
  const dataRows: unknown[][] = results[0]?.data;

  if (columns.length === 0 || !Array.isArray(dataRows)) {
    debugLog("extractRawRows: missing columns[] or data[] in results[0]");
    return [];
  }

  return dataRows
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => {
      const obj: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        obj[col.name] = row[i];
      });
      return obj;
    });
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

  await ensureFieldKeysVerified();
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
    `${routeFilter} AND has_error = true`,
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

export const CONTAINER_NAME_ATTRIBUTE = "container.name";

export interface MetricAggregation {
  metricName: string;
  timeAggregation: string; // "avg" | "latest" | "rate" | ...
  spaceAggregation: string; // "avg" | "sum" | "max" | ...
  reduceTo?: string; // collapses the window to one scalar, e.g. "last"
}

export async function runScalarMetricQuery(
  start: number,
  end: number,
  filterExpression: string,
  aggregation: MetricAggregation,
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
            signal: "metrics",
            aggregations: [aggregation],
            filter: { expression: filterExpression },
            disabled: false,
          },
        },
      ],
    },
  };

  debugLog(
    "--> [metric]",
    `window ${new Date(start).toISOString()} .. ${new Date(end).toISOString()}`,
    `(${end - start}ms span)`,
  );
  debugLog("--> [metric] filter:", filterExpression);
  debugLog("--> [metric] aggregation:", JSON.stringify(aggregation));
  console.log(
    "[SigNoz] metric scalar query -->",
    aggregation.metricName,
    filterExpression,
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
      "[SigNoz] NETWORK ERROR calling query_range (metric scalar):",
      networkErr instanceof Error ? networkErr.message : networkErr,
    );
    throw networkErr;
  }

  const rawText = await res.text();

  if (!res.ok) {
    console.error(
      `[SigNoz] API ERROR ${res.status} on metric scalar query:`,
      rawText.slice(0, 500),
    );
    debugLog("<-- ERROR", res.status, rawText.slice(0, 500));
    throw new Error(
      `SigNoz API error (${res.status}): ${rawText.slice(0, 300)}`,
    );
  }

  debugLog("<-- [metric] 200 OK, raw body:", rawText.slice(0, 1000));
  console.log("[SigNoz] metric scalar query <-- 200 OK");

  try {
    return JSON.parse(rawText);
  } catch (parseErr) {
    console.error(
      "[SigNoz] JSON PARSE ERROR on metric scalar response:",
      parseErr instanceof Error ? parseErr.message : parseErr,
      "raw:",
      rawText.slice(0, 500),
    );
    throw parseErr;
  }
}

export async function runScalarMetricQuerySafe(
  start: number,
  end: number,
  filterExpression: string,
  aggregation: MetricAggregation,
  label: string,
  warnings: string[],
): Promise<unknown> {
  debugLog(`=== [${label}] running ===`);
  console.log(`[SigNoz] [${label}] starting metric scalar query`);
  try {
    const result = await runScalarMetricQuery(
      start,
      end,
      filterExpression,
      aggregation,
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

// ---------------------------------------------------------------------------
// Container resource metrics (CPU/memory), sourced from SigNoz instead of a
// local `docker stats` spawn. Requires the docker_stats OTel receiver to be
// exporting into SigNoz (see otel-collector-config.yaml) — without that,
// these queries will just return null, same as any other SigNoz query
// against a signal you haven't ingested yet.
//
// https://signoz.io/docs/metrics-management/docker-container-metrics/
// ---------------------------------------------------------------------------

// Extracts the single scalar value from a runScalarMetricQuery response.
// Same v5 positional-array response shape as extractScalarValues(), but a
// metric query only ever has one aggregation/column, so there's no alias
// list to zip against — just read row[0].
export function extractScalarMetricValue(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;

  const results = (raw as Record<string, any>)?.data?.data?.results;
  if (!Array.isArray(results) || results.length === 0) {
    debugLog("extractScalarMetricValue: no results[] in response");
    return null;
  }

  const rows: unknown[][] | undefined = results[0]?.data;
  if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(rows[0])) {
    debugLog("extractScalarMetricValue: no data row in results[0]");
    return null;
  }

  const val = rows[0][0];
  if (typeof val === "number" && !Number.isNaN(val)) return val;
  if (typeof val === "string" && val.trim() !== "") {
    const num = Number(val);
    return Number.isNaN(num) ? null : num;
  }
  return null;
}

export interface ContainerResourceMetrics {
  cpuPercent: number;
  memoryMB: number;
  memoryPercent: number | null;
}

// Pulls the latest CPU/memory point for one container out of SigNoz's
// metrics signal (populated by the docker_stats OTel receiver), instead of
// shelling out to `docker stats` on the host running the backend.
//
// `start`/`end` should be a short trailing window (e.g. last 30s) — we only
// want the most recent point, not an aggregate over a long range.
//
// NOTE on units: per OTel semantic conventions, container.cpu.utilization
// is typically reported as a 0..N fraction (N = number of cores), NOT a
// 0-100 percent — hence the *100 below. VERIFY this against a raw panel in
// SigNoz for your setup (Dashboards → import the container-metrics JSON
// from the docs) before trusting the number in a demo; if your receiver
// version reports it differently, drop the *100.
export async function getContainerMetricsFromSignoz(
  containerName: string,
  start: number,
  end: number,
): Promise<{ metrics: ContainerResourceMetrics | null; warnings: string[] }> {
  const warnings: string[] = [];
  const escapedContainer = containerName.replace(/'/g, "\\'");
  const filter = `${CONTAINER_NAME_ATTRIBUTE} = '${escapedContainer}'`;

  const cpuAgg: MetricAggregation = {
    metricName: "container.cpu.utilization",
    timeAggregation: "latest",
    spaceAggregation: "avg",
    reduceTo: "last",
  };
  const memPercentAgg: MetricAggregation = {
    metricName: "container.memory.percent",
    timeAggregation: "latest",
    spaceAggregation: "avg",
    reduceTo: "last",
  };
  const memUsageAgg: MetricAggregation = {
    metricName: "container.memory.usage.total",
    timeAggregation: "latest",
    spaceAggregation: "avg",
    reduceTo: "last",
  };

  const [cpuRaw, memPercentRaw, memUsageRaw] = await Promise.all([
    runScalarMetricQuerySafe(
      start,
      end,
      filter,
      cpuAgg,
      `container CPU utilization (${containerName})`,
      warnings,
    ),
    runScalarMetricQuerySafe(
      start,
      end,
      filter,
      memPercentAgg,
      `container memory percent (${containerName})`,
      warnings,
    ),
    runScalarMetricQuerySafe(
      start,
      end,
      filter,
      memUsageAgg,
      `container memory usage bytes (${containerName})`,
      warnings,
    ),
  ]);

  const cpuFraction = extractScalarMetricValue(cpuRaw);
  const memPercent = extractScalarMetricValue(memPercentRaw);
  const memUsageBytes = extractScalarMetricValue(memUsageRaw);

  if (cpuFraction === null && memUsageBytes === null) {
    warnings.push(
      `No SigNoz metrics found yet for container "${containerName}" — ` +
        `check the docker_stats OTel receiver is running, the collector has ` +
        `the docker socket mounted, and container.name matches exactly.`,
    );
    return { metrics: null, warnings };
  }

  return {
    metrics: {
      cpuPercent:
        cpuFraction !== null ? Math.round(cpuFraction * 100 * 100) / 100 : 0,
      memoryMB:
        memUsageBytes !== null
          ? Math.round((memUsageBytes / (1024 * 1024)) * 100) / 100
          : 0,
      memoryPercent: memPercent,
    },
    warnings,
  };
}
