const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const MAX_DURATION_SECONDS = 120;

type FieldType = "string" | "number" | "boolean" | "email" | "date" | "id";

// Same naming heuristics as trafficGenerator's guessValueForField, but
// returns a *type* rather than a value — the model does the value work,
// we just stop it from guessing wrong shapes (e.g. amount as a string).

const MAX_CODE_CONTEXT_CHARS = 6000;

function inferFieldType(field: string): FieldType {
  const lower = field.toLowerCase();
  if (lower.includes("email")) return "email";
  if (lower.includes("date") || lower.endsWith("_at") || lower.endsWith("at"))
    return "date";
  if (lower.startsWith("is") || lower.startsWith("has")) return "boolean";
  if (lower.endsWith("id")) return "id";
  if (
    lower.includes("price") ||
    lower.includes("amount") ||
    lower.includes("total") ||
    lower.includes("qty") ||
    lower.includes("quantity") ||
    lower.includes("count")
  )
    return "number";
  return "string";
}

export interface EndpointMetadata {
  routePath: string;
  method: string;
  appPort: number;
  middlewares: string[];
  authRequired: boolean;
}

export function buildEndpointMetadata(opts: {
  routePath: string;
  method: string;
  appPort: number;
  middlewares: string[];
}): EndpointMetadata {
  return {
    routePath: opts.routePath,
    method: opts.method,
    appPort: opts.appPort,
    middlewares: opts.middlewares,
    authRequired: opts.middlewares.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Scenario classification
// ---------------------------------------------------------------------------
//
// THE CORE RULE (this is the whole fix): a duration/timeframe is ONLY ever
// used if the user explicitly said one ("for 30 seconds", "for 2 minutes").
// Everything else — "50 concurrent users", "50 requests at a time", "50
// total requests", a bare "ramp up to 100 users" — describes a QUANTITY,
// not a rate to sustain indefinitely. Without a stated timeframe, the
// correct interpretation is: fire that many requests and stop.
//
// Previously, "N concurrent" / "N at a time" / "ramp to N" all defaulted
// to a 30s HELD load (constant-vus for 30s) when no duration was given,
// which is how "50 requests at a time" turned into 1000+ actual requests.
// That's the bug being fixed here.
//
// Separately, "what's the max load this can handle" isn't a count OR a
// duration — it's a request to let k6 find the limit itself via an
// escalating ramp with abort-on-fail thresholds. That's a new mode below.

type ScenarioMode = "concurrent" | "total-count" | "ramp" | "breakpoint";

interface ScenarioSpec {
  mode: ScenarioMode;
  count: number; // meaning depends on mode: concurrent VUs, total iterations, peak VUs for a ramp, or peak stage target for breakpoint
  durationSeconds: number; // hold/total duration, always capped at MAX_DURATION_SECONDS
  estimatedTotalIterations: number; // used to size SAMPLE_EVERY realistically
  description: string; // human-readable, echoed into the prompt so the model's comments/thresholds line up
}

// Rough estimate of one loop iteration's wall time: think-time
// (`sleep(Math.random() * 2)` averages 1s) plus an assumed sub-second
// request. Only used to size SAMPLE_EVERY sensibly — doesn't need to be
// exact, just in the right order of magnitude.
const ASSUMED_ITERATION_SECONDS = 1.3;

// Fixed escalation ladder for breakpoint tests: 6 stages x 20s = 120s,
// exactly MAX_DURATION_SECONDS. The test aborts itself via threshold
// abortOnFail the moment the endpoint starts failing, so whichever stage
// it was in when it aborted IS the answer to "how much load can this take".
const BREAKPOINT_STAGE_VUS = [10, 25, 50, 100, 200, 400];
const BREAKPOINT_STAGE_SECONDS = 20;

function clampDuration(seconds: number): number {
  return Math.max(5, Math.min(MAX_DURATION_SECONDS, Math.round(seconds)));
}

function parseDurationSeconds(lower: string): number | null {
  const match = lower.match(
    /for\s+(\d+)\s*(seconds?|secs?|s\b|minutes?|mins?|m\b)/,
  );
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  return /^m/.test(unit) ? value * 60 : value;
}

// Builds a plain "fire exactly `count` requests, then stop" spec —
// this is the shared fallback for every phrasing (concurrent/at-a-time/
// ramp/total/ambiguous) once we've determined no duration was given.
function buildTotalCountSpec(count: number, description: string): ScenarioSpec {
  const vus = Math.max(1, Math.min(count, 50));
  return {
    mode: "total-count",
    count,
    durationSeconds: clampDuration(
      Math.ceil((count / vus) * ASSUMED_ITERATION_SECONDS) + 10,
    ),
    estimatedTotalIterations: count,
    description,
  };
}

export function classifyScenario(description: string): ScenarioSpec {
  const lower = description.toLowerCase();
  const explicitDuration = parseDurationSeconds(lower);
  const durationGiven = explicitDuration !== null;

  // --- Breakpoint / "max load this can handle" ------------------------
  // No count and no duration apply here at all — this is a request for
  // k6 to discover the limit itself. Matches things like "determine the
  // maximum load this endpoint can handle", "find the breaking point",
  // "how much traffic can this take", "what's the max throughput".
  const breakpointMatch =
    /\b(max(imum)?|breaking point|capacity)\b[\s\S]*\b(load|traffic|requests?|throughput|handle|sustain|take)\b/.test(
      lower,
    ) ||
    /\bhow (much|many)\b[\s\S]*\b(load|traffic|requests?|handle|sustain|take)\b/.test(
      lower,
    ) ||
    /\bfind (the )?(max|limit|breaking point)\b/.test(lower);

  if (breakpointMatch) {
    const totalSeconds = BREAKPOINT_STAGE_VUS.length * BREAKPOINT_STAGE_SECONDS;
    const avgVUs =
      BREAKPOINT_STAGE_VUS.reduce((a, b) => a + b, 0) /
      BREAKPOINT_STAGE_VUS.length;
    return {
      mode: "breakpoint",
      count: BREAKPOINT_STAGE_VUS[BREAKPOINT_STAGE_VUS.length - 1],
      durationSeconds: totalSeconds,
      estimatedTotalIterations: Math.round(
        (avgVUs * totalSeconds) / ASSUMED_ITERATION_SECONDS,
      ),
      description: `Escalating breakpoint test: VU stages ${BREAKPOINT_STAGE_VUS.join(
        " -> ",
      )}, ${BREAKPOINT_STAGE_SECONDS}s each (stages executor), with abortOnFail thresholds on error rate (>5%) and p95 latency (>1000ms) — the test stops ITSELF the moment the endpoint starts failing, so whichever stage it had reached before aborting is the answer to "how much load can this handle". Any specific number in the user's wording is ignored here on purpose — finding the ceiling requires ramping past whatever number they guessed anyway.`,
    };
  }

  // "50 concurrent users", "50 simultaneous requests", "50 parallel connections"
  const concurrentMatch = lower.match(
    /(\d+)\s*(concurrent|simultaneous|parallel)\s*(users?|requests?|connections?|people)?/,
  );
  // "50 requests at a time", "50 at the same time" — noun between the
  // number and "at a/same time" is now optional-but-tolerated (this used
  // to require the number to sit directly next to "at", which never
  // matched real phrasing like "50 requests at a time").
  const atATimeMatch = lower.match(
    /(\d+)\s*(?:requests?|users?|people)?\s*at\s+(?:the\s+)?same\s+time|(\d+)\s*(?:requests?|users?|people)?\s*at\s+a\s+time/,
  );
  // "ramp up to 50 users", "ramp from 0 to 100"
  const rampMatch = /\bramp\b/.test(lower) ? lower.match(/(\d+)/) : null;
  // Plain "50 requests" / "50 total requests" with NO concurrency/ramp
  // language at all — this is a total-count statement, not a concurrency one.
  const totalMatch = lower.match(/(\d+)\s*(total\s*)?requests?\b/);

  // "N concurrent" / "N at a time": a genuine sustained-load test ONLY if
  // an explicit duration was also given. Otherwise it means "fire N
  // requests at once and stop" — concurrency describes the batch shape,
  // not an indefinite rate to hold.
  if (concurrentMatch || atATimeMatch) {
    const count = parseInt(
      (concurrentMatch?.[1] ?? atATimeMatch?.[1] ?? atATimeMatch?.[2])!,
      10,
    );

    if (durationGiven) {
      const durationSeconds = clampDuration(explicitDuration!);
      return {
        mode: "concurrent",
        count,
        durationSeconds,
        estimatedTotalIterations: Math.round(
          (count * durationSeconds) / ASSUMED_ITERATION_SECONDS,
        ),
        description: `${count} concurrent virtual users held steady for ${durationSeconds}s (constant-vus executor, no ramp) — an explicit duration was given, so this is a genuine sustained-load test, not a fire-and-stop burst.`,
      };
    }

    return buildTotalCountSpec(
      count,
      `No duration was given, so "${count} concurrent" / "at a time" describes a batch of ${count} requests fired together, not a rate to sustain — shared-iterations executor, ${Math.max(
        1,
        Math.min(count, 50),
      )} VUs, then stop.`,
    );
  }

  // "ramp up to N users": a real ramp-and-hold test ONLY if a duration
  // was given (ramping inherently implies sustaining at the peak for a
  // while). With no duration, treat N as a one-shot burst target instead.
  if (rampMatch) {
    const count = parseInt(rampMatch[1], 10);

    if (durationGiven) {
      const holdSeconds = clampDuration(explicitDuration!);
      const rampSeconds = Math.max(5, Math.round(holdSeconds / 3));
      return {
        mode: "ramp",
        count,
        durationSeconds: holdSeconds,
        estimatedTotalIterations: Math.round(
          (count * holdSeconds) / ASSUMED_ITERATION_SECONDS / 2,
        ),
        description: `Ramp from 0 up to ${count} VUs, hold at ${count} for ${holdSeconds}s, then ramp back to 0 — explicit duration given, ramp segments computed as ~${rampSeconds}s each side.`,
      };
    }

    return buildTotalCountSpec(
      count,
      `"Ramp up to ${count}" with no duration given — interpreted as a ${count}-request burst (shared-iterations executor) rather than an open-ended sustained ramp, since nothing in the scenario said how long to hold it.`,
    );
  }

  // Plain "N requests" / "N total requests" — always a fixed count. If a
  // duration also happens to be given, it's just a safety-net cap on
  // runtime, not a change in meaning: this was already correct before.
  if (totalMatch) {
    const count = parseInt(totalMatch[1], 10);
    const vus = Math.max(1, Math.min(count, 50));
    const durationSeconds = clampDuration(
      explicitDuration ??
        Math.ceil((count / vus) * ASSUMED_ITERATION_SECONDS) + 10,
    );
    return {
      mode: "total-count",
      count,
      durationSeconds,
      estimatedTotalIterations: count,
      description: `Exactly ${count} total requests, no more — shared-iterations executor across ${vus} VUs${
        durationGiven
          ? `, capped at a ${durationSeconds}s max duration as a safety net`
          : ""
      } — NOT a duration-held load.`,
    };
  }

  // No count phrasing matched at all. If a duration WAS given ("hit this
  // api for 30 seconds"), that's a genuine duration-based test with a
  // modest default concurrency.
  if (durationGiven) {
    const durationSeconds = clampDuration(explicitDuration!);
    const count = 20;
    return {
      mode: "concurrent",
      count,
      durationSeconds,
      estimatedTotalIterations: Math.round(
        (count * durationSeconds) / ASSUMED_ITERATION_SECONDS,
      ),
      description: `Explicit duration given (${durationSeconds}s) with no VU count specified — defaulting to ${count} concurrent VUs held for the full duration.`,
    };
  }

  // Truly nothing specified ("simulate some traffic on /orders"): no
  // count, no duration, no max-load language. Per the same rule as
  // everywhere else above, absence of a duration means fire-and-stop,
  // not an indefinite hold — default to a modest burst.
  return buildTotalCountSpec(
    20,
    `No explicit count, duration, or max-load language found — defaulting to a 20-request burst (shared-iterations executor, 20 VUs) rather than an open-ended time-held load.`,
  );
}

// Builds the EXACT k6 `options` block text for a given spec. This is
// injected verbatim after generation (see applyScenarioOverride), so it
// doesn't matter what the model itself wrote for `options` — the actual
// executor/VU/duration numbers always come from here, deterministically.
function buildOptionsBlock(spec: ScenarioSpec): string {
  if (spec.mode === "breakpoint") {
    const stages = BREAKPOINT_STAGE_VUS.map(
      (v) => `    { target: ${v}, duration: "${BREAKPOINT_STAGE_SECONDS}s" },`,
    ).join("\n");
    return `export let options = {
  stages: [
${stages}
  ],
  thresholds: {
    "http_req_failed": [{ threshold: "rate<0.05", abortOnFail: true, delayAbortEval: "10s" }],
    "http_req_duration": [{ threshold: "p(95)<1000", abortOnFail: true, delayAbortEval: "10s" }],
  },
};`;
  }

  if (spec.mode === "total-count") {
    const vus = Math.max(1, Math.min(spec.count, 50));
    return `export let options = {
  scenarios: {
    fixed_total_requests: {
      executor: "shared-iterations",
      vus: ${vus},
      iterations: ${spec.count},
      maxDuration: "${spec.durationSeconds}s",
    },
  },
  thresholds: {
    "http_req_failed": ["rate<0.01"],
    "http_req_duration": ["p(95)<500"],
  },
};`;
  }

  if (spec.mode === "ramp") {
    const rampSeconds = Math.max(5, Math.round(spec.durationSeconds / 3));
    return `export let options = {
  stages: [
    { target: ${spec.count}, duration: "${rampSeconds}s" },
    { target: ${spec.count}, duration: "${spec.durationSeconds}s" },
    { target: 0, duration: "${rampSeconds}s" },
  ],
  thresholds: {
    "http_req_failed": ["rate<0.01"],
    "http_req_duration": ["p(95)<500"],
  },
};`;
  }

  // concurrent (constant-vus): exactly N VUs, no ramp, held for the
  // given duration — only reached when an explicit duration was given.
  return `export let options = {
  scenarios: {
    fixed_concurrency: {
      executor: "constant-vus",
      vus: ${spec.count},
      duration: "${spec.durationSeconds}s",
    },
  },
  thresholds: {
    "http_req_failed": ["rate<0.01"],
    "http_req_duration": ["p(95)<500"],
  },
};`;
}

// Overwrites whatever `options` block and SAMPLE_EVERY line the model
// generated with our own deterministic values. This is the enforcement
// step — the prompt tells the model what we computed so its comments/
// thresholds stay consistent, but the actual numbers that control test
// behavior never depend on the model having interpreted the scenario
// correctly.
function applyScenarioOverride(script: string, spec: ScenarioSpec): string {
  let result = script;

  const optionsBlockRe =
    /export\s+(?:let|const)\s+options\s*=\s*\{[\s\S]*?\n\};/;
  if (optionsBlockRe.test(result)) {
    result = result.replace(optionsBlockRe, buildOptionsBlock(spec));
  } else {
    // Model omitted an options block entirely — inject one after the
    // last import statement.
    const lastImportMatch = [...result.matchAll(/^import .*$/gm)].pop();
    if (lastImportMatch) {
      const insertAt = lastImportMatch.index! + lastImportMatch[0].length;
      result =
        result.slice(0, insertAt) +
        `\n\n${buildOptionsBlock(spec)}` +
        result.slice(insertAt);
    } else {
      result = `${buildOptionsBlock(spec)}\n\n${result}`;
    }
  }

  const sampleEveryRe =
    /const\s+SAMPLE_EVERY\s*=\s*Math\.max\(\s*1\s*,\s*Math\.floor\([^)]*\)\s*\)\s*;/;
  const newSampleEvery = `const SAMPLE_EVERY = Math.max(1, Math.floor(${spec.estimatedTotalIterations} / 150));`;
  result = sampleEveryRe.test(result)
    ? result.replace(sampleEveryRe, newSampleEvery)
    : result;

  return result;
}

function buildPrompt(
  metadata: EndpointMetadata,
  codeContext: string,
  description: string,
  spec: ScenarioSpec,
): string {
  return `You are a senior performance engineer writing a production-grade k6 load test. Respond with ONLY the script — no markdown fences, no explanation.

Endpoint: ${metadata.method} ${metadata.routePath} on http://localhost:${metadata.appPort}
Auth middleware detected: ${metadata.authRequired ? metadata.middlewares.join(", ") : "none"}

Here is the REAL implementation of this endpoint (route -> controller -> service). This is ground truth — read it carefully rather than guessing the request shape:
${codeContext.slice(0, MAX_CODE_CONTEXT_CHARS)}

User's test scenario, in their own words: "${description}"

SCENARIO INTERPRETATION (computed deterministically from the user's exact wording — this is what your script's options block will be REPLACED WITH after generation, so match it, but don't stress about getting the k6 syntax perfect since it's overwritten either way):
- Mode: ${spec.mode}
- ${spec.description}
- Estimated total iterations for this run: ~${spec.estimatedTotalIterations}

Write a k6 script a senior performance engineer would sign off on. Follow every rule below exactly — these are known failure modes, not style preferences:

0. **Read the code above for the exact request body shape and field types — do not invent fields, do not omit fields the code actually destructures from req.body.** Critically: if the code casts an ID field to a MongoDB ObjectId (e.g. via Mongoose \`Schema.Types.ObjectId\`, \`mongoose.Types.ObjectId(...)\`, a model field typed \`ObjectId\`, or a \`findById\`/\`findOne({ _id: ... })\` call), that field MUST be a valid 24-character lowercase hex string in your generated requests — human-readable values like "user-1" will fail Mongoose's cast validation and every request will 500. If the code gives no evidence of ObjectId casting for a given ID-like field, a simple string identifier is fine.

1. **Imports — always include all of these at the top, exactly:**
   \`\`\`
   import http from "k6/http";
   import { check, sleep } from "k6";
   import { Trend } from "k6/metrics";
   \`\`\`
   The script will not run without them.

2. **File header comment** before the imports:
   \`\`\`
   /**
    * Generated by Axiom AI
    *
    * Endpoint: ${metadata.method} ${metadata.routePath}
    * Scenario: <one line from the user's description>
    * Payload fields: <comma-separated field names actually read from req.body in the code above, or "none">
    */
   \`\`\`

3. **JSON payloads, not object literals.** For POST/PUT/PATCH, build the body with \`const payload = JSON.stringify({...})\` and send with \`params\` containing \`headers: { "Content-Type": "application/json" }\`.

3b. **Method arity matters.** \`http.get\`, \`http.del\`, \`http.head\`, and \`http.options\` take exactly TWO arguments: \`(url, params)\` — there is no body argument, ever. Only \`http.post\`, \`http.put\`, and \`http.patch\` take three: \`(url, payload, params)\`. Never write \`http.get(url, null, params)\` or \`http.get(url, payload, params)\` — that silently breaks the request and spams stderr with "http.get only accepts a url and a params argument". For GET/DELETE/HEAD, put query params directly in the URL string, and pass headers/tags as the single second argument: \`http.get(url, { headers, tags })\`.

4. **Authentication.** ${
    metadata.authRequired
      ? `Read the token from \`__ENV.API_TOKEN\` and add \`Authorization: \`Bearer \${__ENV.API_TOKEN}\`\` to headers. If unset, run anyway but console.warn once at module scope.`
      : "No auth middleware detected — do not add an Authorization header unless the scenario explicitly asks for one."
  }

5. **Realistic data pools. For ID fields that get cast to Mongo ObjectId (see rule 0), generate a REAL 24-character lowercase hex string yourself using a helper function — NEVER use \`crypto.randomUUID()\` for these, since a UUID (e.g. "3f2a9b10-6e51-4c3a-9d21-8a7b5e6f10c2") is NOT a valid ObjectId and will fail Mongoose casting on every single request, silently turning your whole load test into 100% failures.** Declare and use exactly this helper at module scope whenever you need an ObjectId-shaped value:
   \`\`\`
   function generateObjectId() {
     const hex = "0123456789abcdef";
     let id = "";
     for (let i = 0; i < 24; i++) id += hex[Math.floor(Math.random() * 16)];
     return id;
   }
   \`\`\`
   For enum-like fields, declare a small pool array and pick with \`pool[Math.floor(Math.random() * pool.length)]\`. For every other field, generate values matching what the real code above expects.

6. **Think time.** \`sleep(Math.random() * 2)\` after each request. ${
    spec.mode === "breakpoint"
      ? "For this breakpoint test, keep think time minimal/unchanged — the stages executor is what drives increasing load, not a longer sleep."
      : ""
  }

7. **Metrics.** \`const requestDuration = new Trend("<route_name>_duration");\`, call \`.add(res.timings.duration)\` after every request, plus \`check(res, { "status is success": (r) => r.status >= 200 && r.status < 400 });\`.

8. **Tags on every request:**
   \`\`\`
   http.${metadata.method.toLowerCase()}(url, ${
     metadata.method === "GET" || metadata.method === "DELETE"
       ? '{ headers, tags: { endpoint: "' +
         metadata.routePath +
         '", scenario: "load-test", generatedBy: "axiom-ai" } }'
       : 'payload, {\n     headers,\n     tags: { endpoint: "' +
         metadata.routePath +
         '", scenario: "load-test", generatedBy: "axiom-ai" },\n   }'
   });
   \`\`\`

9. **Sampled logging, not one line per request, but ALWAYS capture full failure detail.** Near the top: \`const SAMPLE_EVERY = Math.max(1, Math.floor(${spec.estimatedTotalIterations} / 150));\` (use this exact number — it's the computed estimate of total iterations for this scenario). Every single response still needs to be checked for failure — you cannot skip that check just because logging is sampled. Structure it like this:
   \`\`\`
   const isFailure = res.status === 0 || res.status >= 400;
   if (isFailure || __ITER % SAMPLE_EVERY === 0) {
     console.log("RESULT:" + JSON.stringify({
       status: res.status,
       ok: !isFailure,
       durationMs: res.timings.duration,
       method: "<the HTTP method used for this request>",
       url: url,
       requestBody: isFailure ? (typeof payload !== "undefined" ? payload : undefined) : undefined,
       body: isFailure ? String(res.body || "").slice(0, 1000) : undefined,
       networkError: isFailure && res.error ? res.error : undefined,
       networkErrorCode: isFailure && res.error_code ? res.error_code : undefined,
     }));
   }
   \`\`\`
   In other words: sampling controls how many *successful* requests get logged, but EVERY failing request gets logged, always, with three things attached: (a) the exact request payload that was sent (only meaningful for POST/PUT/PATCH — omit/undefined for GET/DELETE), (b) the response body truncated to 1000 chars, and (c) k6's own \`res.error\`/\`res.error_code\` for network-level failures where \`res.status\` is 0. No other console.log besides this and the optional one-time auth warning.

10. **Thresholds** sized to the scenario, e.g. \`http_req_failed: ["rate<0.01"]\`, \`http_req_duration: ["p(95)<500"]\`. ${
    spec.mode === "breakpoint"
      ? 'For a breakpoint test specifically, thresholds must use the object form with abortOnFail so k6 stops itself once the endpoint starts failing: `{ threshold: "rate<0.05", abortOnFail: true, delayAbortEval: "10s" }` — a plain string threshold will NOT abort the run, defeating the point of a breakpoint test.'
      : ""
  }

11. **\`options\` block: write your best attempt matching the SCENARIO INTERPRETATION above** (mode "${spec.mode}"). This will be mechanically replaced after generation with an exact computed block, so don't worry about the precise executor syntax — just get the general shape right (constant-vus for "concurrent", shared-iterations for "total-count", stages for "ramp", stages with abortOnFail thresholds for "breakpoint") so nothing else in your script assumes a different shape.

12. **\`handleSummary(data)\`** using these exact metric paths:
    - \`totalRequests\`: \`data.metrics.http_reqs.values.count\`
    - \`requestsPerSecond\`: \`data.metrics.http_reqs.values.rate\`
    - \`averageLatency\`: \`data.metrics.http_req_duration.values.avg\`
    - \`p95\`: \`data.metrics.http_req_duration.values["p(95)"]\`
    - \`p99\`: \`data.metrics.http_req_duration.values["p(99)"]\`
    - \`errorRate\`: \`data.metrics.http_req_failed.values.rate\` (this is a Rate metric — it has no \`.count\`)
    - \`thresholdsPassed\`:
      \`\`\`
      Object.values(data.metrics)
        .filter((metric) => metric.thresholds)
        .every((metric) => Object.values(metric.thresholds).every((t) => t.ok))
      \`\`\`${
        spec.mode === "breakpoint"
          ? `
    - \`peakVUsReached\`: \`data.metrics.vus_max.values.value\` — for a breakpoint test this IS the headline answer (whatever VU level the run reached before a threshold aborted it), so it must be in the summary.`
          : ""
      }
    Then \`console.log("SUMMARY:" + JSON.stringify({...}));\` and \`return { stdout: "" };\`.

13. Target exactly \`http://localhost:${metadata.appPort}${metadata.routePath}\`. Self-contained, runnable with \`k6 run\`. Only import from 'k6' and 'k6/metrics'.

14. **Never reassign a value you plan to mutate later using \`const\`.** If the scenario calls for occasionally-invalid values (e.g. sometimes omitting a field, sometimes sending a bad ID), declare that variable with \`let\`, not \`const\` — reassigning a \`const\` throws \`TypeError: Assignment to constant variable\` and silently kills that iteration BEFORE any request is sent, meaning your negative-test cases never actually run and never appear in results. Double-check every variable you conditionally overwrite is declared with \`let\`.

15. **Wrap the entire body of the default exported function in try/catch.** If anything inside throws (a bug in the script itself, not an HTTP error), catch it and log it as its own structured line instead of letting it crash silently to stderr:
    \`\`\`
    export default function () {
      try {
        // ... all iteration logic here ...
      } catch (err) {
        console.log("SCRIPT_ERROR:" + JSON.stringify({
          message: err.message,
          stack: String(err.stack || "").slice(0, 1000),
        }));
      }
    }
    \`\`\`
    This must wrap ALL logic in the default function, including request(s), checks, and logging — the goal is that a bug in the generated script itself is never invisible; it always produces a visible, structured line.`;
}

export interface GeneratedLoadScript {
  script: string;
  authRequired: boolean;
}

// The model is told explicitly (rule 5) never to use crypto.randomUUID()
// for ID fields, since a UUID isn't a valid Mongo ObjectId and will fail
// Mongoose's cast validation on every single request — this has been
// observed to slip through despite the instruction. Rather than let that
// silently 500-storm an entire load test, we mechanically correct it:
// replace crypto.randomUUID() calls with a real 24-char hex ObjectId
// generator, injecting the helper if it isn't already present.
const OBJECT_ID_HELPER = `function generateObjectId() {
  const hex = "0123456789abcdef";
  let id = "";
  for (let i = 0; i < 24; i++) id += hex[Math.floor(Math.random() * 16)];
  return id;
}`;

function fixInvalidIdGeneration(script: string): string {
  if (!/crypto\.randomUUID\s*\(\s*\)/.test(script)) return script;

  const hasHelper = /function\s+generateObjectId\s*\(/.test(script);
  const withHelper = hasHelper ? script : `${OBJECT_ID_HELPER}\n\n${script}`;

  return withHelper.replace(
    /crypto\.randomUUID\s*\(\s*\)/g,
    "generateObjectId()",
  );
}

// Cheap static check for the exact "const later reassigned" bug that
// slipped through in production (see rule 14). We don't try to rewrite
// this one automatically (a real reassignment fix requires understanding
// intent), but we detect obviously reassigned `const` bindings so we can
// at least downgrade `const` -> `let` for the specific case the model
// tends to produce: pool-picked identifiers reassigned inside an if/else
// immediately below their declaration.
function fixConstReassignment(script: string): string {
  const lines = script.split("\n");
  const constNames = new Map<string, number>(); // name -> line index

  const constDeclRe = /^\s*const\s+([a-zA-Z_$][\w$]*)\s*=/;
  const reassignRe = (name: string) => new RegExp(`^\\s*${name}\\s*=[^=]`); // assignment, not `==`/`===`

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(constDeclRe);
    if (m) constNames.set(m[1], i);
  }

  for (const [name, declIndex] of constNames) {
    const re = reassignRe(name);
    for (let i = declIndex + 1; i < lines.length; i++) {
      if (re.test(lines[i])) {
        lines[declIndex] = lines[declIndex].replace(
          new RegExp(`^(\\s*)const(\\s+${name}\\s*=)`),
          "$1let$2",
        );
        break;
      }
    }
  }

  return lines.join("\n");
}

// GET/DELETE/HEAD have no body in k6 — http.get(url, params) takes
// exactly 2 arguments. The model sometimes still shapes the call like a
// POST (url, body, params), passing `null` as a placeholder body and
// shifting params into an ignored 3rd argument — which silently drops
// headers/tags and prints "only accepts a url and a params argument" to
// stderr on every single request. Mechanically fix it by removing the
// placeholder body argument for bodyless methods.
function fixBodylessMethodArity(script: string): string {
  const BODYLESS_METHODS = ["get", "del", "head", "options"];
  let fixed = script;
  for (const method of BODYLESS_METHODS) {
    // Matches: http.get(url, null, {...}) or http.get(url, undefined, {...})
    // and rewrites to: http.get(url, {...})
    const pattern = new RegExp(
      `\\bhttp\\.${method}\\s*\\(([^,]+),\\s*(?:null|undefined)\\s*,\\s*`,
      "g",
    );
    fixed = fixed.replace(pattern, `http.${method}($1, `);
  }
  return fixed;
}

export async function generateLoadScript(opts: {
  metadata: EndpointMetadata;
  codeContext: string;
  description: string;
}): Promise<GeneratedLoadScript> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not configured on the server.");
  }

  const spec = classifyScenario(opts.description);

  let response: Response;
  try {
    response = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are a senior performance engineer who writes production-grade k6 scripts, grounded in the real backend code you're shown — never inventing a request shape that contradicts it. JSON payloads only for methods that support a body (never for GET/DELETE/HEAD), proper auth, correct ID formats (real 24-char hex ObjectIds when the code casts to one — never crypto.randomUUID()), realistic data pools declared with `let` if later reassigned, think time, Trend metrics, thresholds (with abortOnFail object form for breakpoint tests), a try/catch-wrapped iteration body that logs its own errors, always-logged failure detail (request payload + response body + k6 network error/error_code), and a structured JSON summary. Respond with raw JavaScript only.",
          },
          {
            role: "user",
            content: buildPrompt(
              opts.metadata,
              opts.codeContext,
              opts.description,
              spec,
            ),
          },
        ],
        temperature: 0.4,
        max_tokens: 1800,
      }),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(
        "Could not reach Groq's API within 20s — this machine's network can't connect to api.groq.com (check firewall/proxy/VPN settings, or that outbound HTTPS on port 443 is allowed).",
      );
    }
    throw new Error(
      `Network error reaching Groq's API: ${err instanceof Error ? err.message : String(err)}. This usually means outbound internet access to api.groq.com is blocked on this machine.`,
    );
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(
      `Groq API error (${response.status}): ${errBody.slice(0, 200)}`,
    );
  }

  const data = await response.json();
  let script: string | undefined = data.choices?.[0]?.message?.content;
  if (!script) throw new Error("Groq API returned no script");

  script = script
    .trim()
    .replace(/^```(?:javascript|js)?\n?/, "")
    .replace(/```$/, "")
    .trim();

  // Mechanical safety net: correct known failure modes regardless of
  // whether the model followed the prompt's rules, so a bad generation
  // doesn't silently produce a 100%-failing, crash-looping, or wildly
  // over-scaled test.
  script = fixInvalidIdGeneration(script);
  script = fixConstReassignment(script);
  script = fixBodylessMethodArity(script);
  script = applyScenarioOverride(script, spec);

  return { script, authRequired: opts.metadata.authRequired };
}
