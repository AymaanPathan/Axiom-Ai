import {
  getRouteTelemetry,
  runRawTraceQuerySafe,
  SERVICE_ATTRIBUTE,
  ROUTE_ATTRIBUTE,
  SEMCONV,
  DURATION_ATTRIBUTE,
  nanoToMs,
  type RouteTelemetry,
} from "./signoz.service.js";

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

// Runs `fn` over `items` with at most `limit` in flight at once — keeps us
// from firing 20 concurrent query_range calls and tripping SigNoz's
// "parallel query execution failed" bug (github.com/SigNoz/signoz/issues/11509).
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  console.log(
    `[Observability] mapWithConcurrency: ${items.length} item(s), concurrency=${limit}`,
  );

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

const SIGNOZ_QUERY_CONCURRENCY = 1;

export async function getEndpointMetrics(
  serviceName: string,
  routes: { method: string; routePath: string }[],
  windowMinutes = 15,
): Promise<EndpointMetricResult[]> {
  console.log(
    `[Observability] getEndpointMetrics(${serviceName}): ${routes.length} route(s), window=${windowMinutes}min`,
  );

  const end = Date.now();
  const start = end - windowMinutes * 60 * 1000;

  const results = await mapWithConcurrency(
    routes,
    SIGNOZ_QUERY_CONCURRENCY,
    (r) => getRouteTelemetry(serviceName, r.method, r.routePath, start, end),
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

  const metrics = fulfilled
    .map((r) => r.value)
    .map((t) => ({
      method: t.method,
      routePath: t.routePath,
      requestCount: t.requestCount,
      errorCount: t.errorCount,
      avgLatencyMs: t.latencyMs.avg,
      p95Ms: t.latencyMs.p95,
    }));

  console.log(
    `[Observability] getEndpointMetrics(${serviceName}): returning ${metrics.length} metric(s)`,
  );

  return metrics;
}

// Best-effort tree walk for raw list rows. SigNoz v5 raw-query responses
// nest row data under a `data` key per record — this looks for any object
// whose keys (or its `data` sub-object's keys) cover the fields we asked
// for, and collects those as rows.
function extractRows(
  node: unknown,
  requiredFieldHints: string[],
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];

  function looksLikeRow(obj: Record<string, unknown>): boolean {
    const keys = Object.keys(obj).map((k) => k.toLowerCase());
    return requiredFieldHints.every((hint) =>
      keys.some((k) => k.includes(hint.toLowerCase())),
    );
  }

  function walk(n: unknown) {
    if (n === null || n === undefined) return;
    if (Array.isArray(n)) {
      for (const item of n) walk(item);
      return;
    }
    if (typeof n === "object") {
      const obj = n as Record<string, unknown>;
      const candidate =
        obj.data && typeof obj.data === "object"
          ? (obj.data as Record<string, unknown>)
          : obj;
      if (looksLikeRow(candidate)) {
        rows.push(candidate);
      }
      for (const value of Object.values(obj)) walk(value);
    }
  }

  walk(node);

  console.log(
    `[Observability] extractRows: hints=${JSON.stringify(requiredFieldHints)} -> found ${rows.length} row(s)`,
  );
  if (rows.length === 0 && node !== null && node !== undefined) {
    // This is the case most likely to indicate a response-shape mismatch —
    // dump the top-level keys we actually saw to help diagnose it.
    console.warn(
      "[Observability] extractRows: no rows matched. Top-level node was:",
      JSON.stringify(node).slice(0, 800),
    );
  }
  if (rows.length > 0) {
    console.log(
      "[Observability] extractRows: sample row keys:",
      Object.keys(rows[0]),
    );
  }

  return rows;
}

function pick(row: Record<string, unknown>, hint: string): unknown {
  const match = Object.entries(row).find(([k]) =>
    k.toLowerCase().includes(hint.toLowerCase()),
  );
  return match?.[1];
}

export async function getRecentTraces(
  serviceName: string,
  windowMinutes = 15,
  limit = 20,
): Promise<{ traces: TraceSummaryResult[]; warnings: string[] }> {
  console.log(
    `[Observability] getRecentTraces(${serviceName}): window=${windowMinutes}min, limit=${limit}`,
  );

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
      SEMCONV.method,
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

  const rows = extractRows(raw, ["traceid", "durationnano"]);
  if (rows.length === 0) {
    const msg =
      "recent traces: query succeeded but extractRows() found no matching rows — response shape needs verification, see SIGNOZ_DEBUG output";
    warnings.push(msg);
    console.warn(`[Observability] getRecentTraces(${serviceName}): ${msg}`);
  }

  const traces: TraceSummaryResult[] = rows.map((row) => ({
    traceId: String(pick(row, "traceid") ?? ""),
    method: String(
      pick(row, SEMCONV.method.split(".").pop() ?? "method") ?? "",
    ),
    routePath: String(pick(row, "route") ?? ""),
    durationMs: nanoToMs(Number(pick(row, "duration") ?? 0)),
    status: pick(row, "haserror") === true ? "error" : "ok",
    timestamp: Number(pick(row, "timestamp") ?? Date.now()),
  }));

  console.log(
    `[Observability] getRecentTraces(${serviceName}): returning ${traces.length} trace(s), ${warnings.length} warning(s)`,
  );

  return { traces, warnings };
}

export async function getRecentErrors(
  serviceName: string,
  windowMinutes = 15,
  limit = 20,
): Promise<{ errors: ErrorEventResult[]; warnings: string[] }> {
  console.log(
    `[Observability] getRecentErrors(${serviceName}): window=${windowMinutes}min, limit=${limit}`,
  );

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
      SEMCONV.method,
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

  const rows = extractRows(raw, ["traceid"]);
  if (rows.length === 0) {
    const msg =
      "recent errors: query succeeded but extractRows() found no matching rows — response shape needs verification, see SIGNOZ_DEBUG output";
    warnings.push(msg);
    console.warn(`[Observability] getRecentErrors(${serviceName}): ${msg}`);
  }

  const errors: ErrorEventResult[] = rows.map((row) => ({
    id: String(pick(row, "spanid") ?? pick(row, "traceid") ?? Math.random()),
    message: String(
      pick(row, "exception.message") ??
        pick(row, "statusmessage") ??
        "Unknown error",
    ),
    routePath: pick(row, "route") ? String(pick(row, "route")) : undefined,
    method: pick(row, SEMCONV.method.split(".").pop() ?? "method")
      ? String(pick(row, SEMCONV.method.split(".").pop() ?? "method"))
      : undefined,
    stack: pick(row, "exception.stacktrace")
      ? String(pick(row, "exception.stacktrace"))
      : undefined,
    timestamp: Number(pick(row, "timestamp") ?? Date.now()),
  }));

  console.log(
    `[Observability] getRecentErrors(${serviceName}): returning ${errors.length} error(s), ${warnings.length} warning(s)`,
  );

  return { errors, warnings };
}
