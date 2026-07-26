import { resolveConnectedFiles } from "../parsing/connectedFiles.service.js";
import { getRouteTelemetryViaMcp } from "./signozMcp.service.js";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
// Groq's free-tier Llama model — fast and generous rate limits, good fit
// for short "explain this code" completions.
const GROQ_MODEL = "llama-3.3-70b-versatile";

// Explanations don't change unless the underlying code does, so we cache
// per repo+file+line for the life of the process — avoids burning the
// free-tier rate limit re-explaining the same route on every page view.
const explanationCache = new Map<string, string>();

// NEW — pulls live telemetry text via the SigNoz MCP server and folds it
// into the explanation prompt, so "what does this endpoint do" is grounded
// in real recent traffic (request volume, error rate) instead of purely
// static code reading. Best-effort: if MCP isn't reachable, or no matching
// tool exists yet, or there's simply no traffic for this route, explanation
// generation still proceeds without it — this is enrichment, not a
// dependency, so it should never be the reason /explain fails.
async function tryGetMcpTelemetryContext(
  serviceName: string,
  method: string,
  routePath: string,
): Promise<string | null> {
  try {
    const end = Date.now();
    const start = end - 15 * 60 * 1000; // last 15 minutes
    const text = await getRouteTelemetryViaMcp(
      serviceName,
      method,
      routePath,
      start,
      end,
    );
    return text || null;
  } catch (err) {
    console.warn(
      "[Explain] SigNoz MCP telemetry lookup skipped:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

function buildPrompt(
  codeContext: string,
  requestBodyFields: string[],
  mcpTelemetryContext: string | null,
): string {
  return `You're explaining what a backend API endpoint is FOR to someone non-technical — a product manager, a founder, a new hire — not a developer reading the code. They don't care about functions, files, variables, or syntax. They want to know what real-world thing this powers.

Here is the code behind the endpoint, for your own understanding only — do not describe it, quote it, or mention file names, function names, or code structure in your answer:

${codeContext}

${
  requestBodyFields.length > 0
    ? `The data it works with includes: ${requestBodyFields.join(", ")}`
    : ""
}

${
  mcpTelemetryContext
    ? `Recent live traffic for this endpoint (from SigNoz, via its MCP server): ${mcpTelemetryContext}`
    : ""
}

Write a short explanation, 3-5 sentences, in plain business language, covering:
1. What real-world action or use case this powers (e.g. "a customer checking out their cart", "an admin approving a refund") — describe it as a scenario, not a code operation
2. Who would trigger this and when, in a normal product flow
3. What the business outcome is once it succeeds (what changes for the user or the business)
4. Anything a non-technical stakeholder would care about — e.g. money moving, an order being placed, an email going out, access being granted or denied

Do not mention: functions, methods, endpoints, files, variables, request/response objects, HTTP, JSON, or any code terminology. Write it the way you'd explain the feature to someone in a product meeting.`;
}

export async function explainEndpoint(
  repoRoot: string,
  repositoryId: string,
  file: string,
  line: number,
  // NEW — optional. Pass this from call sites that already know the
  // service name + route (RepoDetail / ApiWorkspace both have this on
  // hand already via `repo.githubFullName` and the selected route). When
  // omitted, explain still works exactly as before — just without the
  // live-traffic context folded in.
  routeContext?: { serviceName: string; method: string; routePath: string },
): Promise<string> {
  const cacheKey = `${repositoryId}:${file}:${line}`;
  const cached = explanationCache.get(cacheKey);
  if (cached) return cached;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GROQ_API_KEY is not configured on the server. Get a free key at console.groq.com and set it in the backend .env.",
    );
  }

  const { files, requestBodyFields } = await resolveConnectedFiles(
    repoRoot,
    file,
    line,
  );

  const codeContext = files
    .map((f) => `// ${f.path} (${f.role})\n${f.content}`)
    .join("\n\n");

  const mcpTelemetryContext = routeContext
    ? await tryGetMcpTelemetryContext(
        routeContext.serviceName,
        routeContext.method,
        routeContext.routePath,
      )
    : null;

  const response = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a product-savvy translator who explains what backend features do in plain business language for non-technical stakeholders. You never use code terminology, function names, or technical jargon — you describe the real-world use case and outcome only.",
        },
        {
          role: "user",
          content: buildPrompt(
            codeContext,
            requestBodyFields,
            mcpTelemetryContext,
          ),
        },
      ],
      temperature: 0.3,
      max_tokens: 400,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(
      `Groq API error (${response.status}): ${errBody.slice(0, 200)}`,
    );
  }

  const data = await response.json();
  const explanation: string | undefined = data.choices?.[0]?.message?.content;
  if (!explanation) {
    throw new Error("Groq API returned no explanation");
  }

  explanationCache.set(cacheKey, explanation);
  return explanation;
}
