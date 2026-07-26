// signozMcp.service.ts
//
// Client for the official SigNoz MCP server (github.com/SigNoz/signoz-mcp-server),
// run locally via Docker against your self-hosted SigNoz instance. Talks MCP
// over HTTP — JSON-RPC 2.0 POSTed to a single /mcp endpoint. No SDK
// dependency; we only need `tools/list` (once, for a startup sanity check)
// and `tools/call`.
//
// --- Local setup (SigNoz already running via Docker) ----------------------
//
//   docker run -p 8000:8000 \
//     -e TRANSPORT_MODE=http \
//     -e MCP_SERVER_PORT=8000 \
//     -e SIGNOZ_URL=http://host.docker.internal:8080 \
//     -e SIGNOZ_API_KEY=<key from SigNoz Settings -> API Keys, Admin role> \
//     signoz/signoz-mcp-server:latest
//
// SIGNOZ_URL is resolved *inside the MCP server's own container* —
// `localhost` there means "this container," not your host. Point it at
// `host.docker.internal` (Docker Desktop) or your SigNoz container's
// name/IP if both are on the same Docker network. If you're on the old
// pre-Foundry docker-compose install, SigNoz's UI/API port is 3301, not
// 8080 — check `docker ps` for whatever port is actually mapped.
//
// With the key set server-side like above (the server README's "Option A"),
// this backend needs nothing but the URL:
//
//   SIGNOZ_MCP_URL=http://localhost:8000/mcp
//
// SIGNOZ_MCP_API_KEY below is only needed if you instead run the MCP server
// WITHOUT SIGNOZ_API_KEY and want this client to send the key per-request
// via the SIGNOZ-API-KEY header ("Option B" in the server's README).
//
// --- Why this exists alongside signoz.service.ts's direct query_range calls ---
// The hackathon's SigNoz Field Requirements call out MCP server usage as a
// scoring factor. This service is what explain.service.ts and
// performanceAnalysis.service.ts should call FIRST — it lets the LLM reason
// about a route's performance through the same MCP surface a human would
// use with an AI client, rather than only ever hitting our own bespoke
// query layer. signoz.service.ts's direct query_range functions stay as
// the fallback: some of our custom aggregate shapes (service-wide
// p50/p95/p99 in one round trip) don't map cleanly onto individual MCP
// tool calls. Keep both; prefer MCP where a tool covers the need.

const SIGNOZ_MCP_URL =
  process.env.SIGNOZ_MCP_URL || "http://localhost:8000/mcp";
const SIGNOZ_MCP_API_KEY = process.env.SIGNOZ_MCP_API_KEY; // optional, see above

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolCallResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
}

let requestCounter = 0;

function baseHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  // Only needed if the MCP server was started WITHOUT SIGNOZ_API_KEY
  // (Option B — key travels with the client instead).
  if (SIGNOZ_MCP_API_KEY) {
    headers["SIGNOZ-API-KEY"] = SIGNOZ_MCP_API_KEY;
  }
  return headers;
}

// The Streamable HTTP transport (MCP spec 2025-03-26+) lets a server reply
// either as plain `application/json` or as `text/event-stream` — one or more
// `event: message\ndata: {...}\n\n` blocks. Our server does the latter (you
// can see it in your own curl output). This pulls the JSON-RPC payload out
// of either shape and, for SSE, returns the specific `data:` block whose
// `id` matches the request we sent (a stream can carry more than one event,
// e.g. progress notifications ahead of the final response).
async function parseJsonRpcResponse<T>(
  response: Response,
  expectedId: number,
): Promise<JsonRpcResponse<T>> {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return (await response.json()) as JsonRpcResponse<T>;
  }

  // text/event-stream (or unspecified — some proxies strip content-type)
  const raw = await response.text();
  const dataLines = raw
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);

  for (const line of dataLines) {
    try {
      const parsed = JSON.parse(line) as JsonRpcResponse<T>;
      if (parsed.id === expectedId) return parsed;
    } catch {
      // not JSON (or a non-response notification like "ping") — skip it
    }
  }

  throw new Error(
    `SigNoz MCP server: no JSON-RPC response for request id ${expectedId} found in SSE stream ` +
      `(got ${dataLines.length} event(s) — likely only keep-alive pings).`,
  );
}

// --- session handling ---------------------------------------------------
// The MCP spec allows a Streamable HTTP server to be session-based (via an
// `Mcp-Session-Id` response header from `initialize`) OR fully stateless —
// answering each POST independently with no session at all. Confirmed
// against this exact deployment: `initialize` comes back `200 OK`,
// `Content-Type: application/json`, full result, NO `Mcp-Session-Id`
// header. So: try once, keep the id if the server ever gives one, but
// never require it. If a session id shows up later, it rides along; if
// not, calls just go out without it — which is what this server expects.
let sessionId: string | null | undefined = undefined; // undefined = not yet attempted
let initPromise: Promise<string | null> | null = null;

async function initializeSession(): Promise<string | null> {
  const initBody: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: ++requestCounter,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "axiom-backend", version: "1.0.0" },
    },
  };

  const response = await fetch(SIGNOZ_MCP_URL, {
    method: "POST",
    headers: baseHeaders(),
    body: JSON.stringify(initBody),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(
      `SigNoz MCP initialize failed (${response.status}): ${errText.slice(0, 300)}. ` +
        `Is the MCP server container running and reachable at ${SIGNOZ_MCP_URL}?`,
    );
  }

  const id = response.headers.get("mcp-session-id");
  if (id) {
    // Only needed if the server is actually session-based — a stateless
    // server has no session to acknowledge.
    await fetch(SIGNOZ_MCP_URL, {
      method: "POST",
      headers: { ...baseHeaders(), "Mcp-Session-Id": id },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
  }

  return id; // null if this server is stateless (our case)
}

async function getSessionId(): Promise<string | null> {
  if (sessionId !== undefined) return sessionId;
  if (!initPromise) {
    initPromise = initializeSession()
      .then((id) => {
        sessionId = id;
        return id;
      })
      .finally(() => {
        initPromise = null;
      });
  }
  return initPromise;
}

async function callMcp<T>(
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const session = await getSessionId();
  const id = ++requestCounter;
  const body: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

  const headers: Record<string, string> = { ...baseHeaders() };
  if (session) headers["Mcp-Session-Id"] = session;

  const response = await fetch(SIGNOZ_MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(
      `SigNoz MCP server error (${response.status}): ${errText.slice(0, 300)}. ` +
        `Is the MCP server container running and reachable at ${SIGNOZ_MCP_URL}?`,
    );
  }

  const data = await parseJsonRpcResponse<T>(response, id);
  if (data.error) {
    throw new Error(
      `SigNoz MCP error ${data.error.code}: ${data.error.message}`,
    );
  }
  if (data.result === undefined) {
    throw new Error("SigNoz MCP server returned no result");
  }
  return data.result;
}

// Cached after first successful call — the tool list doesn't change at
// runtime.
let toolsCache: McpTool[] | null = null;

export async function listSignozMcpTools(): Promise<McpTool[]> {
  if (toolsCache) return toolsCache;
  const result = await callMcp<{ tools: McpTool[] }>("tools/list");
  toolsCache = result.tools;
  return toolsCache;
}

export async function callSignozMcpTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolCallResult> {
  return callMcp<McpToolCallResult>("tools/call", {
    name: toolName,
    arguments: args,
  });
}

export function extractMcpText(result: McpToolCallResult): string {
  return result.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

// --- Typed wrappers over the tools this codebase actually uses ------------
// Full catalog: github.com/SigNoz/signoz-mcp-server#available-tools.
// Add wrappers here as you reach for more of it (signoz_search_logs,
// signoz_list_alert_rules, etc.) rather than calling callSignozMcpTool raw
// from other services — keeps the tool-name strings in one place.

export interface AggregateTracesArgs {
  aggregation: "count" | "avg" | "sum" | "min" | "max" | "p50" | "p95" | "p99";
  aggregateOn?: string; // e.g. "duration_nano" — confirmed field name from the tool's own schema. Required for everything but count/rate.
  groupBy?: string;
  filter?: string;
  service?: string;
  operation?: string;
  error?: boolean;
  orderBy?: string;
  limit?: number;
  start?: number; // ms
  end?: number; // ms
  timeRange?: string; // e.g. "15m" — ignored if start/end given
}

export async function signozAggregateTraces(
  args: AggregateTracesArgs,
): Promise<string> {
  const result = await callSignozMcpTool("signoz_aggregate_traces", {
    ...args,
  });
  return extractMcpText(result);
}

export interface SearchTracesArgs {
  filter?: string;
  service?: string;
  operation?: string;
  error?: boolean;
  limit?: number;
  start?: number;
  end?: number;
  timeRange?: string;
}

export async function signozSearchTraces(
  args: SearchTracesArgs,
): Promise<string> {
  const result = await callSignozMcpTool("signoz_search_traces", { ...args });
  return extractMcpText(result);
}

export async function signozListServices(timeRange = "15m"): Promise<string> {
  const result = await callSignozMcpTool("signoz_list_services", {
    timeRange,
  });
  return extractMcpText(result);
}

// --- field discovery --------------------------------------------------
// We used to hardcode `http_method` as "confirmed" because it showed up in
// the MCP server's own example docs — but a docs example isn't the same as
// a field that actually exists on THIS workspace's spans, and it silently
// broke telemetry the same way an unverified `durationNano` vs
// `duration_nano` guess once did in signoz.service.ts. Route discovery
// already did this properly (ask signoz_get_field_keys, cache the answer,
// degrade gracefully); this generalizes that same pattern so "method" and
// "service" get the same live verification instead of a hardcoded guess.
const fieldKeyCache = new Map<string, string | null>();
const fieldKeyInFlight = new Map<string, Promise<string | null>>();

async function discoverFieldKey(
  searchText: string,
  preferExact?: string,
): Promise<string | null> {
  if (fieldKeyCache.has(searchText)) return fieldKeyCache.get(searchText)!;
  const pending = fieldKeyInFlight.get(searchText);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const result = await callSignozMcpTool("signoz_get_field_keys", {
        signal: "traces",
        searchText,
      });
      const text = extractMcpText(result);
      // Response shape isn't pinned down in the schema (just "field keys"),
      // so parse defensively: try JSON first, fall back to a regex scan of
      // the raw text for anything matching.
      let key: string | null = null;
      try {
        const parsed = JSON.parse(text);
        // Confirmed shape (curl against a live server):
        // { status: "success", data: { keys: { "<fieldName>": [{ name, signal, fieldContext, fieldDataType }], ... }, complete } }
        // `keys` is an object keyed by field name, each mapped to an array of
        // context entries (usually one — multiple means the name is ambiguous
        // across contexts, e.g. both a resource attr and a span attr).
        const keysObj: Record<string, unknown> = parsed?.data?.keys ?? {};
        const names = Object.keys(keysObj);
        key =
          (preferExact && names.find((n) => n === preferExact)) ??
          names.find((n) => new RegExp(searchText, "i").test(n)) ??
          null;
      } catch {
        const pattern = new RegExp(`[a-zA-Z_.]*${searchText}[a-zA-Z_.]*`, "i");
        const match = text.match(pattern);
        key = match ? match[0] : null;
      }
      fieldKeyCache.set(searchText, key);
      return key;
    } catch (err) {
      console.warn(
        `[SigNozMCP] field discovery for "${searchText}" failed, keeping fallback:`,
        err instanceof Error ? err.message : err,
      );
      fieldKeyCache.set(searchText, null);
      return null;
    } finally {
      fieldKeyInFlight.delete(searchText);
    }
  })();

  fieldKeyInFlight.set(searchText, promise);
  return promise;
}

async function discoverRouteFieldKey(): Promise<string | null> {
  return discoverFieldKey("route", "http.route");
}

/** Live-verifies the real "http method" filter key for this workspace's
 * traces instead of trusting the (previously hardcoded, unverified)
 * `http_method` guess. Falls back to null on failure — callers should keep
 * their existing hardcoded guess as the fallback, same "enrichment, not
 * dependency" contract as route discovery. */
export async function discoverMethodFieldKey(): Promise<string | null> {
  return discoverFieldKey("method", "http.method");
}

/** Same idea as discoverMethodFieldKey, for the service-name attribute
 * (previously hardcoded as `service.name` with a comment flagging it as
 * "not yet independently verified"). */
export async function discoverServiceFieldKey(): Promise<string | null> {
  return discoverFieldKey("service", "service.name");
}

// --- High-level helper used by explain.service.ts / metrics-observer.service.ts ---
//
// Give it a service + route + window, get back readable telemetry text:
// request count, error count, and p95 latency, pulled through MCP instead
// of our own query_range client. Best-effort by design — callers already
// wrap this in try/catch and treat it as enrichment, not a dependency (see
// explain.service.ts's tryGetMcpTelemetryContext).
export async function getRouteTelemetryViaMcp(
  serviceName: string,
  method: string,
  routePath: string,
  startMs: number,
  endMs: number,
): Promise<string> {
  const [routeKey, discoveredMethodKey] = await Promise.all([
    discoverRouteFieldKey(),
    discoverMethodFieldKey(),
  ]);
  // "http.method" is our last-resort fallback — confirmed via
  // signoz_get_field_values to actually carry real values (GET/OPTIONS/POST)
  // on this workspace's spans. "http_method" (no dot) is a derived/legacy
  // field this SigNoz version defines but never populates here — do not
  // revert to it. Still prefer whatever signoz_get_field_keys discovers
  // live, since a different workspace could differ.
  const methodKey = discoveredMethodKey ?? "http.method";
  const escapedMethod = method.replace(/'/g, "\\'");
  const escapedRoute = routePath.replace(/'/g, "\\'");

  // Degrades to service+method-only if no route field was discoverable —
  // still useful (whole-service traffic shape), just not route-scoped.
  const filter = routeKey
    ? `${methodKey} = '${escapedMethod}' AND ${routeKey} = '${escapedRoute}'`
    : `${methodKey} = '${escapedMethod}'`;

  const [requestCountText, errorCountText, p95Text] = await Promise.all([
    signozAggregateTraces({
      aggregation: "count",
      service: serviceName,
      filter,
      start: startMs,
      end: endMs,
    }),
    signozAggregateTraces({
      aggregation: "count",
      service: serviceName,
      filter,
      error: true,
      start: startMs,
      end: endMs,
    }),
    signozAggregateTraces({
      aggregation: "p95",
      aggregateOn: "duration_nano",
      service: serviceName,
      filter,
      start: startMs,
      end: endMs,
    }),
  ]);

  const windowMinutes = Math.round((endMs - startMs) / 60_000);
  const scopeNote = routeKey
    ? ""
    : ` (route-level filtering unavailable — this is whole-service traffic for ${method}, not scoped to ${routePath})`;
  return [
    `Live traffic for ${method} ${routePath} on "${serviceName}" over the last ${windowMinutes} minute(s)${scopeNote}:`,
    `- request count: ${requestCountText || "0"}`,
    `- error count: ${errorCountText || "0"}`,
    `- p95 latency (ns): ${p95Text || "n/a"}`,
  ].join("\n");
}
