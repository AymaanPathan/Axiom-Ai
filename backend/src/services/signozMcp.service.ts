// signozMcp.service.ts
//
// Talks to the SigNoz MCP server (deployed by Foundry via casting.yaml's
// `mcp.spec.enabled: true`, listening on :8000 by default) using the MCP
// HTTP transport directly — JSON-RPC 2.0 over a single POST endpoint. No
// SDK dependency; this is a deliberately small client since we only need
// `tools/list` (once, to confirm what's available) and `tools/call`.
//
// Why this exists alongside signoz.service.ts's direct query_range calls:
// the hackathon's SigNoz Field Requirements explicitly call out MCP server
// usage as a scoring factor ("Using the SigNoz MCP server, Query Builder,
// dashboards, and alerts is recommended to maximize your chances of
// winning"). This service is what explain.service.ts and
// performanceAnalysis.service.ts should call FIRST — it lets the LLM
// reasoning about a route's performance go through the same MCP surface a
// human would use with an AI client (e.g. Claude Code's `claude mcp add`
// flow), rather than only ever hitting our own bespoke query layer.
//
// signoz.service.ts's direct query_range functions are NOT being removed —
// they stay as the fallback / the thing MCP itself is likely backed by
// under the hood, and some of our custom aggregate shapes (service-wide
// p50/p95/p99 in one round trip) may not map onto whatever tools the MCP
// server exposes. Keep both; prefer MCP where the tool exists.

const SIGNOZ_MCP_URL =
  process.env.SIGNOZ_MCP_URL || "http://localhost:8000/mcp";
const SIGNOZ_MCP_API_KEY = process.env.SIGNOZ_MCP_API_KEY;

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

// One session per process — the MCP HTTP transport is stateless per call
// for our purposes (we're not streaming), so we just need consistent
// headers on every request. If SigNoz's MCP server starts requiring an
// explicit `initialize` handshake before tools/call, add that call once
// here and cache the result the same way.
async function callMcp<T>(
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  if (!SIGNOZ_MCP_API_KEY) {
    throw new Error(
      "SIGNOZ_MCP_API_KEY is not configured. Create a service-account API key " +
        "in SigNoz (Settings → Service Accounts, Admin role required) and set " +
        "it in the backend .env.",
    );
  }

  const body: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: ++requestCounter,
    method,
    params,
  };

  const response = await fetch(SIGNOZ_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "SIGNOZ-API-KEY": SIGNOZ_MCP_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(
      `SigNoz MCP server error (${response.status}): ${errText.slice(0, 300)}`,
    );
  }

  const data = (await response.json()) as JsonRpcResponse<T>;
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
// runtime, and every call site (explain, analysis, metrics-observer) would
// otherwise re-fetch it on every request.
let toolsCache: McpTool[] | null = null;

export async function listSignozMcpTools(): Promise<McpTool[]> {
  if (toolsCache) return toolsCache;
  const result = await callMcp<{ tools: McpTool[] }>("tools/list");
  toolsCache = result.tools;
  return toolsCache;
}

// Finds a tool by exact name, or by substring match against name/description
// as a fallback — useful during development while you're still discovering
// exactly what the SigNoz MCP server calls its tools (run listSignozMcpTools
// once against your live instance and log the names; hardcode the exact
// name here once you know it, and drop the fuzzy fallback).
export async function findSignozMcpTool(
  nameOrHint: string,
): Promise<McpTool | undefined> {
  const tools = await listSignozMcpTools();
  return (
    tools.find((t) => t.name === nameOrHint) ??
    tools.find(
      (t) =>
        t.name.toLowerCase().includes(nameOrHint.toLowerCase()) ||
        t.description?.toLowerCase().includes(nameOrHint.toLowerCase()),
    )
  );
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

// Convenience wrapper: extracts plain text out of a tool result the way
// callers in explain.service.ts / performanceAnalysis.service.ts want it —
// most MCP tool results come back as a list of content blocks, usually one
// `{ type: "text", text: "..." }` block for query-style tools.
export function extractMcpText(result: McpToolCallResult): string {
  return result.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

// High-level helper matching the shape explain.service.ts / metrics-
// observer.service.ts already use elsewhere in this codebase: give it a
// service + route + window, get back readable telemetry text. Tries MCP
// first; throws if no matching tool is found so the caller can fall back
// to signoz.service.ts's direct query_range path.
export async function getRouteTelemetryViaMcp(
  serviceName: string,
  method: string,
  routePath: string,
  startMs: number,
  endMs: number,
): Promise<string> {
  // Adjust "query" to whatever the actual tool name is once you've run
  // listSignozMcpTools() against your deployment — SigNoz's MCP tool
  // catalog is still evolving, common candidates are things like
  // "query_traces", "search_traces", or a generic "run_query" tool backed
  // by the same Query Builder used in the UI.
  const tool = await findSignozMcpTool("trace");
  if (!tool) {
    throw new Error(
      "No SigNoz MCP tool found matching 'trace' — run listSignozMcpTools() " +
        "and check the actual tool names exposed by your MCP server version.",
    );
  }

  const result = await callSignozMcpTool(tool.name, {
    service: serviceName,
    method,
    route: routePath,
    start: startMs,
    end: endMs,
  });

  return extractMcpText(result);
}
