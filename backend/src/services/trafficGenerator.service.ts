import { resolveConnectedFiles } from "../parsing/connectedFiles.service.js";

export interface TrafficResult {
  method: string;
  routePath: string;
  requestsSent: number;
  successCount: number;
  errorCount: number;
  windowStart: number;
  windowEnd: number;
}

interface GenerateTrafficOptions {
  appPort: number;
  method: string;
  routePath: string;
  repoRoot: string;
  routeFile: string;
  routeLine: number;
  requestCount?: number;
  errorInjectionRate?: number; // 0-1, fraction of requests sent with a deliberately broken body
}

// Rough, name-based guesses for a plausible value per detected body field.
// Good enough to get real 2xx traffic through validation that just checks
// "is this field present" — won't satisfy stricter schema validation.
function guessValueForField(field: string): unknown {
  const lower = field.toLowerCase();
  if (lower.includes("email")) return "test.user@example.com";
  if (lower.includes("password")) return "TestPassword123!";
  if (lower.includes("phone")) return "+15555550123";
  if (lower.includes("address")) return "123 Main St";
  if (lower.includes("date")) return new Date().toISOString();
  if (
    lower.includes("price") ||
    lower.includes("amount") ||
    lower.includes("total")
  )
    return 19.99;
  if (
    lower.includes("qty") ||
    lower.includes("quantity") ||
    lower.includes("count")
  )
    return 2;
  if (lower.endsWith("id")) return "64b7f3f1c2a1d2e3f4a5b6c7"; // Mongo ObjectId-shaped
  if (lower.includes("name")) return "Test Item";
  return "test-value";
}

function buildFillerBody(fields: string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of fields) body[field] = guessValueForField(field);
  return body;
}

const DEBUG = process.env.SIGNOZ_DEBUG !== "false";

function debugLog(...args: unknown[]): void {
  if (DEBUG) console.log("[Traffic]", ...args);
}

async function sendOneRequest(
  baseUrl: string,
  method: string,
  routePath: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number }> {
  const url = `${baseUrl}${routePath}`;
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    debugLog(
      method,
      url,
      "->",
      res.status,
      body ? `body: ${JSON.stringify(body)}` : "(no body)",
    );
    return { ok: res.ok, status: res.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    debugLog(method, url, "-> REQUEST FAILED:", message);
    return { ok: false, status: 0 };
  }
}

/**
 * Sends real traffic to one route on a running container, so SigNoz has
 * actual spans to report on — not a single smoke-test request. Reuses the
 * connected-files resolver to detect the route's real request body fields
 * (same detection that powers the Request Schema panel) so POST/PUT/PATCH
 * traffic carries a realistic-shaped payload instead of an empty body.
 */
export async function generateTrafficForRoute({
  appPort,
  method,
  routePath,
  repoRoot,
  routeFile,
  routeLine,
  requestCount = 30,
  errorInjectionRate = 0.15,
}: GenerateTrafficOptions): Promise<TrafficResult> {
  const baseUrl = `http://localhost:${appPort}`;
  const windowStart = Date.now();

  debugLog(
    `Starting burst: ${requestCount}x ${method} ${baseUrl}${routePath}`,
    `(window starts ${new Date(windowStart).toISOString()})`,
  );

  let requestBodyFields: string[] = [];
  if (method !== "GET" && method !== "DELETE") {
    try {
      const resolved = await resolveConnectedFiles(
        repoRoot,
        routeFile,
        routeLine,
      );
      requestBodyFields = resolved.requestBodyFields;
      debugLog("Detected body fields for filler payloads:", requestBodyFields);
    } catch (err) {
      debugLog(
        "Could not resolve body fields, sending bodyless requests:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < requestCount; i++) {
    const injectError =
      requestBodyFields.length > 0 && Math.random() < errorInjectionRate;

    const body =
      requestBodyFields.length > 0
        ? injectError
          ? {} // missing required fields — a real validation/error response
          : buildFillerBody(requestBodyFields)
        : undefined;

    const result = await sendOneRequest(baseUrl, method, routePath, body);
    if (result.ok) successCount++;
    else errorCount++;

    // Jitter between requests so this reads as traffic over a window,
    // not one instant burst.
    await new Promise((resolve) =>
      setTimeout(resolve, 80 + Math.random() * 150),
    );
  }

  const windowEnd = Date.now();
  debugLog(
    `Burst finished: ${successCount} ok / ${errorCount} failed`,
    `(window ${new Date(windowStart).toISOString()} .. ${new Date(windowEnd).toISOString()})`,
  );

  return {
    method,
    routePath,
    requestsSent: requestCount,
    successCount,
    errorCount,
    windowStart,
    windowEnd,
  };
}
