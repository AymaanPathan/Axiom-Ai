import { resolveConnectedFiles } from "../parsing/connectedFiles.service.js";
import {
  listSignozMcpTools,
  callSignozMcpTool,
  extractMcpText,
  type McpTool,
} from "./signozMcp.service.js";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

const explanationCache = new Map<string, string>();

const MAX_AGENT_TURNS = 4; // hard ceiling so a confused model can't loop forever / burn the free tier

// Same guard as loadScriptGenerator.service.ts / performanceAnalysis.service.ts
// — without it, a route with a long controller->service chain sends the full
// concatenated codeContext to Groq and blows past the free tier's 12000 TPM
// limit (413 Request too large). This is on top of, not instead of, keeping
// MAX_AGENT_TURNS low — a truncated-but-still-large context can still add up
// across a multi-turn tool-calling loop.
const MAX_CODE_CONTEXT_CHARS = 6000;

// --- MCP tool schema -> Groq/OpenAI function-calling schema ---------------
// Groq's tool-calling format is OpenAI-compatible. MCP's tools/list already
// gives us {name, description, inputSchema} — inputSchema IS a JSON Schema
// object, so this is a rename, not a translation.
async function getGroqToolsFromMcp(): Promise<
  {
    type: "function";
    function: { name: string; description?: string; parameters: unknown };
  }[]
> {
  try {
    const tools: McpTool[] = await listSignozMcpTools();
    return tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema ?? { type: "object", properties: {} },
      },
    }));
  } catch (err) {
    // No MCP server reachable — proceed with zero tools rather than fail
    // the whole explanation. Same "enrichment, not dependency" contract
    // the old tryGetMcpTelemetryContext had.
    console.warn(
      "[Explain] Could not load SigNoz MCP tools, proceeding without live telemetry:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

interface GroqMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
  name?: string;
}

async function callGroq(
  messages: GroqMessage[],
  tools: Awaited<ReturnType<typeof getGroqToolsFromMcp>>,
): Promise<{ message: GroqMessage }> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GROQ_API_KEY is not configured on the server. Get a free key at console.groq.com and set it in the backend .env.",
    );
  }

  const response = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
      temperature: 0.3,
      max_tokens: 500,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(
      `Groq API error (${response.status}): ${errBody.slice(0, 200)}`,
    );
  }

  const data = await response.json();
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error("Groq API returned no message");
  return { message };
}

// Runs the actual agentic loop: Groq decides which SigNoz MCP tool(s) to
// call, we execute them for real via callSignozMcpTool, feed results back,
// and let it keep going (or stop) until it produces a final answer with no
// more tool_calls. This is the "LLM reasons -> SigNoz MCP -> LLM reasons"
// loop from the diagram, not a fixed 3-call fetch.
async function runExplainAgent(
  codeContext: string,
  requestBodyFields: string[],
  routeContext?: { serviceName: string; method: string; routePath: string },
): Promise<string> {
  const tools = await getGroqToolsFromMcp();

  const systemPrompt =
    "You are a product-savvy translator who explains what backend features do in plain business language for non-technical stakeholders. You never use code terminology, function names, or technical jargon — you describe the real-world use case and outcome only." +
    (tools.length > 0
      ? " You have tools available to look up this endpoint's real recent traffic in SigNoz (request volume, error rate, latency). Use them if live traffic context would make the explanation more concrete (e.g. 'this gets used constantly' vs 'this is rarely triggered'), but it's fine to skip them if the code alone is enough."
      : "");

  const userPrompt = `You're explaining what a backend API endpoint is FOR to someone non-technical — a product manager, a founder, a new hire — not a developer reading the code. They don't care about functions, files, variables, or syntax. They want to know what real-world thing this powers.

Here is the code behind the endpoint, for your own understanding only — do not describe it, quote it, or mention file names, function names, or code structure in your answer${
    codeContext.length > MAX_CODE_CONTEXT_CHARS
      ? " (truncated — treat it as a representative excerpt, not the complete implementation)"
      : ""
  }:

${codeContext.slice(0, MAX_CODE_CONTEXT_CHARS)}

${requestBodyFields.length > 0 ? `The data it works with includes: ${requestBodyFields.join(", ")}` : ""}

${
  routeContext
    ? `If you want live traffic context, this endpoint is ${routeContext.method} ${routeContext.routePath} on the "${routeContext.serviceName}" service. Use a tool to check the last 15 minutes if it would help.`
    : ""
}

Write a short explanation, 3-5 sentences, in plain business language, covering:
1. What real-world action or use case this powers (e.g. "a customer checking out their cart", "an admin approving a refund") — describe it as a scenario, not a code operation
2. Who would trigger this and when, in a normal product flow
3. What the business outcome is once it succeeds (what changes for the user or the business)
4. Anything a non-technical stakeholder would care about — e.g. money moving, an order being placed, an email going out, access being granted or denied

Do not mention: functions, methods, endpoints, files, variables, request/response objects, HTTP, JSON, or any code terminology. Write it the way you'd explain the feature to someone in a product meeting.`;

  const messages: GroqMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    const { message } = await callGroq(messages, tools);

    if (!message.tool_calls || message.tool_calls.length === 0) {
      // Final answer — no more tools requested.
      if (!message.content) throw new Error("Groq API returned no explanation");
      return message.content;
    }

    // Model wants data. Record its request, then actually run each tool
    // call against the real MCP server and feed the results back.
    messages.push({
      role: "assistant",
      content: message.content ?? null,
      tool_calls: message.tool_calls,
    });

    for (const call of message.tool_calls) {
      let resultText: string;
      try {
        const args = JSON.parse(call.function.arguments || "{}");
        const result = await callSignozMcpTool(call.function.name, args);
        resultText = extractMcpText(result) || "(no data returned)";
      } catch (err) {
        // Failed tool call becomes a tool message the model can see and
        // reason around (e.g. "telemetry unavailable, proceeding on code
        // alone") rather than crashing the whole explanation.
        resultText = `Error calling ${call.function.name}: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: resultText,
      });
    }
  }

  throw new Error(
    `SigNoz MCP agent did not produce a final answer within ${MAX_AGENT_TURNS} turns`,
  );
}

export async function explainEndpoint(
  repoRoot: string,
  repositoryId: string,
  file: string,
  line: number,
  routeContext?: { serviceName: string; method: string; routePath: string },
): Promise<string> {
  const cacheKey = `${repositoryId}:${file}:${line}`;
  const cached = explanationCache.get(cacheKey);
  if (cached) return cached;

  const { files, requestBodyFields } = await resolveConnectedFiles(
    repoRoot,
    file,
    line,
  );

  const codeContext = files
    .map((f) => `// ${f.path} (${f.role})\n${f.content}`)
    .join("\n\n");

  const explanation = await runExplainAgent(
    codeContext,
    requestBodyFields,
    routeContext,
  );

  explanationCache.set(cacheKey, explanation);
  return explanation;
}
