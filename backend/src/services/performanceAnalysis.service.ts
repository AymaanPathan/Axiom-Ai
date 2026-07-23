import type { DbOperationBreakdown, RouteTelemetry } from "./signoz.service.js";
import type { LoadScriptResult } from "./loadScriptRunner.service.js";
import { buildDisplayDiff } from "./codePatch.service.js";

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
  diff: {
    filePath: string;
    originalCode: string;
    newCode: string;
    unifiedDiff: string; // display-only, generated locally from the two snippets above
  } | null;
  confidence: "high" | "medium" | "low";
  // computed metrics, echoed back so the frontend never has to re-derive them
  computed: ComputedMetrics;
}

interface ComputedMetrics {
  requestsSent: number;
  dbSpansPerRequest: number | null;
  dbTimeSharePercent: number | null; // capped 0-100, safe to show as "% of request time"
  dbCallsOverlap: boolean; // true if raw DB time exceeds request time — usually a sampling-window artifact, NOT evidence of concurrency
  dbCumulativeTimeMs: number | null; // uncapped — total DB span time per request, for the "overlap" label
  externalSpansPerRequest: number | null;
  externalTimeSharePercent: number | null;
  externalCallsOverlap: boolean;
  p95Ms: number | null;
  avgMs: number;
  errorRatePercent: number;
}

function computeMetrics(
  runResult: LoadScriptResult,
  telemetry: RouteTelemetry | null,
): ComputedMetrics {
  const requestsSent = runResult.requestsSent || 1;
  const avgMs = runResult.avgDurationMs;

  let dbSpansPerRequest: number | null = null;
  let dbTimeSharePercent: number | null = null;
  let dbCallsOverlap = false;
  let dbCumulativeTimeMs: number | null = null;

  let externalSpansPerRequest: number | null = null;
  let externalTimeSharePercent: number | null = null;
  let externalCallsOverlap = false;

  if (telemetry) {
    if (telemetry.db.callCount > 0) {
      dbSpansPerRequest = telemetry.db.callCount / requestsSent;
      const dbTimePerRequestRaw =
        dbSpansPerRequest * (telemetry.db.avgDurationMs ?? 0);
      dbCumulativeTimeMs = dbTimePerRequestRaw;
      const rawPercent = avgMs > 0 ? (dbTimePerRequestRaw / avgMs) * 100 : null;
      if (rawPercent !== null && rawPercent > 100) {
        // Cumulative span time exceeding request time is most often a
        // sampling-window mismatch (telemetry pulled from a window that
        // doesn't line up exactly with the completed run), NOT proof
        // that DB calls ran concurrently. Cap it and flag it so the
        // prompt never asserts concurrency the code doesn't actually
        // have — sequential `await`s in a loop are still sequential
        // even if this ratio looks off.
        dbCallsOverlap = true;
        dbTimeSharePercent = 100;
      } else {
        dbTimeSharePercent = rawPercent;
      }
    }
    if (telemetry.external.callCount > 0) {
      externalSpansPerRequest = telemetry.external.callCount / requestsSent;
      const extTimePerRequestRaw =
        externalSpansPerRequest * (telemetry.external.avgDurationMs ?? 0);
      const rawPercent =
        avgMs > 0 ? (extTimePerRequestRaw / avgMs) * 100 : null;
      if (rawPercent !== null && rawPercent > 100) {
        externalCallsOverlap = true;
        externalTimeSharePercent = 100;
      } else {
        externalTimeSharePercent = rawPercent;
      }
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
    dbCallsOverlap,
    dbCumulativeTimeMs:
      dbCumulativeTimeMs !== null ? Math.round(dbCumulativeTimeMs) : null,
    externalSpansPerRequest:
      externalSpansPerRequest !== null
        ? Math.round(externalSpansPerRequest * 10) / 10
        : null,
    externalTimeSharePercent:
      externalTimeSharePercent !== null
        ? Math.round(externalTimeSharePercent)
        : null,
    externalCallsOverlap,
    p95Ms: runResult.p95DurationMs,
    avgMs,
    errorRatePercent: Math.round(runResult.errorRate * 1000) / 10,
  };
}

interface StructuralFinding {
  found: boolean;
  detail?: string; // human-readable description of what was matched, for the prompt
}

// Statistics (spans/request, cumulative time) are noisy at low request
// counts and can't reliably distinguish "sequential loop calling the DB
// per item" from "two unrelated queries" or "concurrent calls". The code
// itself can, structurally: a for/for-of/forEach/map with an `await` in
// its body that calls something DB-shaped. This is checked BEFORE the
// LLM ever sees the code, so the model is told what's structurally true
// rather than asked to eyeball it from a stats summary.
const DB_CALL_HINT = /\b(find(One|ById)?|aggregate|query|exec)\s*\(/i;
const LOOP_PATTERNS = [
  /for\s*\(\s*const\s+\w+\s+of\s+[^)]+\)\s*{([^}]*)}/gs,
  /\.forEach\s*\(\s*(?:async\s*)?\([^)]*\)\s*=>\s*{([^}]*)}/gs,
  /\.map\s*\(\s*async\s*\([^)]*\)\s*=>\s*{([^}]*)}/gs,
];

function detectLoopedDbCall(codeContext: string): StructuralFinding {
  for (const pattern of LOOP_PATTERNS) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(codeContext)) !== null) {
      const body = match[1] ?? "";
      if (/\bawait\b/.test(body) && DB_CALL_HINT.test(body)) {
        const snippet = match[0].slice(0, 200).replace(/\s+/g, " ");
        return { found: true, detail: snippet };
      }
    }
  }
  return { found: false };
}

// The model is not allowed to freely guess an improvement number — that's
// how you get "60-80% faster" promised against a benchmark that only
// moves 8%. Instead we compute the theoretical ceiling ourselves: you
// cannot improve a request by more than the share of its time you're
// actually eliminating. This gets passed to the model as a hard
// instruction and is also enforced again after parsing (see
// clampImprovementEstimate).
function estimateCeiling(
  metrics: ComputedMetrics,
  structural: StructuralFinding,
): number {
  // If the overlap flag fired, the underlying % is unreliable (sampling-
  // window mismatch) — don't let it inflate the ceiling on its own.
  const dbShare = metrics.dbCallsOverlap ? 50 : (metrics.dbTimeSharePercent ?? 0);
  const externalShare = metrics.externalCallsOverlap
    ? 50
    : (metrics.externalTimeSharePercent ?? 0);
  const dominantShare = Math.max(dbShare, externalShare);

  // At low spans-per-request (< 5), even a real structural fix removes
  // relatively few round-trips, so cap more conservatively than a
  // textbook N+1 case regardless of what the % share suggests.
  const lowVolumeFix = (metrics.dbSpansPerRequest ?? 0) < 5;
  const scale = lowVolumeFix ? 0.6 : 0.9;

  return Math.max(5, Math.round(dominantShare * scale));
}

function clampImprovementEstimate(
  estimate: { min: number; max: number },
  metrics: ComputedMetrics,
  structural: StructuralFinding,
): { min: number; max: number } {
  const ceiling = estimateCeiling(metrics, structural);
  const max = Math.min(estimate.max, ceiling);
  const min = Math.min(estimate.min, Math.max(5, max - 15));
  return { min: Math.max(1, min), max: Math.max(min + 1, max) };
}

function buildPrompt(
  metadata: { method: string; routePath: string },
  metrics: ComputedMetrics,
  codeContext: string,
  structural: StructuralFinding,
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
  "diff": { "filePath": string, "originalCode": string, "newCode": string } | null,
  // "originalCode" MUST be copied EXACTLY, character-for-character (including indentation/whitespace),
  // from the source code shown below — a short contiguous snippet (a few lines to ~1 function), not the
  // whole file, and not paraphrased or reformatted in any way. "newCode" is your replacement for that
  // exact snippet. null only if no code-level fix applies (e.g. the bottleneck is external/network, not this codebase).
  "confidence": "high" | "medium" | "low"
}

Endpoint: ${metadata.method} ${metadata.routePath}

MEASURED METRICS (ground truth — do not contradict or recompute these, just cite them in evidence):
- Requests sent: ${metrics.requestsSent}
- Avg request latency: ${metrics.avgMs.toFixed(0)} ms
- P95 latency: ${metrics.p95Ms !== null ? `${metrics.p95Ms.toFixed(0)} ms` : "not available"}
- Error rate: ${metrics.errorRatePercent}%
- DB spans per request: ${metrics.dbSpansPerRequest ?? "not available"}
- ${
    metrics.dbCallsOverlap
      ? `Cumulative DB span time per request: ~${metrics.dbCumulativeTimeMs}ms (this figure exceeds avg request latency — this is a telemetry sampling-window artifact, NOT evidence that DB calls ran concurrently. Do not describe this as "% of request time" and do NOT call the DB calls "concurrent" based on this number alone.)`
      : `% of request time in DB calls: ${metrics.dbTimeSharePercent !== null ? `${metrics.dbTimeSharePercent}%` : "not available"}`
  }
- External/API calls per request: ${metrics.externalSpansPerRequest ?? "not available"}
- % of request time in external calls: ${metrics.externalTimeSharePercent !== null ? `${metrics.externalTimeSharePercent}%` : "not available"}
- MAX DEFENSIBLE IMPROVEMENT ESTIMATE: your estimatedImprovementPercent.max MUST NOT exceed ${estimateCeiling(metrics, structural)}%. This ceiling is computed from the actual measured DB/external time share and the scale of the pattern found — it is not a suggestion, it is a hard cap.

STRUCTURAL CODE EVIDENCE (verified mechanically by scanning the code below, not a guess):
${
  structural.found
    ? `A loop was found that calls an async DB-shaped function inside its body: "${structural.detail}..." — this IS real, verified evidence of a sequential-per-item query pattern. You should treat this as your PRIMARY evidence for the root cause, independent of (and more reliable than) the DB span-count/time statistics above.`
    : `No loop calling a DB function per iteration was detected in the code shown. Do NOT claim a "loop", "N+1", or "sequential per-item queries" pattern exists unless you can point to an actual loop in the code below. If you can't find one, describe whatever the real pattern actually is instead (e.g. "two independent queries with no batching opportunity", "a query missing an index", "an oversized response payload").`
}

REAL SOURCE CODE (route -> controller -> service). Base your root cause and diff on THIS code, not a generic guess:
${codeContext.slice(0, MAX_CODE_CONTEXT_CHARS)}

Rules:
1. A "sequential per-item query loop" or "N+1" root cause is ONLY justified by the STRUCTURAL CODE EVIDENCE section above — never by DB-spans-per-request alone, which is noisy at low request counts and proves nothing on its own. If structural evidence found a loop, cite it as your primary evidence and the root cause. If structural evidence found nothing, do NOT claim a loop, N+1, or "sequential queries in a loop" exists — describe the actual pattern in the code instead. Evidence bullets must never contain a root-cause label that contradicts the structural finding.
2. NEVER use the word "concurrent" to describe DB calls unless the code explicitly uses Promise.all, Promise.allSettled, or otherwise fires multiple queries without awaiting each one individually before starting the next. Sequential await calls inside a loop (the classic N+1 shape) are SEQUENTIAL, not concurrent — describing them as concurrent directly contradicts the code and is never acceptable. If the cumulative DB span time appears to exceed average request latency, do not editorialize about why — just note the two figures side by side without asserting concurrency as an explanation.
3. Statistical evidence (spans/request, cumulative time, % share) should be presented as supporting context for scale/impact, not as the primary justification that a pattern exists — that's what the structural evidence section is for.
4. If DB spans-per-request is close to 1 but latency is still high, look for missing indexes, oversized payloads, or unbounded queries (no .limit()) in the code instead — don't call it N+1 if it isn't.
5. If external-call time share dominates, the fix is about caching/parallelizing/timeout tuning on that call, not the database.
6. Evidence bullets must each cite a real number from above or the structural finding. Do not fabricate span counts, percentages, or line references not present in the code.
7. "originalCode" must be an exact, verbatim substring of the source shown above — copy-paste it, do not retype or reformat it, or the patch cannot be located and applied. Keep it as short as possible while still being unique in the file (a whole function is usually right; the whole file is not).
8. estimatedImprovementPercent must stay within the MAX DEFENSIBLE IMPROVEMENT ESTIMATE given above — do not invent a larger number no matter how convincing the fix seems.
9. If a per-operation DB breakdown is available above, prefer citing the SPECIFIC named operation and its own call count/duration in your evidence (e.g. "Product.find() was called 74 times, averaging 2.1ms each, totaling 155ms") over the generic blended DB average — this is far stronger, more credible evidence than an aggregate number.
`;
}


function formatDbBreakdown(
  breakdown: DbOperationBreakdown[] | undefined,
): string {
  if (!breakdown || breakdown.length === 0) {
    return "Not available — no per-operation breakdown could be retrieved for this run.";
  }
  return breakdown
    .slice(0, 5)
    .map(
      (b) =>
        `- ${b.operation}: called ${b.callCount} times, avg ${b.avgDurationMs}ms, total ${b.totalDurationMs}ms`,
    )
    .join("\n");
}

export async function analyzeLoadTestPerformance(opts: {
  metadata: { method: string; routePath: string };
  runResult: LoadScriptResult;
  telemetry: RouteTelemetry | null;
  codeContext: string;
  dbBreakdown?: DbOperationBreakdown[];
}): Promise<PerformanceReport> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not configured on the server.");

  const computed = computeMetrics(opts.runResult, opts.telemetry);
  const structural = detectLoopedDbCall(opts.codeContext);

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
            "You are a senior performance engineer. You only cite numbers you were given, never invent metrics, never call sequential await calls 'concurrent', never assert a loop/N+1 pattern exists unless the structural evidence you were given confirms it, and every diff you produce is a real, minimal patch against the exact code shown to you. Respond with raw JSON only, no markdown fences.",
        },
        {
          role: "user",
          content: buildPrompt(
            opts.metadata,
            computed,
            opts.codeContext,
            structural,
          ),
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

  let diff = parsed.diff;
  if (diff) {
    const unifiedDiff = buildDisplayDiff(
      diff.filePath,
      diff.originalCode,
      diff.newCode,
    );
    diff = { ...diff, unifiedDiff };
  }

  // Enforce the ceiling server-side too — never trust the model to have
  // actually respected the instruction, since it's exactly this kind of
  // unenforced "be reasonable" ask that produced 60-80% against an 8%
  // real result before.
  const suggestedFix = {
    ...parsed.suggestedFix,
    estimatedImprovementPercent: clampImprovementEstimate(
      parsed.suggestedFix.estimatedImprovementPercent,
      computed,
      structural,
    ),
  };

  return { ...parsed, diff, suggestedFix, computed };
}