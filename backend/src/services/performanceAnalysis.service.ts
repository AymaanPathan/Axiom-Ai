import type { RouteTelemetry } from "./signoz.service.js";
import type { LoadScriptResult } from "./loadScriptRunner.service.js";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const MAX_CODE_CONTEXT_CHARS = 6000;

export interface PerformanceReport {
  rootCause: string;
  severity: "critical" | "warning" | "info";
  evidence: string[];
  suggestedFix: {
    title: string;
    description: string;
    estimatedImprovementPercent: { min: number; max: number };
  };
  diff: { filePath: string; unifiedDiff: string } | null;
  confidence: "high" | "medium" | "low";
  // computed metrics, echoed back so the frontend never has to re-derive them
  computed: ComputedMetrics;
}

interface ComputedMetrics {
  requestsSent: number;
  dbSpansPerRequest: number | null;
  dbTimeSharePercent: number | null; // % of avg request latency spent in DB
  externalSpansPerRequest: number | null;
  externalTimeSharePercent: number | null;
  p95Ms: number | null;
  avgMs: number;
  errorRatePercent: number;
}

// All arithmetic happens here, in code, not in the model. The LLM only
// gets to *narrate* these numbers and propose a fix — this is what keeps
// "97 spans per request" honest instead of a plausible-sounding guess.
function computeMetrics(
  runResult: LoadScriptResult,
  telemetry: RouteTelemetry | null,
): ComputedMetrics {
  const requestsSent = runResult.requestsSent || 1;
  const avgMs = runResult.avgDurationMs;

  let dbSpansPerRequest: number | null = null;
  let dbTimeSharePercent: number | null = null;
  let externalSpansPerRequest: number | null = null;
  let externalTimeSharePercent: number | null = null;

  if (telemetry) {
    if (telemetry.db.callCount > 0) {
      dbSpansPerRequest = telemetry.db.callCount / requestsSent;
      const dbTimePerRequest =
        dbSpansPerRequest * (telemetry.db.avgDurationMs ?? 0);
      dbTimeSharePercent = avgMs > 0 ? (dbTimePerRequest / avgMs) * 100 : null;
    }
    if (telemetry.external.callCount > 0) {
      externalSpansPerRequest = telemetry.external.callCount / requestsSent;
      const extTimePerRequest =
        externalSpansPerRequest * (telemetry.external.avgDurationMs ?? 0);
      externalTimeSharePercent =
        avgMs > 0 ? (extTimePerRequest / avgMs) * 100 : null;
    }
  }

  return {
    requestsSent: runResult.requestsSent,
    dbSpansPerRequest:
      dbSpansPerRequest !== null
        ? Math.round(dbSpansPerRequest * 10) / 10
        : null,
    dbTimeSharePercent:
      dbTimeSharePercent !== null ? Math.round(dbTimeSharePercent) : null,
    externalSpansPerRequest:
      externalSpansPerRequest !== null
        ? Math.round(externalSpansPerRequest * 10) / 10
        : null,
    externalTimeSharePercent:
      externalTimeSharePercent !== null
        ? Math.round(externalTimeSharePercent)
        : null,
    p95Ms: runResult.p95DurationMs,
    avgMs,
    errorRatePercent: Math.round(runResult.errorRate * 1000) / 10,
  };
}

function buildPrompt(
  metadata: { method: string; routePath: string },
  metrics: ComputedMetrics,
  codeContext: string,
): string {
  return `You are a senior performance engineer reviewing a load test. Respond with ONLY raw JSON matching this exact TypeScript shape — no markdown fences, no prose outside the JSON:

{
  "rootCause": string,          // one sentence, specific, e.g. "N+1 query pattern in the order controller"
  "severity": "critical" | "warning" | "info",
  "evidence": string[],         // 2-4 short bullet strings, MUST use the exact numbers given below verbatim, never invent new numbers
  "suggestedFix": {
    "title": string,            // e.g. "Batch product lookups with a single query"
    "description": string,      // 2-4 sentences, concrete, referencing the actual code below
    "estimatedImprovementPercent": { "min": number, "max": number }
  },
  "diff": { "filePath": string, "unifiedDiff": string } | null,  // a real unified diff (@@ hunks, -/+ lines) against the ACTUAL code shown below. null only if no code-level fix applies (e.g. the bottleneck is external/network, not this codebase).
  "confidence": "high" | "medium" | "low"
}

Endpoint: ${metadata.method} ${metadata.routePath}

MEASURED METRICS (ground truth — do not contradict or recompute these, just cite them in evidence):
- Requests sent: ${metrics.requestsSent}
- Avg request latency: ${metrics.avgMs.toFixed(0)} ms
- P95 latency: ${metrics.p95Ms !== null ? `${metrics.p95Ms.toFixed(0)} ms` : "not available"}
- Error rate: ${metrics.errorRatePercent}%
- DB spans per request: ${metrics.dbSpansPerRequest ?? "not available"}
- % of request time in DB calls: ${metrics.dbTimeSharePercent !== null ? `${metrics.dbTimeSharePercent}%` : "not available"}
- External/API calls per request: ${metrics.externalSpansPerRequest ?? "not available"}
- % of request time in external calls: ${metrics.externalTimeSharePercent !== null ? `${metrics.externalTimeSharePercent}%` : "not available"}

REAL SOURCE CODE (route -> controller -> service). Base your root cause and diff on THIS code, not a generic guess:
${codeContext.slice(0, MAX_CODE_CONTEXT_CHARS)}

Rules:
1. If DB spans-per-request is much greater than 1 (e.g. >5) and the code shows a loop calling a DB method per iteration (a for/forEach/map/Promise.all over an array, with an await inside), that is an N+1 pattern — name the exact function/query from the code in your rootCause and evidence, not a generic description.
2. If DB spans-per-request is close to 1 but latency is still high, look for missing indexes, oversized payloads, or unbounded queries (no .limit()) in the code instead — don't call it N+1 if it isn't.
3. If external-call time share dominates, the fix is about caching/parallelizing/timeout tuning on that call, not the database.
4. Evidence bullets must each cite a real number from above. Do not fabricate span counts, percentages, or line references not present in the code.
5. The diff must be a minimal, realistic patch to the actual file/function shown — not a rewrite of the whole file.
6. estimatedImprovementPercent should be a defensible range given the % of time share you're eliminating (e.g. if DB is 82% of request time and you're collapsing N calls into 1, 60-80% is defensible; don't invent an unrelated number).`;
}

export async function analyzeLoadTestPerformance(opts: {
  metadata: { method: string; routePath: string };
  runResult: LoadScriptResult;
  telemetry: RouteTelemetry | null;
  codeContext: string;
}): Promise<PerformanceReport> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not configured on the server.");

  const computed = computeMetrics(opts.runResult, opts.telemetry);

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
            "You are a senior performance engineer. You only cite numbers you were given, never invent metrics, and every diff you produce is a real, minimal patch against the exact code shown to you. Respond with raw JSON only, no markdown fences.",
        },
        {
          role: "user",
          content: buildPrompt(opts.metadata, computed, opts.codeContext),
        },
      ],
      temperature: 0.2,
      max_tokens: 1500,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(
      `Groq API error (${response.status}): ${errBody.slice(0, 200)}`,
    );
  }

  const data = await response.json();
  const raw: string | undefined = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error("Groq API returned no analysis");

  let parsed: Omit<PerformanceReport, "computed">;
  try {
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\n?/, "")
      .replace(/```$/, "")
      .trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("Failed to parse AI analysis as JSON");
  }

  return { ...parsed, computed };
}
