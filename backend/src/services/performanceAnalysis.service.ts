import type { DbOperationBreakdown, RouteTelemetry } from "./signoz.service.js";
import type { LoadScriptResult } from "./loadScriptRunner.service.js";
import {
  buildDisplayDiff,
  buildCreateDisplayDiff,
} from "./codePatch.service.js";
import ts from "typescript";

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
    unifiedDiff: string;
  } | null;
  confidence: "high" | "medium" | "low";
  computed: ComputedMetrics;
}

interface ComputedMetrics {
  requestsSent: number;
  dbSpansPerRequest: number | null;
  dbTimeSharePercent: number | null;
  dbCallsOverlap: boolean;
  dbCumulativeTimeMs: number | null;
  externalSpansPerRequest: number | null;
  externalTimeSharePercent: number | null;
  externalCallsOverlap: boolean;
  p95Ms: number | null;
  avgMs: number;
  errorRatePercent: number;
}

// ---------------------------------------------------------------------------
// Multi-file strategy types — a strategy can now touch several files, and
// each file change can either modify existing code (snippet replace, same
// as before) or create a brand new file (e.g. a new cache util, a new
// middleware, a new query helper module).
// ---------------------------------------------------------------------------
export type FileChangeType = "modify" | "create";

export interface FileChange {
  filePath: string;
  changeType: FileChangeType;
  originalCode?: string; // present only for "modify"
  newCode: string;
  unifiedDiff: string;
}

export interface OptimizationStrategy {
  id: string; // "A" | "B" | "C"
  title: string;
  approach: string;
  description: string;
  estimatedImprovementPercent: { min: number; max: number };
  changes: FileChange[];
  confidence: "high" | "medium" | "low";
}

export interface StrategyGenerationResult {
  rootCause: string;
  severity: "critical" | "warning" | "info";
  strategies: OptimizationStrategy[]; // always 3 unless Groq truly can't produce any
}

// Raw shape as returned by the model, before validation/enrichment.
interface RawFileChange {
  filePath?: string;
  changeType?: string;
  originalCode?: string;
  newCode?: string;
}
interface RawStrategy {
  id?: string;
  title?: string;
  approach?: string;
  description?: string;
  estimatedImprovementPercent?: { min?: number; max?: number };
  changes?: RawFileChange[];
  confidence?: string;
}
interface RawStrategiesResponse {
  rootCause?: string;
  severity?: string;
  strategies?: RawStrategy[];
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
  detail?: string;
}

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

const NODE_BUILTINS = new Set([
  "assert",
  "buffer",
  "child_process",
  "cluster",
  "crypto",
  "dns",
  "events",
  "fs",
  "http",
  "https",
  "net",
  "os",
  "path",
  "querystring",
  "readline",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "url",
  "util",
  "zlib",
  "worker_threads",
  "perf_hooks",
  "async_hooks",
]);

// Pulls bare package specifiers out of ESM/CJS import statements — used to
// verify a strategy never imports something that isn't actually installed
// in this repo. Relative imports and Node builtins are ignored.
function extractImportedPackages(code: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
    /require\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(code)) !== null) {
      const spec = match[1];
      if (!spec || spec.startsWith(".") || spec.startsWith("/")) continue;
      const bare = spec.replace(/^node:/, "");
      if (NODE_BUILTINS.has(bare)) continue;
      // scoped (@scope/pkg) or plain (pkg/subpath) — keep only the package name
      const pkgName = bare.startsWith("@")
        ? bare.split("/").slice(0, 2).join("/")
        : bare.split("/")[0];
      specifiers.add(pkgName);
    }
  }
  return [...specifiers];
}

// --- new: cross-file export/import consistency check ---------------------
//
// Catches the "renamed getOrdersByUser -> getOrdersByUserWithPagination in
// the service but never touched the controller's import" class of bug.
// Regex-based on purpose — codeContext is a plain concatenated blob, not an
// AST, and this only needs to be a reasonable heuristic since a false
// positive just costs one extra regenerate attempt.

const EXPORT_NAME_PATTERN =
  /export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class|let|var)\s+([A-Za-z0-9_$]+)/g;
const EXPORT_BRACE_PATTERN = /export\s*\{\s*([^}]+)\s*\}/g;

function extractExportedNames(code: string): Set<string> {
  const names = new Set<string>();
  for (const pattern of [EXPORT_NAME_PATTERN, EXPORT_BRACE_PATTERN]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code)) !== null) {
      if (pattern === EXPORT_BRACE_PATTERN) {
        for (const raw of match[1].split(",")) {
          const name = raw
            .trim()
            .split(/\s+as\s+/)[0]
            .trim();
          if (name) names.add(name);
        }
      } else {
        names.add(match[1]);
      }
    }
  }
  return names;
}

// Splits the aggregated codeContext blob back into per-file content, using
// the same "// {path} ({role})" header that resolveConnectedFiles' consumers
// (explain.service.ts, the strategies prompt itself) already write for each
// file when they build codeContext.
function splitCodeContextByFile(codeContext: string): Map<string, string> {
  const map = new Map<string, string>();
  const parts = codeContext.split(/^\/\/ (.+?) \(.+?\)$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const filePath = parts[i].trim();
    const content = parts[i + 1] ?? "";
    map.set(filePath, content);
  }
  return map;
}

// Rejects a strategy that renames/removes an export another file in this
// same code context still references, unless that other file also has a
// change in this same strategy updating it.
function findBrokenExportReferences(
  changes: RawFileChange[],
  codeContext: string,
): string[] {
  const problems: string[] = [];
  const fileMap = splitCodeContextByFile(codeContext);
  const changedPaths = new Set(changes.map((c) => c.filePath));

  for (const change of changes) {
    if (
      change.changeType === "create" ||
      !change.originalCode ||
      !change.newCode
    )
      continue;
    const before = extractExportedNames(change.originalCode);
    const after = extractExportedNames(change.newCode);
    const dropped = [...before].filter((n) => !after.has(n));
    if (dropped.length === 0) continue;

    for (const [otherPath, otherContent] of fileMap) {
      if (otherPath === change.filePath || changedPaths.has(otherPath))
        continue;
      for (const name of dropped) {
        if (new RegExp(`\\b${name}\\b`).test(otherContent)) {
          problems.push(
            `"${change.filePath}" removed/renamed export "${name}", but "${otherPath}" still references it and has no change updating it.`,
          );
        }
      }
    }
  }
  return problems;
}

// --- new: syntax-only pre-check -------------------------------------------
//
// Catches "this doesn't even parse/bind" (stray `return`, mismatched
// braces, top-level `await` under the wrong module target) BEFORE a
// strategy is ever accepted, instead of discovering it when the container
// crashes on boot.
//
// NOTE: this deliberately does NOT use ts.transpileModule. transpileModule
// only runs the parser, not the binder — and TS1108 ("return outside a
// function") and TS1378 ("top-level await") are both binder-level checks,
// so transpileModule silently misses exactly the two bugs from the last
// failed run that this exists to catch. A real (single-file) ts.Program is
// required to get those diagnostics at all.
//
// This only checks a single file in isolation — no other repo files, no
// real lib.d.ts, no module resolution — so it intentionally ignores
// name/type/module-resolution diagnostics (undefined identifiers, missing
// imports, etc: expected here, and already handled by
// findBrokenExportReferences + the "known dependency" check above) and
// only surfaces the small set of structural parse/bind codes below.
const STRUCTURAL_DIAGNOSTIC_CODES = new Set([
  1002, // Unterminated string literal
  1003, // Identifier expected
  1005, // 'x' expected (mismatched braces/parens/etc.)
  1009, // Trailing comma not allowed
  1068, // Unexpected token
  1108, // A 'return' statement can only be used within a function body
  1109, // Expression expected
  1128, // Declaration or statement expected
  1136, // Property assignment expected
  1160, // Unterminated template literal
  1161, // Unterminated regular expression literal
  1375, // 'await' only allowed at top level of a module
  1378, // Top-level 'await' only allowed for es2022+/target es2017+
  1434, // Unexpected keyword or identifier
]);

function findSyntaxErrors(fileContent: string): string[] {
  const virtualFileName = "strategy-check.ts";
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    noResolve: true,
    isolatedModules: true,
    noEmit: true,
    skipLibCheck: true,
    noLib: true,
    types: [],
  };

  const host = ts.createCompilerHost(compilerOptions);
  const originalGetSourceFile = host.getSourceFile;
  host.getSourceFile = (name, ...rest) =>
    name === virtualFileName
      ? ts.createSourceFile(
          virtualFileName,
          fileContent,
          compilerOptions.target ?? ts.ScriptTarget.ES2020,
          true,
          ts.ScriptKind.TS,
        )
      : originalGetSourceFile.call(host, name, ...rest);
  host.readFile = (name) =>
    name === virtualFileName ? fileContent : undefined;
  host.fileExists = (name) => name === virtualFileName;

  const program = ts.createProgram([virtualFileName], compilerOptions, host);
  const diagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ];

  return diagnostics
    .filter(
      (d) =>
        d.category === ts.DiagnosticCategory.Error &&
        STRUCTURAL_DIAGNOSTIC_CODES.has(d.code),
    )
    .map(
      (d) =>
        `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
    );
}

// Heuristic: flags an in-memory cache/store (Map/Set) declared inside a
// function or loop body rather than at module scope. Tracks brace depth
// across the newCode snippet; if `new Map(`/`new Set(` appears while
// depth > 0, it's nested inside something and will be recreated every
// call — i.e. it isn't actually caching anything.
function isCacheDeclaredInsideScope(newCode: string): boolean {
  let depth = 0;
  const CACHE_CTOR = /\bnew\s+(Map|Set)\s*\(/;
  for (const line of newCode.split("\n")) {
    if (CACHE_CTOR.test(line) && depth > 0) return true;
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") depth = Math.max(0, depth - 1);
    }
  }
  return false;
}

// A Redis-backed caching strategy must isolate connection/client setup into
// its own created file(s) rather than inlining `createClient`/`new Redis`
// directly into the modified route/service file — that's what makes it
// "best code" instead of a quick hack. Flags a strategy that mentions Redis
// client construction anywhere but never has a "create" change at all.
const REDIS_CLIENT_CTOR = /createClient\s*\(|new\s+Redis\s*\(/;

function isRedisStrategyMissingFileSplit(changes: RawFileChange[]): boolean {
  const usesRedisClientCtor = changes.some((c) =>
    REDIS_CLIENT_CTOR.test(c.newCode ?? ""),
  );
  if (!usesRedisClientCtor) return false;
  const hasCreatedFile = changes.some((c) => c.changeType === "create");
  return !hasCreatedFile;
}

function estimateCeiling(
  metrics: ComputedMetrics,
  structural: StructuralFinding,
): number {
  const dbShare = metrics.dbCallsOverlap
    ? 50
    : (metrics.dbTimeSharePercent ?? 0);
  const externalShare = metrics.externalCallsOverlap
    ? 50
    : (metrics.externalTimeSharePercent ?? 0);
  const dominantShare = Math.max(dbShare, externalShare);
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

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function cleanJson(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\n?/, "")
    .replace(/```$/, "")
    .trim();
}

// Renders the best-effort SigNoz-MCP live-traffic narrative (see
// tryGetMcpContext in routes.ts / getRouteTelemetryViaMcp in
// signozMcp.service.ts) as its own labeled section in a prompt. Kept as a
// single shared helper since both prompt builders below need the exact
// same framing: this is REAL, currently-happening traffic on the service,
// separate from and not to be confused with the synthetic load-test
// numbers in MEASURED METRICS above it.
function renderMcpSection(mcpContext: string | undefined): string {
  if (!mcpContext) return "";
  return `
LIVE TRAFFIC CONTEXT (via SigNoz MCP — real production/dev traffic, NOT the synthetic load test above):
${mcpContext}

Use this only as supporting context for how "hot" this route actually is outside the load test (e.g. does real
traffic already show elevated latency/errors on this route). Do NOT treat it as a second load-test result and do
NOT average it with the MEASURED METRICS above — they're different traffic sources over different windows.
`;
}

// ---------------------------------------------------------------------------
// analyzeLoadTestPerformance — single-fix flow, unchanged (still one file).
// ---------------------------------------------------------------------------
function buildPrompt(
  metadata: { method: string; routePath: string },
  metrics: ComputedMetrics,
  codeContext: string,
  structural: StructuralFinding,
  mcpContext: string | undefined,
): string {
  return `You are a senior performance engineer reviewing a load test. Respond with ONLY raw JSON matching this exact TypeScript shape — no markdown fences, no prose outside the JSON:

{
  "rootCause": string,
  "severity": "critical" | "warning" | "info",
  "evidence": string[],
  "suggestedFix": {
    "title": string,
    "description": string,
    "estimatedImprovementPercent": { "min": number, "max": number }
  },
  "diff": { "filePath": string, "originalCode": string, "newCode": string } | null,
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
      ? `Cumulative DB span time per request: ~${metrics.dbCumulativeTimeMs}ms (telemetry sampling-window artifact, NOT evidence of concurrent DB calls).`
      : `% of request time in DB calls: ${metrics.dbTimeSharePercent !== null ? `${metrics.dbTimeSharePercent}%` : "not available"}`
  }
- External/API calls per request: ${metrics.externalSpansPerRequest ?? "not available"}
- % of request time in external calls: ${metrics.externalTimeSharePercent !== null ? `${metrics.externalTimeSharePercent}%` : "not available"}
- MAX DEFENSIBLE IMPROVEMENT ESTIMATE: your estimatedImprovementPercent.max MUST NOT exceed ${estimateCeiling(metrics, structural)}%.
${renderMcpSection(mcpContext)}
STRUCTURAL CODE EVIDENCE:
${
  structural.found
    ? `A loop was found calling an async DB-shaped function inside its body: "${structural.detail}..." — treat this as primary evidence.`
    : `No loop calling a DB function per iteration was detected. Do NOT claim a "loop"/"N+1" pattern unless you can point to an actual loop in the code below.`
}

REAL SOURCE CODE (route -> controller -> service):
${codeContext.slice(0, MAX_CODE_CONTEXT_CHARS)}

Rules:
1. A "sequential per-item query loop"/"N+1" root cause is ONLY justified by the STRUCTURAL CODE EVIDENCE above.
2. NEVER call DB calls "concurrent" unless the code explicitly uses Promise.all/allSettled.
3. Statistical evidence supports scale/impact, not existence of a pattern.
4. If DB spans/request is close to 1, look for missing indexes/oversized payloads/unbounded queries instead.
5. If external-call time dominates, the fix is caching/parallelizing/timeout tuning on that call.
6. Evidence bullets must each cite a real number above, the structural finding, or (if present) the live traffic context — never an invented figure.
7. "originalCode" must be an exact, verbatim, UNIQUE substring of the source shown above.
8. estimatedImprovementPercent must stay within the MAX DEFENSIBLE IMPROVEMENT ESTIMATE.
`;
}

export async function analyzeLoadTestPerformance(opts: {
  metadata: { method: string; routePath: string };
  runResult: LoadScriptResult;
  telemetry: RouteTelemetry | null;
  codeContext: string;
  dbBreakdown?: DbOperationBreakdown[];
  knownFilePaths?: string[];
  mcpContext?: string;
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
            "You are a senior performance engineer. You only cite numbers you were given, never invent metrics, never call sequential await calls 'concurrent', never assert a loop/N+1 pattern exists unless the structural evidence confirms it, and every diff you produce is a real, minimal patch against the exact code shown. When live traffic context (via SigNoz MCP) is provided, treat it as real supporting evidence about production behavior, distinct from the synthetic load test. Respond with raw JSON only.",
        },
        {
          role: "user",
          content: buildPrompt(
            opts.metadata,
            computed,
            opts.codeContext,
            structural,
            opts.mcpContext,
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
    parsed = JSON.parse(cleanJson(raw));
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

// ---------------------------------------------------------------------------
// generateOptimizationStrategies — the arena flow. Multi-file, always 3.
// ---------------------------------------------------------------------------

const TARGET_STRATEGY_COUNT = 3;
const MAX_GENERATION_ATTEMPTS = 3;

function buildStrategiesPrompt(
  metadata: { method: string; routePath: string },
  metrics: ComputedMetrics,
  codeContext: string,
  structural: StructuralFinding,
  knownFilePaths: string[],
  existingFilePaths: string[],
  knownDependencies: string[],
  knownEnvVars: string[],
  mcpContext: string | undefined,
  feedback: {
    count: number;
    alreadyAccepted: { title: string; approach: string }[];
    rejectedNotes: string[];
  },
): string {
  const alreadyAcceptedBlock =
    /* unchanged from before */
    feedback.alreadyAccepted.length > 0
      ? `\nSTRATEGIES ALREADY ACCEPTED (do NOT repeat these mechanisms or near-identical patches):\n${feedback.alreadyAccepted
          .map((s) => `- ${s.title} (${s.approach})`)
          .join("\n")}\n`
      : "";

  const rejectedBlock =
    feedback.rejectedNotes.length > 0
      ? `\nPREVIOUS ATTEMPT REJECTIONS (fix these mistakes this time):\n${feedback.rejectedNotes
          .slice(-6)
          .map((n) => `- ${n}`)
          .join("\n")}\n`
      : "";

  return `You are a senior performance engineer. Propose exactly ${feedback.count} GENUINELY DIFFERENT way(s) to fix the
performance problem below — different mechanisms, not variations of the same patch.

Valid mechanism categories (pick only ones that plausibly apply):
- batching: collapse N sequential queries into one query (e.g. $in, batched find)
- caching: introduce a cache layer for repeated reads — often needs a NEW file (see CACHING RULE below)
- aggregation: push computation into the database via an aggregation/pipeline instead of app-side loops
- indexing: add/change an index to remove a full collection scan (only if a scan is evident)
- pagination-or-limit: bound an unbounded query
- parallelization: convert independent sequential awaits into Promise.all (ONLY if calls are truly independent)
- extraction: pull repeated/inline logic into a NEW helper/service module to make a fix like batching or caching cleaner

A strategy can touch MULTIPLE files. Each file change is either:
- "modify": edit an existing file. "originalCode" MUST be an exact, verbatim, UNIQUE substring of the source
  shown below for that file (expand it with more surrounding lines if it isn't unique).
- "create": add a brand new file that does not exist yet. Do NOT set "originalCode" for a create. The filePath
  MUST NOT be one of the existing known files listed below.

KNOWN EXISTING FILES (only these can be targeted with "modify"):
${knownFilePaths.map((f) => `- ${f}`).join("\n")}

ALREADY-INSTALLED NPM DEPENDENCIES (this is the COMPLETE list — nothing else is installed):
${knownDependencies.length > 0 ? knownDependencies.map((d) => `- ${d}`).join("\n") : "(none detected)"}

ALL OTHER EXISTING FILES IN THIS REPO (do NOT "create" any of these — they already exist; use "modify" instead, or pick a genuinely new path):
${existingFilePaths.filter((f) => !knownFilePaths.includes(f)).join("\n")}

ALREADY-CONFIGURED ENV VARS (available at runtime):
${knownEnvVars.length > 0 ? knownEnvVars.map((e) => `- ${e}`).join("\n") : "(none)"}

HARD RULE — NO NEW DEPENDENCIES: any "import"/"require" in a "create" or "modify" file MUST resolve to either
a Node.js builtin (fs, path, crypto, etc.) or a package literally present in the ALREADY-INSTALLED list above.
You cannot add a package to package.json — nothing gets installed beyond what's already there. A strategy that
imports an uninstalled package will be discarded outright.

CACHING RULE: default to an in-memory cache UNLESS a Redis-family package (redis, ioredis) is ALREADY
in the installed-dependencies list above AND a Redis-shaped connection env var (e.g. REDIS_URL, REDIS_HOST)
is ALREADY in the configured-env-vars list above.

HARD SCOPE RULE FOR IN-MEMORY CACHES: the cache variable (e.g. \`const cache = new Map()\`) MUST be declared
at MODULE SCOPE — outside and above any function, handler, or loop — so it persists across requests. NEVER
declare \`new Map()\`/\`new Set()\` inside a request handler, a loop body, or any function that runs per-request;
that resets the cache every call and is not caching at all. If the target file has no suitable module-level
location, use a "create" change to add a small dedicated cache module (e.g. src/utils/cache.ts) exporting
the Map instance and get/set helpers, then "modify" the target file to import and use it.

Example of a CORRECT in-memory modify diff:
  // top of file, module scope
  const productCache = new Map<string, { value: unknown; expiresAt: number }>();
  const PRODUCT_CACHE_TTL_MS = 60_000;
  ...
  // inside the handler/loop — only READS/WRITES the outer cache, never redeclares it
  const cached = productCache.get(item.productId);
  const product = cached && cached.expiresAt > Date.now()
    ? cached.value
    : await getProductById(String(item.productId)).then((p) => {
        productCache.set(item.productId, { value: p, expiresAt: Date.now() + PRODUCT_CACHE_TTL_MS });
        return p;
      });

REDIS FILE-SPLIT RULE (mandatory whenever the Redis conditions above are met): you MUST produce this strategy
as MULTIPLE file changes, never a single inline modify. Specifically:
  1. A "create" change for a dedicated client module, e.g. \`src/lib/redisClient.ts\`, that does ONLY this:
     - imports \`createClient\` from "redis"
     - builds the client from \`process.env.REDIS_URL\` (or the detected Redis env var), never hardcoded
     - connects lazily (connect-on-first-use, memoized promise) or eagerly at module load — pick one and
       handle connection errors so a Redis outage doesn't crash the whole app, just falls through to a live fetch
     - exports the client (or a small getClient()/getCached()/setCached() helper) — nothing else lives in this file
  2. Optionally a second "create" change for a small typed helper module, e.g. \`src/utils/cache.ts\`, wrapping
     get/set/TTL/JSON-serialization logic on top of the client from (1) — keeps call sites clean.
  3. A "modify" change on the actual target file that ONLY imports from (1)/(2) and swaps the direct call
     for a cache-read-through-fallback. It must NOT contain any \`createClient\`, connection logic, or raw
     Redis calls inline — those belong exclusively in the created file(s).
  - filePath for the new file(s) MUST NOT already exist in the repo (check ALL OTHER EXISTING FILES above)
    and MUST NOT collide with another strategy's created files.
  - Always set a TTL on writes (e.g. \`client.set(key, JSON.stringify(value), { EX: 60 })\`).
  - Use node-redis v4+ API only: \`createClient({ url: process.env.REDIS_URL })\` + \`await client.connect()\`
    — never \`new RedisClient()\`, that class doesn't exist.
  - A single-file inline Redis strategy is INVALID and will be discarded — always split as above.
${alreadyAcceptedBlock}${rejectedBlock}
Respond with ONLY raw JSON, no markdown fences:
{
  "rootCause": string,
  "severity": "critical" | "warning" | "info",
  "strategies": [
    {
      "id": string,
      "title": string,
      "approach": one of the category slugs above,
      "description": string,
      "estimatedImprovementPercent": { "min": number, "max": number },
      "changes": [
        {
          "filePath": string,
          "changeType": "modify" | "create",
          "originalCode": string,
          "newCode": string
        }
      ],
      "confidence": "high" | "medium" | "low"
    }
  ]
}

Rules:
1. Every strategy must have at least one entry in "changes".
2. Every "modify" originalCode must be an exact verbatim, UNIQUE substring of the source shown below.
3. Every "create" filePath must be new and not reused across strategies you propose in this response.
4. Only propose a mechanism that is actually applicable to this code.
5. Each strategy's estimatedImprovementPercent.max MUST NOT exceed ${estimateCeiling(metrics, structural)}%.
6. Never call sequential awaits "concurrent". Never claim a loop/N+1 exists unless structural evidence confirms it.
7. Strategies must be meaningfully different — not the same patch reworded, and not a repeat of an already-accepted strategy above.
8. Obey the HARD RULE, HARD SCOPE RULE, CACHING RULE, and REDIS FILE-SPLIT RULE above exactly — a violation gets the whole strategy discarded.
9. If you rename, remove, or change the signature of any exported function/const/class, you MUST include a
   "modify" change for EVERY other file shown in SOURCE that imports or calls it, updating both the import
   statement and every call site to match. Renaming an export without updating its callers elsewhere makes
   the whole strategy invalid and it will be discarded.
10. If LIVE TRAFFIC CONTEXT is present below, you may use it to judge urgency/priority ordering across
    strategies, but it is not a source of new metrics — never cite it as if it were a MEASURED METRIC.

${
  structural.found
    ? `STRUCTURAL EVIDENCE: a loop calling an async DB-shaped function was found: "${structural.detail}..." — treat this as real, primary evidence.`
    : `STRUCTURAL EVIDENCE: no per-item DB call loop was found. Do not propose a "batching" fix framed as N+1 remediation unless you can point to the actual loop below.`
}

Endpoint: ${metadata.method} ${metadata.routePath}
MEASURED METRICS:
- Requests sent: ${metrics.requestsSent}
- Avg latency: ${metrics.avgMs.toFixed(0)}ms, P95: ${metrics.p95Ms ?? "n/a"}ms
- DB spans/request: ${metrics.dbSpansPerRequest ?? "n/a"}, DB time share: ${metrics.dbTimeSharePercent ?? "n/a"}%
- External calls/request: ${metrics.externalSpansPerRequest ?? "n/a"}, share: ${metrics.externalTimeSharePercent ?? "n/a"}%
${renderMcpSection(mcpContext)}
SOURCE:
${codeContext.slice(0, MAX_CODE_CONTEXT_CHARS)}
`;
}

function normalizeChangesKey(changes: FileChange[]): string {
  return changes
    .map((c) => `${c.filePath}::${c.newCode.replace(/\s+/g, " ").trim()}`)
    .sort()
    .join("||");
}

function tokenOverlap(a: string, b: string): number {
  const setA = new Set(a.split(" "));
  const setB = new Set(b.split(" "));
  const overlap = [...setA].filter((w) => setB.has(w)).length;
  return overlap / Math.max(setA.size, setB.size, 1);
}

// Two strategies count as "the same" if their combined change fingerprint
// is near-identical after whitespace normalization — cheap guard against
// the model padding out the count by rewording one fix.
function isDuplicateStrategy(
  candidate: OptimizationStrategy,
  existing: OptimizationStrategy[],
): boolean {
  const norm = normalizeChangesKey(candidate.changes);
  return existing.some(
    (s) => tokenOverlap(norm, normalizeChangesKey(s.changes)) > 0.85,
  );
}

// Validates one raw strategy from the model, builds real unified diffs,
// and clamps its improvement estimate. Returns null (and pushes a reason
// into rejectedNotes) if it can't be safely applied.
function validateAndBuildStrategy(
  raw: RawStrategy,
  opts: {
    codeContext: string;
    knownFilePaths: string[];
    existingFilePaths: string[];
    knownDependencies: string[];
  },
  computed: ComputedMetrics,
  structural: StructuralFinding,
  usedFilePathsThisBatch: Set<string>,
  rejectedNotes: string[],
): OptimizationStrategy | null {
  const label = raw.title || raw.id || "untitled strategy";

  if (
    !raw.title ||
    !raw.approach ||
    !raw.description ||
    !raw.changes ||
    raw.changes.length === 0
  ) {
    rejectedNotes.push(
      `"${label}" was missing required fields or had no file changes.`,
    );
    return null;
  }
  if (!raw.estimatedImprovementPercent) {
    rejectedNotes.push(`"${label}" was missing an improvement estimate.`);
    return null;
  }

  // Redis strategies must isolate client/connection setup into a created
  // file — an inline createClient()/new Redis() in a modified route file
  // is rejected outright rather than shipped as a "quick hack".
  if (
    raw.approach === "caching" &&
    isRedisStrategyMissingFileSplit(raw.changes)
  ) {
    rejectedNotes.push(
      `"${label}" inlined Redis client setup instead of splitting it into a dedicated created file (e.g. src/lib/redisClient.ts).`,
    );
    return null;
  }

  const builtChanges: FileChange[] = [];
  const seenPathsInStrategy = new Set<string>();

  for (const rc of raw.changes) {
    if (!rc.filePath || !rc.newCode) {
      rejectedNotes.push(
        `"${label}" had a file change missing filePath/newCode.`,
      );
      return null;
    }
    if (seenPathsInStrategy.has(rc.filePath)) {
      rejectedNotes.push(
        `"${label}" targeted "${rc.filePath}" more than once in the same strategy.`,
      );
      return null;
    }
    seenPathsInStrategy.add(rc.filePath);

    // Reject any change that imports a package we don't actually have
    // installed — this is what catches the "new RedisClient() from a repo
    // that never had `redis` as a dependency" failure mode before any
    // sandbox/container cost is spent on it.
    const imported = extractImportedPackages(rc.newCode);
    const missingDeps = imported.filter(
      (pkg) => !opts.knownDependencies.includes(pkg),
    );
    if (missingDeps.length > 0) {
      rejectedNotes.push(
        `"${label}" imported package(s) not installed in this repo: ${missingDeps.join(", ")}. Use an in-memory approach or a package that's actually a dependency.`,
      );
      return null;
    }

    // A Map/Set-based in-memory cache declared inside a function or loop
    // body resets on every call and doesn't cache anything — reject it
    // rather than ship a no-op cache.
    if (
      raw.approach === "caching" &&
      /new\s+(Map|Set)\s*\(/.test(rc.newCode) &&
      isCacheDeclaredInsideScope(rc.newCode)
    ) {
      rejectedNotes.push(
        `"${label}" declared its cache inside a function/loop in "${rc.filePath}" instead of module scope — it would reset every call and cache nothing.`,
      );
      return null;
    }

    const changeType: FileChangeType =
      rc.changeType === "create" ? "create" : "modify";

    if (changeType === "modify") {
      if (!opts.knownFilePaths.includes(rc.filePath)) {
        rejectedNotes.push(
          `"${label}" tried to modify "${rc.filePath}", which isn't a known file in this repo's resolved context.`,
        );
        return null;
      }
      if (!rc.originalCode) {
        rejectedNotes.push(
          `"${label}" had a "modify" change for "${rc.filePath}" with no originalCode.`,
        );
        return null;
      }
      const occurrences = countOccurrences(opts.codeContext, rc.originalCode);
      if (occurrences !== 1) {
        rejectedNotes.push(
          `"${label}"'s originalCode for "${rc.filePath}" matched ${occurrences} place(s) instead of exactly 1.`,
        );
        return null;
      }

      // Syntax pre-check: splice into the whole reconstructed file (not
      // just the snippet — a lone snippet often won't parse standalone
      // even when correctly embedded) and check it actually parses.
      const fileMapForSyntax = splitCodeContextByFile(opts.codeContext);
      const wholeFileAfter = (
        fileMapForSyntax.get(rc.filePath) ?? opts.codeContext
      ).replace(rc.originalCode, rc.newCode);
      const syntaxErrors = findSyntaxErrors(wholeFileAfter);
      if (syntaxErrors.length > 0) {
        rejectedNotes.push(
          `"${label}"'s change to "${rc.filePath}" doesn't parse: ${syntaxErrors[0]}`,
        );
        return null;
      }

      builtChanges.push({
        filePath: rc.filePath,
        changeType: "modify",
        originalCode: rc.originalCode,
        newCode: rc.newCode,
        unifiedDiff: buildDisplayDiff(rc.filePath, rc.originalCode, rc.newCode),
      });
    } else {
      if (opts.existingFilePaths.includes(rc.filePath)) {
        rejectedNotes.push(
          `"${label}" tried to "create" "${rc.filePath}", but that file already exists in the repo — use "modify" instead.`,
        );
        return null;
      }
      if (usedFilePathsThisBatch.has(rc.filePath)) {
        rejectedNotes.push(
          `"${label}" tried to create "${rc.filePath}" but another accepted strategy already claims that path.`,
        );
        return null;
      }

      const createSyntaxErrors = findSyntaxErrors(rc.newCode);
      if (createSyntaxErrors.length > 0) {
        rejectedNotes.push(
          `"${label}"'s new file "${rc.filePath}" doesn't parse: ${createSyntaxErrors[0]}`,
        );
        return null;
      }

      builtChanges.push({
        filePath: rc.filePath,
        changeType: "create",
        newCode: rc.newCode,
        unifiedDiff: buildCreateDisplayDiff(rc.filePath, rc.newCode),
      });
    }
  }

  // Cross-file check runs once all of this strategy's changes are known —
  // a rename is only "broken" relative to the full set of files it touched.
  const brokenRefs = findBrokenExportReferences(raw.changes, opts.codeContext);
  if (brokenRefs.length > 0) {
    rejectedNotes.push(`"${label}": ${brokenRefs.join(" ")}`);
    return null;
  }

  const confidence: "high" | "medium" | "low" =
    raw.confidence === "high" || raw.confidence === "low"
      ? raw.confidence
      : "medium";

  return {
    id: raw.id || `S${Math.random().toString(36).slice(2, 6)}`,
    title: raw.title,
    approach: raw.approach,
    description: raw.description,
    estimatedImprovementPercent: clampImprovementEstimate(
      {
        min: raw.estimatedImprovementPercent.min ?? 5,
        max: raw.estimatedImprovementPercent.max ?? 10,
      },
      computed,
      structural,
    ),
    changes: builtChanges,
    confidence,
  };
}

async function callGroqForStrategies(
  prompt: string,
  apiKey: string,
): Promise<RawStrategiesResponse | null> {
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
            "You are a senior performance engineer proposing multiple distinct, real fixes across one or more files, including new files when genuinely useful. You never invent metrics, never mislabel sequential code as concurrent, and every change is a real, minimal, applicable patch against the exact code shown — unique within it. When a fix needs Redis, you always isolate client/connection setup into its own created file rather than inlining it. When live traffic context (via SigNoz MCP) is provided, use it only to judge urgency/priority — never as a source of new numeric metrics. Respond with raw JSON only.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.4,
      max_tokens: 3000,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) return null;
  const data = await response.json();
  const raw: string | undefined = data.choices?.[0]?.message?.content;
  if (!raw) return null;
  try {
    return JSON.parse(cleanJson(raw));
  } catch {
    return null;
  }
}

export async function generateOptimizationStrategies(opts: {
  metadata: { method: string; routePath: string };
  runResult: LoadScriptResult;
  telemetry: RouteTelemetry | null;
  codeContext: string;
  dbBreakdown?: DbOperationBreakdown[];
  knownFilePaths: string[];
  existingFilePaths: string[];
  knownDependencies: string[];
  knownEnvVars: string[];
  mcpContext?: string;
}): Promise<StrategyGenerationResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not configured on the server.");

  const computed = computeMetrics(opts.runResult, opts.telemetry);
  const structural = detectLoopedDbCall(opts.codeContext);

  let rootCause = "";
  let severity: "critical" | "warning" | "info" = "warning";
  const accepted: OptimizationStrategy[] = [];
  const rejectedNotes: string[] = [];
  const usedFilePaths = new Set<string>();

  for (
    let attempt = 0;
    attempt < MAX_GENERATION_ATTEMPTS &&
    accepted.length < TARGET_STRATEGY_COUNT;
    attempt++
  ) {
    const needed = TARGET_STRATEGY_COUNT - accepted.length;
    const prompt = buildStrategiesPrompt(
      opts.metadata,
      computed,
      opts.codeContext,
      structural,
      opts.knownFilePaths,
      opts.existingFilePaths,
      opts.knownDependencies,
      opts.knownEnvVars,
      opts.mcpContext,
      {
        count: needed,
        alreadyAccepted: accepted.map((s) => ({
          title: s.title,
          approach: s.approach,
        })),
        rejectedNotes,
      },
    );

    const parsed = await callGroqForStrategies(prompt, apiKey);
    if (!parsed) {
      rejectedNotes.push(
        `Attempt ${attempt + 1}: Groq call failed or returned unparseable JSON.`,
      );
      continue;
    }

    if (attempt === 0) {
      rootCause = parsed.rootCause ?? "";
      severity =
        parsed.severity === "critical" || parsed.severity === "info"
          ? parsed.severity
          : "warning";
    }

    for (const rawStrategy of parsed.strategies ?? []) {
      if (accepted.length >= TARGET_STRATEGY_COUNT) break;

      const built = validateAndBuildStrategy(
        rawStrategy,
        {
          codeContext: opts.codeContext,
          knownFilePaths: opts.knownFilePaths,
          existingFilePaths: opts.existingFilePaths,
          knownDependencies: opts.knownDependencies,
        },
        computed,
        structural,
        usedFilePaths,
        rejectedNotes,
      );
      if (!built) continue;
      if (isDuplicateStrategy(built, accepted)) {
        rejectedNotes.push(
          `"${built.title}" was too similar to an already-accepted strategy.`,
        );
        continue;
      }
      accepted.push(built);
      for (const c of built.changes) usedFilePaths.add(c.filePath);
    }
  }

  if (accepted.length === 0) {
    throw new Error(
      "The model didn't produce any strategies with a safely-applicable code change after multiple attempts. Try again.",
    );
  }

  const relabeled = accepted.slice(0, TARGET_STRATEGY_COUNT).map((s, i) => ({
    ...s,
    id: String.fromCharCode(65 + i),
  }));

  return { rootCause, severity, strategies: relabeled };
}
