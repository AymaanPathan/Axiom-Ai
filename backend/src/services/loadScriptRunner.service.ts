import { spawn } from "node:child_process";
import { getIO } from "../config/socket.js";

const K6_BINARY = process.env.K6_BINARY_PATH || "k6";

export interface LoadScriptResult {
  requestsSent: number;
  successCount: number;
  errorCount: number;
  windowStart: number;
  windowEnd: number;
  avgDurationMs: number;
  p95DurationMs: number | null;
  p99DurationMs: number | null;
  requestsPerSecond: number | null;
  errorRate: number;
  thresholdsPassed: boolean | null; // null = script never reached handleSummary (e.g. crashed early)
  scriptErrorCount: number; // count of SCRIPT_ERROR: lines — bugs in the script itself, not HTTP failures
}

// Safety net above the script's own MAX_DURATION_SECONDS cap, in case k6
// hangs on startup/teardown rather than the test body itself.
const HARD_TIMEOUT_MS = 150_000;

// Belt-and-suspenders against the model dropping a required import despite
// the prompt spelling it out verbatim (see loadScriptGenerator.service.ts
// rule 1). Cheap string checks — if a script uses an API but is missing
// its import, we prepend it rather than let k6 fail with a cryptic
// "http is not defined" after the user already hit Run.
const REQUIRED_IMPORTS: { check: RegExp; usage: RegExp; line: string }[] = [
  {
    check: /import\s+http\s+from\s+["']k6\/http["']/,
    usage: /\bhttp\.(get|post|put|patch|del|request)\s*\(/,
    line: `import http from "k6/http";`,
  },
  {
    check: /import\s*\{[^}]*\bcheck\b[^}]*\}\s*from\s+["']k6["']/,
    usage: /\bcheck\s*\(/,
    line: `import { check } from "k6";`,
  },
  {
    check: /import\s*\{[^}]*\bsleep\b[^}]*\}\s*from\s+["']k6["']/,
    usage: /\bsleep\s*\(/,
    line: `import { sleep } from "k6";`,
  },
  {
    check: /import\s*\{[^}]*\bTrend\b[^}]*\}\s*from\s+["']k6\/metrics["']/,
    usage: /\bnew Trend\s*\(/,
    line: `import { Trend } from "k6/metrics";`,
  },
];

function ensureRequiredImports(script: string): string {
  const missing = REQUIRED_IMPORTS.filter(
    ({ check, usage }) => usage.test(script) && !check.test(script),
  ).map(({ line }) => line);

  if (missing.length === 0) return script;
  return `${missing.join("\n")}\n${script}`;
}

// k6 wraps console.log output in a structured logfmt line whenever stdout
// isn't a TTY (always true for us, spawned as a child process): e.g.
//   time="..." level=info msg="RESULT:{...}" source=console
// --log-format=raw (passed below) asks k6 not to do this, but we also
// unwrap it here as a fallback in case a given k6 version/platform still
// wraps it anyway. IMPORTANT: this wrapping (and RESULT:/SUMMARY:/
// SCRIPT_ERROR: lines themselves) can land on either stdout OR stderr
// depending on k6 version/platform — never assume which stream carries
// them.
function extractLogLine(rawLine: string): string {
  const match = rawLine.match(/msg="((?:[^"\\]|\\.)*)"\s*source=console\s*$/);
  if (!match) return rawLine;
  return match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

// Raw shape logged by the generated k6 script per RESULT: line (see
// loadScriptGenerator.service.ts rule 9). All failure-only fields are
// optional since successful sampled requests won't carry them.
interface RawResult {
  status: number;
  ok: boolean;
  durationMs?: number;
  method?: string;
  url?: string;
  requestBody?: string;
  body?: string;
  networkError?: string;
  networkErrorCode?: number;
}

interface RawScriptError {
  message?: string;
  stack?: string;
}

// If the body is JSON, pretty-print it so nested validation errors etc.
// are actually readable instead of one dense line. Falls back to the raw
// string (e.g. an HTML error page, a plain-text message) untouched.
function tryPrettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

// Builds both a compact one-line summary (for the collapsed console row)
// and the full multi-line detail (for the expanded view) out of
// everything the script captured. Kept as two separate strings on
// purpose: pretty-printed JSON's first line is often just "{", which is
// useless as a preview, so the summary is built by flattening whitespace
// rather than taking line 1 of the pretty-printed version.
function buildFailureDetail(result: RawResult): {
  summary: string;
  full: string;
} {
  const parts: string[] = [];

  if (result.networkError) {
    parts.push(
      `Network error${
        result.networkErrorCode ? ` (code ${result.networkErrorCode})` : ""
      }: ${result.networkError}`,
    );
  }

  if (result.body && result.body.trim()) {
    parts.push(tryPrettyJson(result.body));
  }

  if (parts.length === 0) {
    parts.push(`HTTP ${result.status} — no response body captured`);
  }

  const full = parts.join("\n");
  const summary = full.replace(/\s+/g, " ").trim().slice(0, 160);

  return { summary, full };
}

export async function runLoadScript(opts: {
  repositoryId: string;
  script: string;
  authToken?: string;
}): Promise<LoadScriptResult> {
  const { repositoryId, script: rawScript, authToken } = opts;
  const script = ensureRequiredImports(rawScript);

  const io = getIO();
  const room = `repo:${repositoryId}`;
  const emitLog = (payload: object) => io.to(room).emit("traffic:log", payload);
  const emitProgress = (payload: object) =>
    io.to(room).emit("traffic:progress", payload);
  // Raw script/process output — anything that isn't a structured RESULT/
  // SUMMARY/SCRIPT_ERROR line. This is what lets the console panel show
  // "what's happening right now" (auth warnings, k6 notices) rather than
  // only the sampled per-request outcomes.
  const emitConsole = (stream: "stdout" | "stderr", message: string) =>
    io
      .to(room)
      .emit("traffic:console", { stream, message, timestamp: Date.now() });
  // A bug in the generated script itself (uncaught exception inside the
  // iteration body) — distinct from an HTTP-level failure. Surfaced as
  // its own structured event so the UI can render it as a clear, separate
  // "script error" card instead of raw stderr noise or a silent gap in
  // the results.
  const emitScriptError = (payload: {
    message: string;
    stack: string | null;
  }) =>
    io.to(room).emit("traffic:script-error", {
      ...payload,
      timestamp: Date.now(),
    });

  const windowStart = Date.now();
  emitProgress({ status: "starting", total: -1, sent: 0 });

  return new Promise((resolve, reject) => {
    const args = ["run", "--quiet", "--no-color", "--log-format=raw"];
    if (authToken) args.push("-e", `API_TOKEN=${authToken}`);
    args.push("-");

    const child = spawn(K6_BINARY, args, { stdio: ["pipe", "pipe", "pipe"] });

    let sent = 0;
    let liveSuccess = 0;
    let liveError = 0;
    let durationSum = 0;
    let scriptErrorCount = 0;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let stderrAccum = ""; // full accumulation, used for the reject() error message
    let summary: Partial<{
      totalRequests: number;
      requestsPerSecond: number;
      averageLatency: number;
      p95: number;
      p99: number;
      errorRate: number;
      thresholdsPassed: boolean;
    }> | null = null;
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, HARD_TIMEOUT_MS);

    // Shared line handler — RESULT:/SUMMARY:/SCRIPT_ERROR:/everything-else
    // can arrive on either stream, so both stdout and stderr run through
    // this exact same logic. `stream` is only used for tagging raw
    // console output.
    const handleLine = (rawLine: string, stream: "stdout" | "stderr") => {
      const line = extractLogLine(rawLine);
      if (!line.trim()) return;

      if (line.startsWith("RESULT:")) {
        try {
          const result: RawResult = JSON.parse(line.slice("RESULT:".length));
          sent++;
          if (result.ok) liveSuccess++;
          else liveError++;
          durationSum += result.durationMs ?? 0;

          const failureDetail = result.ok ? null : buildFailureDetail(result);

          // Reuses the exact traffic:log/traffic:progress shape the
          // existing useTrafficStream hook already listens for, extended
          // with method/url/requestBody so a failure can be traced back
          // to exactly what was sent, plus a compact summary (for the
          // collapsed console row) and full detail (for the expanded
          // view) instead of a bare status code.
          emitLog({
            index: sent,
            total: -1, // duration-based run: no fixed count to divide by
            status: result.status,
            ok: result.ok,
            method: result.method ?? null,
            url: result.url ?? null,
            requestBody: result.ok ? null : (result.requestBody ?? null),
            responseBodySummary: failureDetail?.summary ?? null,
            responseBody: failureDetail?.full ?? null,
            timestamp: Date.now(),
          });
          emitProgress({
            status: "running",
            total: -1,
            sent,
            successCount: liveSuccess,
            errorCount: liveError,
          });
        } catch {
          // malformed RESULT line — surface it rather than silently drop it,
          // since a parse failure here means something about the script's
          // output format has drifted and is worth seeing.
          emitConsole(stream, `[unparsed RESULT] ${line}`);
        }
        return;
      }

      if (line.startsWith("SUMMARY:")) {
        try {
          summary = JSON.parse(line.slice("SUMMARY:".length));
        } catch {
          emitConsole(stream, `[unparsed SUMMARY] ${line}`);
        }
        return;
      }

      if (line.startsWith("SCRIPT_ERROR:")) {
        try {
          const err: RawScriptError = JSON.parse(
            line.slice("SCRIPT_ERROR:".length),
          );
          scriptErrorCount++;
          emitScriptError({
            message: err.message || "Unknown script error",
            stack: err.stack ?? null,
          });
        } catch {
          // The script's own try/catch (rule 15) failed to produce valid
          // JSON — still surface it as a script error rather than a plain
          // console line, since it's still clearly an in-script exception.
          scriptErrorCount++;
          emitScriptError({
            message: line.slice("SCRIPT_ERROR:".length).slice(0, 500),
            stack: null,
          });
        }
        return;
      }

      // Anything else — the one-time auth warning, a stray k6 notice,
      // or (for scripts predating the try/catch wrapper, or where the
      // exception happened outside it) a raw uncaught exception — surface
      // it as a console line.
      emitConsole(stream, line);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line, "stdout");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrAccum += text;

      stderrBuffer += text;
      const lines = stderrBuffer.split("\n");
      stderrBuffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line, "stderr");
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (err.message.includes("ENOENT")) {
        reject(
          new Error(
            "k6 is not installed on the server. Install it (see grafana.com/docs/k6) and try again.",
          ),
        );
      } else {
        reject(err);
      }
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;

      // Flush any trailing partial lines left in the buffers.
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer, "stdout");
      if (stderrBuffer.trim()) handleLine(stderrBuffer, "stderr");

      const windowEnd = Date.now();
      emitProgress({
        status: "done",
        total: -1,
        sent,
        successCount: liveSuccess,
        errorCount: liveError,
      });

      // NOTE: k6 exits non-zero (commonly code 99) whenever a threshold
      // is breached — e.g. http_req_failed rate too high. That is a
      // SUCCESSFUL run reporting bad results, not a crash. We only treat
      // this as an error if we got literally nothing back at all.
      if (sent === 0 && !summary && code !== 0) {
        reject(
          new Error(
            `k6 exited with code ${code} before producing results: ${stderrAccum.slice(0, 500)}`,
          ),
        );
        return;
      }

      // Prefer the script's own handleSummary output (exact k6-computed
      // metrics) over stats derived from sampled RESULT lines, which are
      // only an approximation when sampling is active.
      const totalRequests = summary?.totalRequests ?? sent;
      const errorRate = summary?.errorRate ?? (sent > 0 ? liveError / sent : 0);
      const errorCount = summary
        ? Math.round(totalRequests * errorRate)
        : liveError;

      resolve({
        requestsSent: totalRequests,
        successCount: totalRequests - errorCount,
        errorCount,
        windowStart,
        windowEnd,
        avgDurationMs:
          summary?.averageLatency ??
          (sent > 0 ? Math.round(durationSum / sent) : 0),
        p95DurationMs: summary?.p95 ?? null,
        p99DurationMs: summary?.p99 ?? null,
        requestsPerSecond: summary?.requestsPerSecond ?? null,
        errorRate,
        thresholdsPassed: summary?.thresholdsPassed ?? null,
        scriptErrorCount,
      });
    });

    child.stdin.write(script);
    child.stdin.end();
  });
}
