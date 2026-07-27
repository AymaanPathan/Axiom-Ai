# ⚡ Axiom AI
<img width="5736" height="2596" alt="Image" src="https://github.com/user-attachments/assets/824c16c3-4096-4ba3-b84d-c15a6f7f8e6c" />

**Axiom improves your backend for you. Give it a scenario, and it benchmarks your API, diagnoses the bottleneck, generates competing fixes, battle tests them, and opens the pull request for the winner.**

Built for the [SigNoz "Agents of SigNoz" Hackathon](https://www.wemakedevs.org/hackathons/signoz), Track 03: Build Your Own.

---

## 🩹 The problem

You have an endpoint. Say, `GET /orders/:id` on an e commerce backend. You have a *feeling* it's slow, but:

- You don't want to write a k6/load test script by hand.
- You don't want to spin up a second environment just to poke at it.
- Even if you find the bottleneck, you don't know if **caching**, **query batching**, or **indexing** is the right fix, and you definitely don't want to try all three in production.
- And once you *do* pick a fix, someone still has to write the diff and open the PR.

Axiom does all of that for you, end to end, and grounds every number it shows you in real [SigNoz](https://signoz.io) traces, not guesses.

---

## 🎬 How it works, in one story [https://drive.google.com/file/d/1VOkvsFcbzgtdPndeGhm7sJdWSLT4lSGq/view?usp=sharing]

> You connect your GitHub repo. Axiom clones it, detects it's Express, and maps every route straight to its file and line.
>
> You pick `GET /orders/:id`. You tell Axiom: *"simulate 20 concurrent users for 30 seconds."*
>
> Axiom writes a real k6 script for that exact endpoint (using the actual request shape from your code, not a guess), spins up your app in an **isolated container**, and fires the load at it.
>
> While it runs, you watch **live CPU, memory, latency, and p95/p99** stream in, sourced straight from SigNoz.
>
> When it's done, Axiom correlates the load test against your **actual code** and your **actual traces** (via a SigNoz MCP powered agent) and tells you, in plain terms, what's slow and why, then proposes **three independent fix strategies** (for example *caching*, *query aggregation*, *connection pooling*), each with a real code diff.
>
> You open the **Optimization Arena**. All three strategies deploy into their own isolated sandbox, *simultaneously*, and get hit with the identical scenario you defined. You watch three lanes race live: CPU, memory, latency, all streaming in real time.
>
> When they finish, Axiom scores every strategy on latency, p95, CPU, memory, and error rate, and names a winner.
>
> You click **"Open PR."** Axiom re applies that strategy's diff against your repo's current `main`, commits it, and opens a real pull request on GitHub, with the benchmark numbers baked right into the PR description.
>
> No manual script writing. No guessing which fix is right. No hand rolled PR. Just a scenario in, a merged ready PR out.

---

## 🗺️ The pages

Axiom is built as a guided flow. Each page hands you off to the next.

| # | Page | What happens here |
|---|------|--------------------|
| 1 | **Landing** | The pitch, the story, and the entry point. Connect your GitHub account to get started. |
| 2 | **Repo List** | Every GitHub repo you have access to. Pick one to connect, and Axiom clones it and parses its routes. |
| 3 | **Observer Launcher** | Provide required env vars, then launch your app inside a sandboxed Docker container so Axiom has something real to test against. |
| 4 | **Repo Detail** | The connected repo's home base. Framework, discovered routes, run status, and live system health (Mongo, container, port) all in one place. |
| 5 | **Endpoints Page** | Every discovered route, plus **live SigNoz metrics** per endpoint (request count, error rate, latency, p95) so you can spot the suspicious one at a glance. |
| 6 | **API Workspace** | Pick one endpoint and go deep: view its real route, controller, and service code, get a plain English AI explanation of what it does, define a load scenario, generate and run a k6 script, and get an AI performance report with root cause plus a proposed fix. |
| 7 | **Arena** | The finale. Three optimization strategies run concurrently in isolated environments, benchmarked live on a canvas (react flow), scored head to head, and for the winner, one click opens a real GitHub pull request. |

---

## 🧠 What happens under the hood, page by page

### 1 to 2. Landing to Repo List
GitHub OAuth gets your access token. `GET /repos` lists everything you can see; picking one hits `POST /repos/:owner/:repo/connect`, which:
- Clones the repo locally
- Detects the framework (Express only for now; anything else is rejected early with a clear message)
- Parses every route into `{ method, routePath, file, line }`
- Detects required env vars and the app's port
- Persists all of it as a `Repository` document

### 3. Observer Launcher
You fill in the env vars Axiom detected are missing. `POST /repos/:id/run` starts a Docker container (`--rm`, isolated) running your actual app, with your actual env vars, decrypted just in time. Every run is tracked in Mongo (`RunModel`) so status survives page reloads and even backend restarts.

### 4. Repo Detail
<img width="3840" height="2160" alt="Image" src="https://github.com/user-attachments/assets/d8cdcc1f-371e-498f-b3d5-996662d840ed" />

Pulls together:
- `GET /repos/:id/routes`, the parsed route table
- `GET /repos/:id/observability/health` and `/observability/system`, telling you if the container is up, if Mongo is connected, and if the run is "healthy" or "degraded" (driven by a live error rate threshold against SigNoz data)
- A `metrics observer` background loop that pushes a CPU/memory/latency snapshot over a socket every 5 seconds, straight from SigNoz's container metrics, never a locally guessed number

### 5. Endpoints Page
<img width="3840" height="2160" alt="Image" src="https://github.com/user-attachments/assets/d5516c95-1df7-41a5-a86a-f8dc5313f9da" />

`GET /repos/:id/observability/endpoints` fans out to SigNoz for every discovered route **concurrently** (capped at 4 in flight, with one retry on transient failure, since SigNoz's `query_range` path has known intermittent issues under its own internal parallelism, so a single flaky call doesn't drop a route from the table). Results are cached with a short TTL so repeat panel mounts don't re hammer SigNoz.

### 6. API Workspace
<img width="3840" height="2160" alt="Image" src="https://github.com/user-attachments/assets/a1e9273e-ca36-4d53-9a3b-8b876ca9802d" />
This is where most of the real engineering lives:

- **Connected Files** (`GET /repos/:id/connected-files`): walks from the route's registration line into its controller and one hop further (service/model) via the file's own relative imports. Real code from the real repo, not a synthetic stub.
- **Explain** (`GET /repos/:id/explain`): an **agentic loop against Groq**, with **SigNoz exposed as MCP tools**. The model can call real SigNoz tools mid reasoning (for example "check this route's last 15 minutes of traffic") before writing a plain English, non technical explanation of what the endpoint actually does for the business. Capped at 4 turns so a confused model can't loop forever. Cached per `repo:file:line`.
- **Load script generation** (`POST /repos/:id/generate-load-script`): takes your plain English scenario description and the real request shape (detected body fields, middleware, port) and generates an executable k6 script.
- **Run and Telemetry** (`POST /repos/:id/run-load-script`, `GET /repos/:id/telemetry`): executes the script for real, streaming per request results over sockets, then pulls the matching SigNoz window (latency percentiles, error rate, DB/external call breakdown) plus an auto created SigNoz dashboard link for that exact route.
- **Analyze Performance** (`POST /repos/:id/analyze-performance`): correlates the load test result, the SigNoz DB operation breakdown, and the real code to produce a root cause, severity, evidence, and a single suggested fix with a diff.
- **Apply Fix and Retest** (`POST /repos/:id/apply-fix-and-retest`): patches the real file on disk, tears down the old container, waits for it to fully release its port (avoids the classic "new container can't bind, old one hasn't let go yet" race), boots the patched version, health checks it, and re runs the *exact same* k6 script. If the patched app never comes up, the file is **reverted automatically**, so you never end up with a broken repo on disk.
- **Generate Strategies** (`POST /repos/:id/generate-strategies`): given the same evidence, asks for **three independent, meaningfully different** fixes (not three variations of the same idea), each with its own diff, confidence level, and estimated improvement range.

### 7. Arena, the showcase page
<img width="3072" height="1724" alt="Image" src="https://github.com/user-attachments/assets/4b6f9118-4636-4c4e-a146-5225ba11c5c4" />

`POST /repos/:id/init-arena` provisions a shared, isolated sandbox. Then, for each of the three strategies:
1. **Isolate**, copy the repo into its own workspace
2. **Patch**, apply that strategy's diff
3. **Deploy**, boot it in its own container
4. **Health check**, wait for it to actually respond
5. **Benchmark**, fire the same scenario at it
6. **Telemetry**, pull the matching SigNoz window

All three lanes run **concurrently**, streamed live over sockets into a react flow canvas: `Strategy → Metrics → Result`, with a fourth **Synthesis** node that lights up the moment all three report in, naming a winner scored on latency, p95, CPU, and memory together. From there, **"Open PR"** re locates each strategy's original code snippet against the repo's *current* GitHub content (not the possibly stale copy the strategy was generated against), creates blobs, tree, commit, branch, and PR through the GitHub API, and drops the full benchmark table straight into the PR description.

---

## 📡 Why SigNoz is the backbone, not a bolt on

Axiom doesn't just send some traces to SigNoz to check a box. SigNoz is the only source of truth for every number shown anywhere in the product. Nothing in Axiom is simulated, estimated, or locally computed when a real SigNoz reading is possible. Below is exactly how each SigNoz capability is used.

### 1. SigNoz MCP, the AI agent's eyes

The **Explain** feature (API Workspace) doesn't just summarize your code. It runs a real **agentic loop** where an LLM (Groq's `llama-3.3-70b-versatile`) is handed the SigNoz MCP server's tools directly:

- On each request, Axiom calls SigNoz MCP's `tools/list` and translates the tool schemas one to one into OpenAI/Groq function calling format (MCP's `inputSchema` already *is* JSON Schema, so this is a straight rename, not a translation layer).
- The model is told it *may* call these tools if live traffic context would sharpen its explanation (for example "this gets hit constantly" versus "this is barely ever triggered"). It decides for itself, per request, whether to reach for real data or answer from the code alone.
- When it calls a tool, Axiom executes it for real against the live SigNoz MCP server (`callSignozMcpTool`), feeds the actual result back into the conversation, and lets the model reason over it, for up to 4 turns before it must produce a final answer (a hard ceiling so a confused model can't loop forever).
- If the MCP server isn't reachable, Axiom degrades gracefully: it proceeds with zero tools rather than failing the whole explanation. MCP is treated as **enrichment, never a hard dependency**. The feature works with or without it, but is measurably better with it.

This means the "explain this endpoint" feature is genuinely grounded in what your service is doing *right now*, not just a static read of the source file.

### 2. SigNoz Dashboards, one real dashboard per route, not a screenshot

Every route Axiom discovers can get its own **live SigNoz dashboard**, created through SigNoz's dashboard API the first time telemetry is requested for it:

- `getOrCreateRouteDashboardUrl(serviceName, method, routePath)` checks if a dashboard already exists for that exact `(service, method, route)` triple; if not, it creates one and caches the mapping, so dashboard creation happens **once per route, ever**, not once per page view.
- The resulting `dashboardUrl` rides along on every `/telemetry` response, so the **API Workspace** and **Arena** can drop a direct "Open in SigNoz" link right next to the metrics Axiom is already showing. You're never stuck looking only at Axiom's summarized view when you want to dig into the raw traces yourself.
- Dashboard creation is fully **non blocking**: if it fails for any reason, `dashboardUrl` is simply `null` and the rest of the telemetry response still returns normally. A dashboard hiccup never breaks a benchmark.

### 3. Metrics collection, how Axiom actually pulls data out of SigNoz

Axiom reads three distinct signal types out of SigNoz, each through its own code path:

**Container level (CPU / memory)**
Pulled exclusively from SigNoz's `docker_stats` receiver, scoped to the specific container running your app or an Arena candidate. The query window is intentionally *wider* than the polling interval (30s window on a 5s poll), since the receiver's own collection interval plus normal OTLP export/ingest latency means a too narrow window can come back empty even when everything is healthy; `reduceTo: "last"` then just picks the freshest point inside that window. If SigNoz genuinely has no data point, Axiom reports `"unavailable"` and shows `0`. It never fabricates a number to fill the gap.

**Service/route level (latency, throughput, errors)**
Pulled via SigNoz's trace query (`query_range`) API using the OpenTelemetry semantic convention attributes for service name, route, and duration. Axiom runs both **scalar aggregations** (`p50()`, `p95()`, `p99()`, `count()`, for dashboards and the endpoint list) and **raw row queries** (individual trace/span rows, for the recent traces and recent errors lists), filtering with `has_error = true` where relevant. All values SigNoz returns in nanoseconds are converted to milliseconds before they ever reach the UI.

**DB / external call breakdown**
A separate SigNoz query aggregates span data by operation type (DB call, external HTTP call, and so on) over the exact window a load test ran in, producing call count, average duration, and total duration per operation. This is what lets the AI performance analyzer say something as specific as *"62% of this endpoint's time is spent in 4 sequential DB calls that could be batched into one"* instead of a vague "it's slow."

**Reliability layer on top of all three**
Every one of these queries funnels through a single internal serialized queue, because SigNoz's `query_range` path has a documented history of failing under its own internal parallelism when hit concurrently. On top of that queue sits:
- A **concurrency cap** (4 in flight) with **one automatic retry** on transient failure, so one flaky route doesn't drop out of a dashboard that's fetching 20 routes at once.
- A **short TTL cache with in flight de duplication** (`TtlCache`). Repeat panel mounts or tight poll loops join an already pending fetch instead of issuing a duplicate call, and a fetcher that throws is never cached, so a transient failure doesn't get "stuck."
- **Row level de duplication** by `(traceID, spanID)` pair, working around a confirmed SigNoz bug where the same span can be returned twice for one query.
- **Explicit cache invalidation** the moment a fix is applied and a container restarts, so you're never shown pre fix numbers under a post fix label.

The result: Axiom can safely hammer SigNoz across many routes, many concurrent Arena candidates, and tight live polling loops, and still return fast, correct, non duplicated data every time.

---

## 🛠️ Tech stack

**Backend:** Node.js, Express, TypeScript, MongoDB (Mongoose), Socket.IO, Docker (sandboxed runs), Octokit (GitHub API), Groq (`llama-3.3-70b-versatile`) for AI reasoning, k6 for load testing, SigNoz + OpenTelemetry for all observability data (including MCP tool access).

**Frontend:** React, TypeScript, `@xyflow/react` (the Arena canvas), Recharts (live charts), Tailwind, lucide react, Socket.IO client.

---

## 🚀 Getting started

> Backend requires **Docker** running locally (for sandboxed app runs and Arena candidates), a running **SigNoz** instance, a **GitHub OAuth App**, and a free **Groq API key**.

```bash
# Backend
cd server
npm install
cp .env.example .env   # fill in GROQ_API_KEY, GitHub OAuth creds, SigNoz endpoint, Mongo URI
npm run dev

# Frontend
cd client
npm install
npm run dev
```

Then:
1. Sign in with GitHub on the **Landing** page.
2. Connect a repo from the **Repo List**.
3. Fill in env vars and launch it from the **Observer Launcher**.
4. Pick a suspicious endpoint from **Endpoints**, open it in the **API Workspace**.
5. Describe a scenario, run it, review the report, generate strategies.
6. Head to the **Arena**, watch the race, open the PR for the winner.

---

## 🏆 Built for

**[Agents of SigNoz](https://www.wemakedevs.org/hackathons/signoz)** by WeMakeDevs and SigNoz, **Track 03: Build Your Own** ("observe anything with SigNoz"). Axiom takes that literally: it observes your *own backend's performance under a scenario you define*, then closes the loop by acting on what it observes, generating, racing, and shipping the fix, all grounded in real SigNoz telemetry rather than synthetic numbers.

---

## ⭐ Like what you see?

If you found this useful, consider starring the repo!
