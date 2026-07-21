import { getIO } from "../config/socket.js";
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
  repositoryId: string; // NEW — needed to know which socket room to emit into
  appPort: number;
  method: string;
  routePath: string;
  repoRoot: string;
  routeFile: string;
  routeLine: number;
  requestCount?: number;
  errorInjectionRate?: number;
}

// ...guessValueForField / buildFillerBody unchanged...

const DEBUG = process.env.SIGNOZ_DEBUG !== "false";
function debugLog(...args: unknown[]): void {
  if (DEBUG) console.log("[Traffic]", ...args);
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
  if (lower.endsWith("id")) return "64b7f3f1c2a1d2e3f4a5b6c7";
  if (lower.includes("name")) return "Test Item";
  return "test-value";
}

function buildFillerBody(fields: string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of fields) body[field] = guessValueForField(field);
  return body;
}

async function sendOneRequest(
  baseUrl: string,
  method: string,
  routePath: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; responseBody: string | null }> {
  const url = `${baseUrl}${routePath}`;
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    // Read the body so the live log can show *why* a request failed —
    // this is what would have shown you the 400's actual error message
    // instead of just the status code.
    let responseBody: string | null = null;
    try {
      responseBody = (await res.text()).slice(0, 500);
    } catch {
      // ignore body-read failures
    }
    debugLog(
      method,
      url,
      "->",
      res.status,
      body ? `body: ${JSON.stringify(body)}` : "(no body)",
    );
    return { ok: res.ok, status: res.status, responseBody };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    debugLog(method, url, "-> REQUEST FAILED:", message);
    return { ok: false, status: 0, responseBody: message };
  }
}

export async function generateTrafficForRoute({
  repositoryId,
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
  const io = getIO();
  const room = `repo:${repositoryId}`;

  const emitLog = (payload: object) => io.to(room).emit("traffic:log", payload);
  const emitProgress = (payload: object) =>
    io.to(room).emit("traffic:progress", payload);

  debugLog(`Starting burst: ${requestCount}x ${method} ${baseUrl}${routePath}`);
  emitProgress({
    status: "starting",
    method,
    routePath,
    total: requestCount,
    sent: 0,
  });

  let requestBodyFields: string[] = [];
  if (method !== "GET" && method !== "DELETE") {
    try {
      const resolved = await resolveConnectedFiles(
        repoRoot,
        routeFile,
        routeLine,
      );
      requestBodyFields = resolved.requestBodyFields;
    } catch {
      // fall through bodyless
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
          ? {}
          : buildFillerBody(requestBodyFields)
        : undefined;

    const result = await sendOneRequest(baseUrl, method, routePath, body);
    if (result.ok) successCount++;
    else errorCount++;

    // NEW — this is the line that actually gives you visibility.
    // Every single request, as it happens, streams to the frontend.
    emitLog({
      index: i + 1,
      total: requestCount,
      method,
      routePath,
      status: result.status,
      ok: result.ok,
      responseBody: result.ok ? null : result.responseBody,
      timestamp: Date.now(),
    });
    emitProgress({
      status: "running",
      method,
      routePath,
      total: requestCount,
      sent: i + 1,
      successCount,
      errorCount,
    });

    await new Promise((resolve) =>
      setTimeout(resolve, 80 + Math.random() * 150),
    );
  }

  const windowEnd = Date.now();
  emitProgress({
    status: "done",
    method,
    routePath,
    total: requestCount,
    sent: requestCount,
    successCount,
    errorCount,
  });

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
