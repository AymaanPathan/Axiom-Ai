# Axiom AI

**It doesn't guess the fix. It benchmarks it.**

Axiom AI is an autonomous backend performance engineer. It reads live telemetry from **SigNoz**, diagnoses the real bottleneck behind a slow endpoint, writes multiple independent fix strategies, benchmarks every one of them in its own isolated container under identical load, and opens a GitHub pull request for whichever strategy actually won — backed by measured numbers, not an AI's opinion.

Built solo for WeMakeDevs' **"Agents of SigNoz"** hackathon.

---

## Table of Contents

- [The Problem](#the-problem)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [SigNoz Integration](#signoz-integration)
- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [Demo Scenario](#demo-scenario)
- [Known Limitations](#known-limitations)

---

## The Problem

Most "AI fixes my code" tools do one thing: they guess. You paste in a slow endpoint, an LLM proposes a change, and you're left trusting that the fix is actually faster — with no proof, no comparison against alternatives, and no idea what it'll cost you in CPU or memory.

Axiom AI treats performance optimization the way a senior engineer actually would:

1. Don't propose a fix until you understand the bottleneck.
2. Don't commit to one fix when there are several plausible ones.
3. Don't trust a fix until you've measured it against the alternatives, under the same load, in an environment that mirrors production.

## How It Works

### 1. Diagnose
Axiom connects to your GitHub repo, maps every route, and pulls live traces, spans, and metrics for the endpoint you're investigating — straight from SigNoz. It hands back a plain-English root cause (a sequential per-item query loop, a missing index, an uncached hot read, a slow external call) along with the evidence behind it. No fix yet — just the diagnosis, the way a senior engineer would explain it before touching anything.

### 2. Propose
There is rarely only one way to fix a bottleneck. Axiom generates up to three genuinely different strategies — batching, caching, aggregation pipelines, indexing, parallelization, or extracting new helper modules — each with an estimated improvement range. Every proposed change is validated before it's trusted: the original code snippet must match your repo exactly, and any import must resolve to a package you actually have installed.

### 3. Arena
Each strategy is applied to its own isolated copy of your repository, containerized, and hit with the **exact same load-test scenario**, back to back. While each candidate runs, Axiom streams live CPU, memory, and latency telemetry pulled from SigNoz — so you watch the benchmark happen, not just the result.

### 4. Verdict
Once every candidate has reported in, Axiom scores them on a weighted combination of average latency, p95 latency, CPU, and memory, and declares a winner. Nothing here is an AI judgment call — it's arithmetic over measured numbers. From there, Axiom opens a real pull request against your repo with the winning diff, ready to review.

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Frontend   │────▶│  Express Backend  │────▶│   Groq (LLM)     │
│ React + Vite │     │   (Node + TS)     │     │  root-cause &    │
└─────────────┘     └────────┬──────────┘     │  strategy gen    │
                              │                └─────────────────┘
                              ▼
                     ┌─────────────────┐
                     │     SigNoz       │◀── live traces, spans,
                     │  (OTel backend)  │    metrics from the
                     └────────┬─────────┘    target app + arena
                              │               containers
                              ▼
                     ┌─────────────────┐
                     │  Docker Engine   │──── isolated sandbox
                     │  (Arena runner)  │     per strategy,
                     └────────┬─────────┘     benchmarked with k6
                              ▼
                     ┌─────────────────┐
                     │   GitHub API     │──── winning diff opened
                     │  (Octokit)       │     as a real PR
                     └─────────────────┘
```

Each Optimization Arena run:
- Copies the target repo into an isolated temp directory per strategy
- Applies that strategy's file changes (`applyStrategyChanges`)
- Boots it in its own Docker container on a free port
- Waits for a health check, then runs the same k6-generated load script against it
- Polls SigNoz for live container metrics and route telemetry during the run
- Tears the container and temp copy down afterward, regardless of outcome

## Tech Stack

**Frontend** — React, Vite, TypeScript, Tailwind CSS, shadcn/ui, TanStack Query, React Router, Recharts, React Flow (Optimization Arena canvas)

**Backend** — Node.js, Express, TypeScript, MongoDB (Mongoose), Redis, Socket.IO (live streaming to the UI)

**AI** — Groq (`llama-3.3-70b-versatile`) for root-cause diagnosis and multi-strategy generation

**Observability** — SigNoz, OpenTelemetry

**Load testing & sandboxing** — k6, Docker

**Integrations** — GitHub OAuth + Octokit for repo access and PR creation

## SigNoz Integration

SigNoz isn't a bolt-on data source here — it's the ground truth the whole pipeline reasons over:

- **Route-level telemetry** (`signoz-observability.service.ts`) — request count, error rate, avg/p95 latency per endpoint, with a TTL cache layered on top to avoid re-querying on every dashboard poll or panel mount.
- **Service-level aggregates** (`metrics-observer.service.ts`) — a rolling 60s window of request rate, error rate, and latency percentiles, pushed to the UI over WebSocket every 5s.
- **Arena telemetry** — each candidate strategy's container is polled independently for its own SigNoz metrics during benchmarking, so the score table reflects real, isolated measurements per strategy.
- **Resilience against known SigNoz issues** — the query layer works around two confirmed upstream bugs: intermittent 5xxs under `query_range`'s internal parallelism (retried once with backoff) and duplicate spans in list queries (de-duplicated client-side by trace/span ID).

## Getting Started

### Prerequisites

- Node.js 18+
- Docker & Docker Compose
- MongoDB instance
- Redis instance
- A running SigNoz instance (self-hosted via Docker Compose, or SigNoz Cloud)
- A [Groq API key](https://console.groq.com) (free tier)
- A GitHub OAuth App (for repo connection)

### Environment Variables

```bash
# Backend
GROQ_API_KEY=your_groq_key
MONGODB_URI=mongodb://localhost:27017/axiom
REDIS_URL=redis://localhost:6379
SIGNOZ_ENDPOINT=http://localhost:8080
GITHUB_CLIENT_ID=your_oauth_client_id
GITHUB_CLIENT_SECRET=your_oauth_client_secret
SESSION_SECRET=your_session_secret
```

### Install & Run

```bash
# clone
git clone https://github.com/<your-username>/axiom-ai.git
cd axiom-ai

# backend
cd backend
npm install
npm run dev

# frontend
cd ../frontend
npm install
npm run dev
```

Then connect a GitHub repo from the dashboard, let Axiom map its routes, and pick an endpoint to investigate.

## Project Structure

```
backend/
  src/
    services/
      signoz.service.ts              # core SigNoz query layer
      signoz-observability.service.ts # cached route/trace/error reads
      signozCache.service.ts          # TTL cache + in-flight de-dupe
      metrics-observer.service.ts     # live container + service metrics loop
      performanceAnalysis.service.ts  # Groq root-cause + strategy generation
      optimizationArena.service.ts    # isolated sandbox benchmarking
      loadScriptGenerator.service.ts  # plain-English -> k6 script
      loadScriptRunner.service.ts     # executes k6 against a target
      trafficGenerator.service.ts     # ad-hoc traffic bursts
      codePatch.service.ts            # snippet locate/apply/diff
      github-pr.service.ts            # winning-strategy PR creation
      explain.service.ts              # plain-English endpoint explainer
    parsing/
      connectedFiles.service.ts       # route -> controller -> service graph
frontend/
  src/
    pages/
      ApiWorkspace.tsx                # per-route workspace (script, run, analyze)
      RepoDetail.tsx                  # repo overview + route list
      Landing.tsx                     # marketing page
    components/
      ArenaLive.tsx                   # live Optimization Arena canvas
```

## Demo Scenario

The included demo e-commerce backend has two intentional performance issues on `GET /orders`, used to walk through the full pipeline end to end:

1. **N+1 query** — `getOrdersByUser` fetches each order's line-item products one at a time inside a loop, instead of a single batched `$in` query (`getProductsByIds` already exists, unused).
2. **Missing index** — the same query filters on `userId` and sorts on `createdAt` with no compound index backing it.

Load test prompt used in the demo:

```
150 concurrent users hitting GET /orders?userId=demo-user-1 continuously for 60 seconds, no auth, no request body.
```

## Known Limitations

- Structural loop detection (used to gate the N+1 label) only recognizes `for...of`, `.forEach`, and `.map` shapes — a `while` loop or recursive fetch pattern relies on metrics alone for diagnosis.
- Container CPU/memory in the main workspace view is read via `docker stats` rather than SigNoz's own infrastructure metrics; the Arena's per-candidate metrics do query SigNoz directly, with a `docker stats` fallback if that pipeline is lagging.
- Axiom's own reasoning steps (strategy generation, arena orchestration) are not yet emitted as spans into SigNoz — the pipeline reads from SigNoz but doesn't yet make its own agent behavior observable there.