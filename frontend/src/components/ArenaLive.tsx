// components/ArenaLive.tsx
//
// The Optimization Arena as an actual execution workspace, not a page of
// cards. Three strategies run CONCURRENTLY the moment the arena is ready —
// nobody has to click "Run" three times. Each strategy is a lane on a real
// canvas (react-flow): Strategy → Live Telemetry → Metrics → Result, wired
// left to right. Once all three finish, their Result nodes wire INTO a
// fourth node — Synthesis — which is the arena's actual verdict: the best
// measured outcome across all three, not just a list.
//
// A scenario banner up top translates the raw k6 script into plain
// English ("10 concurrent for 30s") so every graph in every lane has a
// stated frame of reference — otherwise the numbers float with no context
// for what load actually produced them.
//
// Click any node to open the inspector drawer on the right for the deep
// dive (full diff, console, request table, gauges). The canvas itself
// only shows what you need to read the state of the room at a glance.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  Handle,
  Position,
  BaseEdge,
  getBezierPath,
  useReactFlow,
  type Node,
  type Edge,
  type NodeProps,
  type EdgeProps,
  type NodeTypes,
  type EdgeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Loader2,
  Trophy,
  XCircle,
  Cpu,
  MemoryStick,
  Copy,
  GitBranch,
  Box,
  HeartPulse,
  Gauge,
  Database,
  Check,
  Terminal,
  X,
  Clock,
  ChevronDown,
  FileCode,
  Sparkles,
  Package,
  AlertTriangle,
  Play,
  RotateCcw,
  List,
  Activity,
  TrendingUp,
  GitPullRequestArrow,
  ExternalLink,
  Flag,
  Layers,
  Crown,
} from "lucide-react";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  LineChart,
  Line,
  ResponsiveContainer,
  YAxis,
  Tooltip,
} from "recharts";
import type {
  OptimizationStrategy,
  ArenaResult,
  ArenaCandidateResult,
  FileChange,
} from "../api/repos";
import {
  initArena,
  runArenaCandidate,
  finalizeArena,
  createPullRequestForStrategy,
} from "../api/repos";
import {
  useArenaStream,
  type CandidateLiveState,
} from "../hooks/useArenaStream";
import {
  MONO,
  SANS,
  BG,
  SURFACE,
  SURFACE_RAISED,
  SURFACE_SUNKEN,
  BORDER,
  BORDER_STRONG,
  TEXT_PRIMARY,
  TEXT_SECONDARY,
  TEXT_TERTIARY,
  TEXT_QUIET,
  ERROR,
  ERROR_SOFT,
  GOLD,
  ACCENT_SOFT,
  LIVE,
  LIVE_SOFT,
  CONSOLE_BG,
  CONSOLE_BORDER,
  CONSOLE_TEXT,
  CONSOLE_TEXT_DIM,
} from "../theme";

interface Props {
  repositoryId: string;
  routeIndex: number;
  routeLabel: string;
  strategies: OptimizationStrategy[];
  script: string;
  authToken?: string;
  // The plain-language scenario the user typed into the composer (e.g.
  // "100 concurrent users checking out for 30 seconds"). Shown alongside
  // the parsed k6 parameters in the scenario banner so every metric in
  // every lane has a stated frame of reference.
  description?: string;
  onClose: () => void;
  onComplete?: (result: ArenaResult) => void;
}

// ---------------------------------------------------------------------------
// Shared status vocabulary — every node/edge in the canvas reduces to one
// of these four states, and color always means the same thing everywhere.
// ---------------------------------------------------------------------------
type NodeStatus = "idle" | "active" | "done" | "failed";

function statusColor(s: NodeStatus) {
  if (s === "failed") return ERROR;
  if (s === "done") return LIVE;
  if (s === "active") return GOLD;
  return BORDER_STRONG;
}

const PIPELINE_STAGES = [
  { stage: "copying", label: "Isolate", icon: Copy },
  { stage: "patching", label: "Patch", icon: GitBranch },
  { stage: "provisioning", label: "Deploy", icon: Box },
  { stage: "healthcheck", label: "Health", icon: HeartPulse },
  { stage: "benchmarking", label: "Bench", icon: Gauge },
  { stage: "telemetry", label: "Telemetry", icon: Database },
] as const;

const STAGE_MESSAGE: Record<string, string> = {
  queued: "Waiting to start.",
  copying: "Isolating into a sandbox…",
  patching: "Applying the patch…",
  provisioning: "Booting an isolated container…",
  healthcheck: "Waiting for the app to come up…",
  benchmarking: "Sending live traffic…",
  telemetry: "Pulling trace data…",
  completed: "Finished.",
  failed: "Failed.",
};

function stageIndex(stage: string): number {
  return PIPELINE_STAGES.findIndex((p) => p.stage === stage);
}

function deriveStatus(
  stage: string,
  hasResult: boolean,
  resultStatus?: string,
): NodeStatus {
  if (hasResult) return resultStatus === "failed" ? "failed" : "done";
  if (stage === "failed") return "failed";
  if (stage === "completed") return "done";
  if (stage === "queued" || !stage) return "idle";
  return "active";
}

function useElapsed(active: boolean, since: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active || since == null) return;
    const t = setInterval(() => setNow(Date.now()), 400);
    return () => clearInterval(t);
  }, [active, since]);
  return active && since != null ? Math.max(0, now - since) : 0;
}

function fmtElapsed(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

const RANK_COLOR = [GOLD, "#9A97A8", "#C98A4D"];

const TOOLTIP_STYLE = {
  background: CONSOLE_BG,
  border: `1px solid ${CONSOLE_BORDER}`,
  borderRadius: 8,
  fontSize: 11,
  fontFamily: MONO,
  color: TEXT_SECONDARY,
};

// ---------------------------------------------------------------------------
// Scenario parsing — turns the raw k6 script into a few plain-language
// facts (concurrency, duration, iterations) so the banner and the strategy
// cards can say "10 concurrent, 30s" instead of leaving the user to infer
// it from a JS options block. Best-effort/regex-based: any field that
// doesn't match is simply omitted rather than guessed at.
// ---------------------------------------------------------------------------
interface LoadScenario {
  vus: number | null;
  durationLabel: string | null;
  iterations: number | null;
}

function parseLoadScenario(script: string): LoadScenario {
  const vusMatch = script.match(/vus\s*:\s*(\d+)/);
  const durationMatch = script.match(/duration\s*:\s*["'`]([^"'`]+)["'`]/);
  const iterationsMatch = script.match(/iterations\s*:\s*(\d+)/);
  return {
    vus: vusMatch ? Number(vusMatch[1]) : null,
    durationLabel: durationMatch ? durationMatch[1] : null,
    iterations: iterationsMatch ? Number(iterationsMatch[1]) : null,
  };
}

function scenarioChips(scenario: LoadScenario): string[] {
  const chips: string[] = [];
  if (scenario.vus != null) chips.push(`${scenario.vus} concurrent`);
  if (scenario.durationLabel) chips.push(scenario.durationLabel);
  if (scenario.iterations != null) chips.push(`${scenario.iterations} iters`);
  return chips;
}

// ---------------------------------------------------------------------------
// Layout — three fixed lanes, five columns. Nothing is draggable; this is
// a status board, not a diagramming tool.
// ---------------------------------------------------------------------------
const COL_STRATEGY = 40;
const COL_TELEMETRY = 460;
const COL_METRICS = 880;
const COL_RESULT = 1300;
const COL_SYNTHESIS = 1620;
const LANE_H = 300;
const LANE_TOP = 40;

const NODE_W = {
  strategy: 380,
  telemetry: 380,
  metrics: 380,
  result: 280,
  synthesis: 320,
};

// ===========================================================================
// Custom edge — a bezier wire that only "runs" (animated flowing dot) while
// data is genuinely moving between the two nodes it connects.
// ===========================================================================
function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const status = (data?.status as NodeStatus) ?? "idle";
  const color = statusColor(status);
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.35,
  });
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: color,
          strokeWidth: status === "idle" ? 1.5 : 2,
          opacity: status === "idle" ? 0.35 : 0.85,
        }}
      />
      {status === "active" && (
        <circle r="3.5" fill={color}>
          <animateMotion dur="1.4s" repeatCount="indefinite" path={path} />
        </circle>
      )}
    </>
  );
}

const edgeTypes: EdgeTypes = { flow: FlowEdge };

// ===========================================================================
// Node — Strategy (merged header + pipeline stepper). This is the "engine"
// of the lane: what's being tried, and exactly which of the six real steps
// it's on right now.
// ===========================================================================
interface StrategyNodeData {
  index: number;
  strategy: OptimizationStrategy;
  stage: string;
  status: NodeStatus;
  startedAt: number | null;
  errorText?: string;
  scenarioChips: string[];
  selected: boolean;
  onSelect: () => void;
  onRun: () => void;
  canRun: boolean;
}

function StrategyNode({ data }: NodeProps) {
  const d = data as unknown as StrategyNodeData;
  const { strategy, stage, status } = d;
  const idx = stageIndex(stage);
  const pipeDone =
    status === "done"
      ? PIPELINE_STAGES.length
      : Math.max(idx, 0) + (status === "active" ? 1 : 0);
  const elapsed = useElapsed(status === "active", d.startedAt);
  const color = statusColor(status);

  return (
    <div
      className="arena-node"
      onClick={d.onSelect}
      style={{
        width: NODE_W.strategy,
        borderRadius: 16,
        border: `1px solid ${d.selected ? color : BORDER}`,
        borderWidth: d.selected ? 2 : 1,
        background: BG,
        boxShadow: d.selected
          ? `0 0 0 3px ${status === "failed" ? ERROR_SOFT : ACCENT_SOFT}, 0 8px 24px rgba(20,17,0,0.06)`
          : "0 1px 2px rgba(20,17,0,0.04)",
        cursor: "pointer",
        overflow: "hidden",
      }}
    >
      <Handle type="source" position={Position.Right} style={handleStyle} />

      <div
        className="flex items-center gap-2.5 border-b px-4 py-3"
        style={{ borderColor: BORDER }}
      >
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
          style={{
            border: `1.5px solid ${color}`,
            color,
            background: status === "active" ? ACCENT_SOFT : "transparent",
            animation:
              status === "active"
                ? "arenaPulse 1.6s ease-in-out infinite"
                : undefined,
          }}
        >
          {status === "done" ? (
            <Check size={13} />
          ) : status === "failed" ? (
            <XCircle size={13} />
          ) : (
            d.index + 1
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-[13.5px] font-semibold"
            style={{ color: TEXT_PRIMARY, fontFamily: MONO }}
          >
            {strategy.title}
          </div>
          <div
            className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[0.05em]"
            style={{ color: TEXT_QUIET }}
          >
            {strategy.approach}
          </div>
        </div>
        {status === "active" && (
          <span
            className="shrink-0 text-[11px] font-semibold tabular-nums"
            style={{ color: TEXT_TERTIARY, fontFamily: MONO }}
          >
            {fmtElapsed(elapsed)}
          </span>
        )}
      </div>

      <div className="px-4 py-3.5">
        {d.scenarioChips.length > 0 && (
          <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
            {d.scenarioChips.map((chip) => (
              <span
                key={chip}
                className="rounded-full px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.03em]"
                style={{ background: SURFACE_SUNKEN, color: TEXT_TERTIARY }}
              >
                {chip}
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between">
          <span
            className="text-[12px] font-medium"
            style={{ color: status === "failed" ? ERROR : TEXT_SECONDARY }}
          >
            {status === "idle"
              ? "Queued to start"
              : status === "failed"
                ? (d.errorText ?? "Failed")
                : status === "done"
                  ? "Benchmark complete"
                  : STAGE_MESSAGE[stage]}
          </span>
          <span
            className="rounded-full px-1.5 py-0.5 text-[10px] font-bold"
            style={{ background: SURFACE_SUNKEN, color: TEXT_QUIET }}
          >
            +{strategy.estimatedImprovementPercent.min}–
            {strategy.estimatedImprovementPercent.max}%
          </span>
        </div>

        <div className="mt-3 flex items-center gap-[3px]">
          {PIPELINE_STAGES.map((p, i) => (
            <div key={p.stage} className="group flex-1">
              <div
                className="h-[6px] rounded-full"
                style={{
                  background: i < pipeDone ? color : SURFACE_SUNKEN,
                }}
              />
            </div>
          ))}
        </div>
        <div
          className="mt-1.5 flex justify-between text-[9px] font-semibold uppercase tracking-[0.04em]"
          style={{ color: TEXT_QUIET }}
        >
          <span>{PIPELINE_STAGES[0].label}</span>
          <span>{PIPELINE_STAGES[PIPELINE_STAGES.length - 1].label}</span>
        </div>

        {(status === "idle" || status === "failed") && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (d.canRun) d.onRun();
            }}
            disabled={!d.canRun}
            className="mt-3.5 flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[11.5px] font-bold transition-all hover:brightness-105 disabled:opacity-40"
            style={{ background: GOLD, color: "#241C00" }}
          >
            {status === "failed" ? <RotateCcw size={12} /> : <Play size={12} />}
            {status === "failed" ? "Retry strategy" : "Run strategy"}
          </button>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// Node — Live Telemetry. Status-and-pulse card: is this candidate alive
// right now, and what's the last thing it logged. The deep numeric/graph
// story now lives one hop further right, in the dedicated Metrics node —
// this card stays a lightweight "is it breathing" readout.
// ===========================================================================
interface TelemetryNodeData {
  live?: CandidateLiveState;
  status: NodeStatus;
  selected: boolean;
  onSelect: () => void;
}

function Sparkline({ data, color }: { data: number[]; color: string }) {
  const chartData = useMemo(() => data.map((v, i) => ({ i, v })), [data]);
  if (chartData.length < 2) {
    return (
      <div
        className="flex h-9 items-center text-[10px]"
        style={{ color: TEXT_QUIET }}
      >
        sampling…
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={36}>
      <AreaChart data={chartData}>
        <YAxis hide domain={["auto", "auto"]} />
        <Area
          type="monotone"
          dataKey="v"
          stroke={color}
          fill={color}
          fillOpacity={0.14}
          strokeWidth={1.5}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function TelemetryNode({ data }: NodeProps) {
  const d = data as unknown as TelemetryNodeData;
  const { live, status } = d;
  const color = statusColor(status);
  const lastLog = live?.logs[live.logs.length - 1];
  const latestMetric = live?.metrics[live.metrics.length - 1];
  const reqCount = live?.requestLog.length ?? 0;
  const errCount = (live?.requestLog ?? []).filter((r) => !r.ok).length;

  return (
    <div
      className="arena-node"
      onClick={d.onSelect}
      style={{
        width: NODE_W.telemetry,
        borderRadius: 16,
        border: `1px solid ${d.selected ? color : BORDER}`,
        borderWidth: d.selected ? 2 : 1,
        background: BG,
        boxShadow: d.selected
          ? `0 0 0 3px ${ACCENT_SOFT}, 0 8px 24px rgba(20,17,0,0.06)`
          : "0 1px 2px rgba(20,17,0,0.04)",
        cursor: "pointer",
        opacity: status === "idle" ? 0.5 : 1,
      }}
    >
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <Handle type="source" position={Position.Right} style={handleStyle} />

      <div
        className="flex items-center justify-between border-b px-4 py-2.5"
        style={{ borderColor: BORDER }}
      >
        <span
          className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.06em]"
          style={{ color: TEXT_TERTIARY }}
        >
          <Activity
            size={12}
            style={{ color: status === "active" ? LIVE : TEXT_QUIET }}
          />
          Live telemetry
        </span>
        {status === "active" && (
          <span
            className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase"
            style={{ background: LIVE_SOFT, color: LIVE }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{
                background: LIVE,
                animation: "arenaPulse 1.4s ease-in-out infinite",
              }}
            />
            live
          </span>
        )}
      </div>

      <div className="px-4 py-3">
        <div className="grid grid-cols-3 gap-2">
          <MiniReadout
            icon={Cpu}
            label="CPU"
            value={
              latestMetric ? `${Math.round(latestMetric.cpuPercent)}%` : "—"
            }
          />
          <MiniReadout
            icon={MemoryStick}
            label="Mem"
            value={
              latestMetric ? `${Math.round(latestMetric.memoryMB)}MB` : "—"
            }
          />
          <MiniReadout
            icon={TrendingUp}
            label="Reqs"
            value={String(reqCount)}
            accent={errCount > 0 ? ERROR : undefined}
          />
        </div>

        <div
          className="mt-3 truncate rounded-lg px-2.5 py-1.5 text-[10.5px]"
          style={{
            background: CONSOLE_BG,
            border: `1px solid ${CONSOLE_BORDER}`,
            color: lastLog ? CONSOLE_TEXT : CONSOLE_TEXT_DIM,
            fontFamily: MONO,
          }}
        >
          {lastLog ? lastLog.slice(0, 54) : "waiting for output…"}
        </div>
      </div>
    </div>
  );
}

function MiniReadout({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: typeof Cpu;
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div
      className="rounded-lg px-2 py-1.5 text-center"
      style={{ background: SURFACE_RAISED }}
    >
      <div
        className="flex items-center justify-center gap-1"
        style={{ color: TEXT_QUIET }}
      >
        <Icon size={10} />
        <span className="text-[9px] font-semibold uppercase tracking-[0.04em]">
          {label}
        </span>
      </div>
      <div
        className="mt-0.5 text-[12.5px] font-bold"
        style={{ color: accent ?? TEXT_PRIMARY, fontFamily: MONO }}
      >
        {value}
      </div>
    </div>
  );
}

// ===========================================================================
// Node — Metrics. The real per-strategy dashboard: a live latency line, a
// throughput bar chart bucketed per second, and CPU/memory readouts, all
// scoped to whatever scenario the user actually asked for (shown in the
// header, e.g. "Metrics — 10 concurrent"). Clicking it opens the same
// inspector drawer as Telemetry — the deep-dive gauges, console, and
// request table live there, this node is the "read the room" view.
// ===========================================================================
interface MetricsNodeData {
  scenario: LoadScenario;
  live?: CandidateLiveState;
  result?: ArenaCandidateResult;
  status: NodeStatus;
  selected: boolean;
  onSelect: () => void;
}

function MetricsNode({ data }: NodeProps) {
  const d = data as unknown as MetricsNodeData;
  const { live, result, status, scenario } = d;
  const color = statusColor(status);

  const latencyData = useMemo(
    () =>
      (live?.requestLog ?? [])
        .filter((r) => r.durationMs != null)
        .map((r) => ({ i: r.index, latency: r.durationMs as number })),
    [live?.requestLog],
  );

  const throughputData = useMemo(() => {
    const entries = live?.requestLog ?? [];
    if (entries.length === 0) return [];
    const buckets = new Map<number, number>();
    for (const r of entries) {
      const sec = Math.floor(r.timestamp / 1000);
      buckets.set(sec, (buckets.get(sec) ?? 0) + 1);
    }
    const keys = [...buckets.keys()].sort((a, b) => a - b);
    return keys.map((k, i) => ({ i, rps: buckets.get(k)! }));
  }, [live?.requestLog]);

  const latestMetric = live?.metrics[live.metrics.length - 1];
  const lastLog = live?.logs[live.logs.length - 1];
  const chips = scenarioChips(scenario);

  const avgLatency = result?.runResult
    ? Math.round(result.runResult.avgDurationMs)
    : latencyData.length
      ? Math.round(latencyData[latencyData.length - 1].latency)
      : null;
  const latestThroughput = throughputData.length
    ? throughputData[throughputData.length - 1].rps
    : null;

  return (
    <div
      className="arena-node"
      onClick={d.onSelect}
      style={{
        width: NODE_W.metrics,
        borderRadius: 16,
        border: `1px solid ${d.selected ? color : BORDER}`,
        borderWidth: d.selected ? 2 : 1,
        background: BG,
        boxShadow: d.selected
          ? `0 0 0 3px ${ACCENT_SOFT}, 0 8px 24px rgba(20,17,0,0.06)`
          : "0 1px 2px rgba(20,17,0,0.04)",
        cursor: "pointer",
        opacity: status === "idle" ? 0.5 : 1,
      }}
    >
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <Handle type="source" position={Position.Right} style={handleStyle} />

      <div
        className="flex items-center justify-between gap-2 border-b px-4 py-2.5"
        style={{ borderColor: BORDER }}
      >
        <span
          className="flex min-w-0 items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.06em]"
          style={{ color: TEXT_TERTIARY }}
        >
          <Gauge
            size={12}
            style={{ color: status === "active" ? LIVE : TEXT_QUIET }}
          />
          <span className="truncate">
            Metrics{chips.length > 0 ? ` — ${chips[0]}` : ""}
          </span>
        </span>
        {status === "active" && (
          <span
            className="flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase"
            style={{ background: LIVE_SOFT, color: LIVE }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{
                background: LIVE,
                animation: "arenaPulse 1.4s ease-in-out infinite",
              }}
            />
            live
          </span>
        )}
      </div>

      <div className="px-4 py-3">
        {chips.length > 1 && (
          <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
            {chips.slice(1).map((chip) => (
              <span
                key={chip}
                className="rounded-full px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.03em]"
                style={{ background: SURFACE_SUNKEN, color: TEXT_TERTIARY }}
              >
                {chip}
              </span>
            ))}
          </div>
        )}

        <div
          className="mb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.05em]"
          style={{ color: TEXT_QUIET }}
        >
          <span>Latency / request</span>
          <span style={{ color: TEXT_SECONDARY, fontFamily: MONO }}>
            {avgLatency != null ? `${avgLatency}ms` : "—"}
          </span>
        </div>
        <div className="h-[60px]">
          {latencyData.length > 1 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={latencyData}>
                <YAxis hide domain={[0, "auto"]} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  labelFormatter={(l) => `request #${l}`}
                  formatter={(v: number) => [`${Math.round(v)}ms`, "latency"]}
                />
                <Area
                  type="monotone"
                  dataKey="latency"
                  stroke={GOLD}
                  fill={GOLD}
                  fillOpacity={0.16}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div
              className="flex h-full items-center text-[11px]"
              style={{ color: TEXT_QUIET }}
            >
              Plots as each request finishes…
            </div>
          )}
        </div>

        <div
          className="mt-3 mb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.05em]"
          style={{ color: TEXT_QUIET }}
        >
          <span>Throughput</span>
          <span style={{ color: TEXT_SECONDARY, fontFamily: MONO }}>
            {latestThroughput != null ? `${latestThroughput} req/s` : "—"}
          </span>
        </div>
        <div className="h-[52px]">
          {throughputData.length > 1 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={throughputData}>
                <YAxis hide domain={[0, "auto"]} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v: number) => [`${v}`, "req/s"]}
                />
                <Bar
                  dataKey="rps"
                  fill={LIVE}
                  radius={[2, 2, 0, 0]}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div
              className="flex h-full items-center text-[11px]"
              style={{ color: TEXT_QUIET }}
            >
              Bucketing requests/sec…
            </div>
          )}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <MiniReadout
            icon={Cpu}
            label="CPU"
            value={
              latestMetric ? `${Math.round(latestMetric.cpuPercent)}%` : "—"
            }
          />
          <MiniReadout
            icon={MemoryStick}
            label="Mem"
            value={
              latestMetric ? `${Math.round(latestMetric.memoryMB)}MB` : "—"
            }
          />
        </div>

        <div
          className="mt-3 truncate rounded-lg px-2.5 py-1.5 text-[10.5px]"
          style={{
            background: CONSOLE_BG,
            border: `1px solid ${CONSOLE_BORDER}`,
            color: lastLog ? CONSOLE_TEXT : CONSOLE_TEXT_DIM,
            fontFamily: MONO,
          }}
        >
          {lastLog ? lastLog.slice(0, 58) : "waiting for log output…"}
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// Node — Result. The scorecard for one lane.
// ===========================================================================
interface ResultNodeData {
  strategy: OptimizationStrategy;
  result?: ArenaCandidateResult;
  status: NodeStatus;
  isWinner: boolean;
  selected: boolean;
  onSelect: () => void;
}

function ResultNode({ data }: NodeProps) {
  const d = data as unknown as ResultNodeData;
  const { result, status, isWinner } = d;
  const color = statusColor(status);

  return (
    <div
      className="arena-node"
      onClick={d.onSelect}
      style={{
        width: NODE_W.result,
        borderRadius: 16,
        border: `1px solid ${isWinner ? GOLD : d.selected ? color : BORDER}`,
        borderWidth: isWinner || d.selected ? 2 : 1,
        background: isWinner ? "#FFFBEE" : BG,
        boxShadow: d.selected
          ? `0 0 0 3px ${ACCENT_SOFT}, 0 8px 24px rgba(20,17,0,0.06)`
          : "0 1px 2px rgba(20,17,0,0.04)",
        cursor: "pointer",
        opacity: status === "idle" || status === "active" ? 0.45 : 1,
        padding: "16px",
        textAlign: "center",
      }}
    >
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <Handle type="source" position={Position.Right} style={handleStyle} />

      {isWinner && (
        <div
          className="mb-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.05em]"
          style={{ background: GOLD, color: "#241C00" }}
        >
          <Crown size={10} /> Leading
        </div>
      )}

      {!result ? (
        <div className="py-3">
          <span className="text-[11.5px]" style={{ color: TEXT_QUIET }}>
            Awaiting benchmark…
          </span>
        </div>
      ) : result.status === "failed" ? (
        <div className="flex flex-col items-center gap-1 py-2">
          <XCircle size={18} style={{ color: ERROR }} />
          <span
            className="text-[11.5px] font-semibold"
            style={{ color: ERROR }}
          >
            Run failed
          </span>
        </div>
      ) : (
        <>
          <div
            className="text-[26px] font-black leading-none"
            style={{ color: TEXT_PRIMARY, fontFamily: MONO }}
          >
            {result.runResult
              ? Math.round(result.runResult.avgDurationMs)
              : "—"}
            <span
              className="text-[13px] font-semibold"
              style={{ color: TEXT_QUIET }}
            >
              ms
            </span>
          </div>
          <div
            className="text-[10px] font-semibold uppercase tracking-[0.05em]"
            style={{ color: TEXT_QUIET }}
          >
            avg latency
          </div>
          <div
            className="mt-2.5 flex items-center justify-center gap-3 text-[11px]"
            style={{ fontFamily: MONO, color: TEXT_TERTIARY }}
          >
            <span>
              p95{" "}
              {result.runResult?.p95DurationMs != null
                ? `${Math.round(result.runResult.p95DurationMs)}ms`
                : "—"}
            </span>
            <span style={{ color: BORDER_STRONG }}>·</span>
            <span
              style={{
                color:
                  result.runResult && result.runResult.errorCount > 0
                    ? ERROR
                    : TEXT_TERTIARY,
              }}
            >
              {result.runResult?.errorCount ?? 0} err
            </span>
          </div>
          <div
            className="mt-2.5 rounded-lg py-1.5 text-[13px] font-bold"
            style={{
              background: isWinner ? GOLD : SURFACE_RAISED,
              color: isWinner ? "#241C00" : TEXT_PRIMARY,
              fontFamily: MONO,
            }}
          >
            score {result.score ?? "—"}
          </div>
        </>
      )}
    </div>
  );
}

// ===========================================================================
// Node — Synthesis. The point of running three strategies at once: not a
// list, a verdict. Fed by all three Result nodes; dim and waiting until
// they've all reported in, then resolves into the arena's actual answer.
// ===========================================================================
interface SynthesisNodeData {
  strategies: OptimizationStrategy[];
  results: Record<string, ArenaCandidateResult>;
  totalCount: number;
  winnerStrategyId: string | null;
  ready: boolean;
  onOpenReport: () => void;
}

function SynthesisNode({ data }: NodeProps) {
  const d = data as unknown as SynthesisNodeData;
  const doneResults = Object.values(d.results);
  const completed = doneResults.filter((r) => r.status === "completed");
  const winner = completed.find((r) => r.strategyId === d.winnerStrategyId);
  const winnerStrategy = winner
    ? d.strategies.find((s) => s.id === winner.strategyId)
    : undefined;

  const baselineAvg =
    completed.length > 0
      ? Math.max(...completed.map((c) => c.runResult?.avgDurationMs ?? 0))
      : null;
  const improvementVsWorst =
    winner?.runResult && baselineAvg
      ? Math.round(
          ((baselineAvg - winner.runResult.avgDurationMs) / baselineAvg) * 100,
        )
      : null;

  return (
    <div
      style={{
        width: NODE_W.synthesis,
        borderRadius: 18,
        border: `1.5px solid ${d.ready ? GOLD : BORDER}`,
        background: d.ready
          ? "linear-gradient(165deg, #FFFBEA, #FFF7D6)"
          : SURFACE,
        boxShadow: d.ready
          ? "0 12px 32px rgba(245,196,0,0.16)"
          : "0 1px 2px rgba(20,17,0,0.04)",
        opacity: d.ready ? 1 : 0.55,
        padding: "20px",
      }}
    >
      <Handle type="target" position={Position.Left} style={handleStyle} />

      <div className="flex items-center gap-2">
        <div
          className="flex h-8 w-8 items-center justify-center rounded-full"
          style={{ background: d.ready ? GOLD : SURFACE_SUNKEN }}
        >
          <Trophy
            size={14}
            style={{ color: d.ready ? "#241C00" : TEXT_QUIET }}
          />
        </div>
        <div>
          <div
            className="text-[10.5px] font-bold uppercase tracking-[0.06em]"
            style={{ color: TEXT_TERTIARY }}
          >
            Synthesis
          </div>
          <div
            className="text-[13px] font-semibold"
            style={{ color: TEXT_PRIMARY }}
          >
            {d.ready
              ? "Best measured outcome"
              : `Waiting on ${d.totalCount - completed.length} of ${d.totalCount}`}
          </div>
        </div>
      </div>

      {d.ready && winnerStrategy ? (
        <div className="mt-4">
          <div
            className="truncate text-[14px] font-bold"
            style={{ color: TEXT_PRIMARY, fontFamily: MONO }}
          >
            {winnerStrategy.title}
          </div>
          <p
            className="mt-1 text-[11.5px] leading-[1.5]"
            style={{ color: TEXT_SECONDARY }}
          >
            Fastest and cheapest of the {completed.length} measured — chosen on
            latency, p95, CPU, and memory together, not latency alone.
          </p>

          <div className="mt-3 flex items-end gap-2">
            {d.strategies.map((s) => {
              const r = d.results[s.id];
              const isWinner = s.id === d.winnerStrategyId;
              const score = r?.score ?? 0;
              const maxScore = Math.max(
                ...completed.map((c) => c.score ?? 0),
                1,
              );
              const h = Math.max(6, (score / maxScore) * 44);
              return (
                <div
                  key={s.id}
                  className="flex flex-1 flex-col items-center gap-1"
                >
                  <div
                    className="w-full rounded-t-md"
                    style={{
                      height: h,
                      background: isWinner ? GOLD : BORDER_STRONG,
                    }}
                  />
                  <span
                    className="text-[9px] font-bold"
                    style={{ color: isWinner ? "#8A6D00" : TEXT_QUIET }}
                  >
                    {s.id}
                  </span>
                </div>
              );
            })}
          </div>

          {improvementVsWorst != null && improvementVsWorst > 0 && (
            <div
              className="mt-3 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold"
              style={{ background: GOLD, color: "#241C00" }}
            >
              <Sparkles size={11} /> {improvementVsWorst}% faster than the
              slowest run
            </div>
          )}

          <button
            onClick={d.onOpenReport}
            className="mt-3.5 flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-[11.5px] font-bold transition-colors"
            style={{ borderColor: "#8A6D00", color: "#8A6D00" }}
          >
            Open full report <ExternalLink size={11} />
          </button>
        </div>
      ) : (
        <p className="mt-3 text-[11.5px]" style={{ color: TEXT_QUIET }}>
          Resolves the moment every lane reports a result — combining latency,
          error rate, CPU, and memory into one verdict.
        </p>
      )}
    </div>
  );
}

const handleStyle = {
  background: "transparent",
  border: "none",
  width: 1,
  height: 1,
};

const nodeTypes: NodeTypes = {
  strategy: StrategyNode,
  telemetry: TelemetryNode,
  metrics: MetricsNode,
  result: ResultNode,
  synthesis: SynthesisNode,
};

// ---------------------------------------------------------------------------
// Scenario banner — sits above the canvas, restating what the user asked
// for ("100 concurrent users checking out for 30 seconds") next to the
// parsed k6 parameters, so every graph in every lane has a stated frame of
// reference instead of floating numbers with no context.
// ---------------------------------------------------------------------------
function ScenarioBanner({
  description,
  scenario,
}: {
  description?: string;
  scenario: LoadScenario;
}) {
  const chips = scenarioChips(scenario);
  if (!description && chips.length === 0) return null;
  return (
    <div className="relative z-20 px-6 pt-3">
      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border px-4 py-2.5"
        style={{ borderColor: BORDER_STRONG, background: SURFACE }}
      >
        <span
          className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.06em]"
          style={{ color: TEXT_TERTIARY }}
        >
          <Flag size={12} /> Scenario
        </span>
        {description && (
          <span className="text-[12.5px]" style={{ color: TEXT_SECONDARY }}>
            "{description}"
          </span>
        )}
        {chips.map((chip) => (
          <span
            key={chip}
            className="rounded-full border px-2 py-0.5 text-[11px] font-semibold"
            style={{
              borderColor: BORDER_STRONG,
              color: TEXT_PRIMARY,
              fontFamily: MONO,
            }}
          >
            {chip}
          </span>
        ))}
        <span className="ml-auto text-[11px]" style={{ color: TEXT_QUIET }}>
          Every graph below measures this same scenario, once per strategy.
        </span>
      </div>
    </div>
  );
}

// ===========================================================================
// Main component
// ===========================================================================
export default function ArenaLive({
  repositoryId,
  routeIndex,
  routeLabel,
  strategies,
  script,
  authToken,
  description,
  onClose,
  onComplete,
}: Props) {
  const [arenaId, setArenaId] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [arenaStartedAt] = useState(() => Date.now());
  const { candidates, prewarm, error: streamError } = useArenaStream(arenaId);

  const scenario = useMemo(() => parseLoadScenario(script), [script]);

  const [completedResults, setCompletedResults] = useState<
    Record<string, ArenaCandidateResult>
  >({});
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const [startedAt, setStartedAt] = useState<Record<string, number>>({});
  const [runError, setRunError] = useState<string | null>(null);

  const [finalResult, setFinalResult] = useState<ArenaResult | null>(null);
  const [finalizing, setFinalizing] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedKind, setSelectedKind] = useState<
    "strategy" | "telemetry" | "result" | null
  >(null);
  const [reportOpen, setReportOpen] = useState(false);

  const initedRef = useRef(false);
  useEffect(() => {
    if (initedRef.current) return;
    initedRef.current = true;
    initArena(repositoryId, routeIndex)
      .then((r) => setArenaId(r.arenaId))
      .catch((err) =>
        setInitError(
          err instanceof Error ? err.message : "Failed to start arena",
        ),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const handleRun = useCallback(
    async (strategy: OptimizationStrategy) => {
      if (!arenaId) return;
      setRunningIds((prev) => new Set(prev).add(strategy.id));
      setStartedAt((prev) => ({ ...prev, [strategy.id]: Date.now() }));
      setCompletedResults((prev) => {
        const next = { ...prev };
        delete next[strategy.id];
        return next;
      });
      setRunError(null);
      try {
        const result = await runArenaCandidate(
          repositoryId,
          arenaId,
          strategy,
          script,
          authToken,
        );
        setCompletedResults((prev) => ({ ...prev, [strategy.id]: result }));
      } catch (err) {
        setRunError(err instanceof Error ? err.message : "Strategy run failed");
      } finally {
        setRunningIds((prev) => {
          const next = new Set(prev);
          next.delete(strategy.id);
          return next;
        });
      }
    },
    [arenaId, repositoryId, script, authToken],
  );

  // Launch every strategy the instant the arena is ready — the whole point
  // is that they run AT THE SAME TIME. No queueing on a single "running" flag.
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (autoStartedRef.current) return;
    if (!arenaId || prewarm.status !== "done") return;
    autoStartedRef.current = true;
    for (const s of strategies) void handleRun(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arenaId, prewarm.status]);

  const testedCount = strategies.filter((s) => completedResults[s.id]).length;
  const allTested = testedCount === strategies.length;

  // Auto-finalize the instant every lane has reported — the synthesis node
  // resolves on its own, no "click to see who won" gate.
  const finalizedRef = useRef(false);
  useEffect(() => {
    if (finalizedRef.current || !allTested || !arenaId || finalResult) return;
    finalizedRef.current = true;
    setFinalizing(true);
    finalizeArena(repositoryId, arenaId)
      .then((result) => {
        setFinalResult(result);
        onComplete?.(result);
      })
      .catch((err) => {
        finalizedRef.current = false;
        setRunError(
          err instanceof Error ? err.message : "Failed to score results",
        );
      })
      .finally(() => setFinalizing(false));
  }, [allTested, arenaId, finalResult, repositoryId, onComplete]);

  const totalElapsed = useElapsed(!finalResult, arenaStartedAt);
  const totalRequestsFired = useMemo(
    () =>
      Object.values(candidates).reduce(
        (sum, c) => sum + c.requestLog.length,
        0,
      ),
    [candidates],
  );
  const runningCount = runningIds.size;

  // ---- build react-flow graph -------------------------------------------
  const winnerStrategyId = finalResult?.winnerStrategyId ?? null;

  // The layout is fixed (nothing is draggable), so the canvas bounds are
  // knowable up front. Clamping panning to a margin around them means a
  // stray scroll/trackpad gesture can never drag the board out of view —
  // that was the bug: panOnScroll turned an ordinary mouse-wheel scroll
  // into a pan, and with no minimap there was no way to tell the board
  // had drifted off past the other lanes.
  const canvasBounds = useMemo((): [[number, number], [number, number]] => {
    const width = COL_SYNTHESIS + NODE_W.synthesis + 200;
    const height = LANE_TOP + strategies.length * LANE_H + 200;
    return [
      [-200, -200],
      [width, height],
    ];
  }, [strategies.length]);

  const rfInstanceRef = useRef<ReactFlowInstance | null>(null);
  const fitOnceRef = useRef(false);
  const handleInit = useCallback((instance: ReactFlowInstance) => {
    rfInstanceRef.current = instance;
    // Fit once more shortly after mount — the first pass can run before
    // custom nodes report their real measured size, which used to leave
    // fitView zoomed/panned to an incomplete bounding box.
    if (!fitOnceRef.current) {
      fitOnceRef.current = true;
      setTimeout(() => instance.fitView({ padding: 0.15, duration: 200 }), 80);
    }
  }, []);

  const scenarioChipsList = useMemo(() => scenarioChips(scenario), [scenario]);

  const nodes: Node[] = useMemo(() => {
    const list: Node[] = [];
    strategies.forEach((s, i) => {
      const live = candidates[s.id];
      const result = completedResults[s.id];
      const stage = live?.stage ?? (result ? result.status : "queued");
      const status = deriveStatus(stage, !!result, result?.status);
      const y = LANE_TOP + i * LANE_H;

      list.push({
        id: `strategy-${s.id}`,
        type: "strategy",
        position: { x: COL_STRATEGY, y },
        width: NODE_W.strategy,
        draggable: false,
        selectable: true,
        data: {
          index: i,
          strategy: s,
          stage,
          status,
          startedAt: startedAt[s.id] ?? null,
          errorText: live?.error ?? result?.error,
          scenarioChips: scenarioChipsList,
          selected: selectedId === s.id && selectedKind === "strategy",
          onSelect: () => {
            setSelectedId(s.id);
            setSelectedKind("strategy");
          },
          onRun: () => void handleRun(s),
          canRun: !runningIds.has(s.id),
        } satisfies StrategyNodeData,
      } as Node);

      const telemetryStatus: NodeStatus =
        status === "active" ? "active" : status === "idle" ? "idle" : status;
      list.push({
        id: `telemetry-${s.id}`,
        type: "telemetry",
        position: { x: COL_TELEMETRY, y: y + 20 },
        width: NODE_W.telemetry,
        draggable: false,
        data: {
          live,
          status: telemetryStatus,
          selected: selectedId === s.id && selectedKind === "telemetry",
          onSelect: () => {
            setSelectedId(s.id);
            setSelectedKind("telemetry");
          },
        } satisfies TelemetryNodeData,
      } as Node);

      list.push({
        id: `metrics-${s.id}`,
        type: "metrics",
        position: { x: COL_METRICS, y: y + 10 },
        width: NODE_W.metrics,
        draggable: false,
        data: {
          scenario,
          live,
          result,
          status: telemetryStatus,
          // Reuses the "telemetry" inspector kind so clicking the Metrics
          // node opens the same rich drawer (gauges, console, requests)
          // Telemetry does — no separate drawer to keep in sync.
          selected: selectedId === s.id && selectedKind === "telemetry",
          onSelect: () => {
            setSelectedId(s.id);
            setSelectedKind("telemetry");
          },
        } satisfies MetricsNodeData,
      } as Node);

      list.push({
        id: `result-${s.id}`,
        type: "result",
        position: { x: COL_RESULT, y: y + 30 },
        width: NODE_W.result,
        draggable: false,
        data: {
          strategy: s,
          result,
          status,
          isWinner: !!result && s.id === winnerStrategyId,
          selected: selectedId === s.id && selectedKind === "result",
          onSelect: () => {
            setSelectedId(s.id);
            setSelectedKind("result");
          },
        } satisfies ResultNodeData,
      } as Node);
    });

    list.push({
      id: "synthesis",
      type: "synthesis",
      position: { x: COL_SYNTHESIS, y: LANE_TOP + LANE_H },
      width: NODE_W.synthesis,
      draggable: false,
      selectable: false,
      data: {
        strategies,
        results: completedResults,
        totalCount: strategies.length,
        winnerStrategyId,
        ready: !!finalResult,
        onOpenReport: () => setReportOpen(true),
      } satisfies SynthesisNodeData,
    } as Node);

    return list;
  }, [
    strategies,
    candidates,
    completedResults,
    startedAt,
    selectedId,
    selectedKind,
    runningIds,
    winnerStrategyId,
    finalResult,
    handleRun,
    scenario,
    scenarioChipsList,
  ]);

  const edges: Edge[] = useMemo(() => {
    const list: Edge[] = [];
    strategies.forEach((s) => {
      const live = candidates[s.id];
      const result = completedResults[s.id];
      const stage = live?.stage ?? (result ? result.status : "queued");
      const status = deriveStatus(stage, !!result, result?.status);
      const pipelineActive = status === "active";
      const branchActive = stage === "benchmarking" || stage === "telemetry";

      list.push({
        id: `e-strat-tel-${s.id}`,
        source: `strategy-${s.id}`,
        target: `telemetry-${s.id}`,
        type: "flow",
        data: {
          status:
            pipelineActive || status === "done"
              ? pipelineActive
                ? "active"
                : "done"
              : status,
        },
      } as Edge);
      list.push({
        id: `e-tel-met-${s.id}`,
        source: `telemetry-${s.id}`,
        target: `metrics-${s.id}`,
        type: "flow",
        data: {
          status: branchActive ? "active" : status === "done" ? "done" : status,
        },
      } as Edge);
      list.push({
        id: `e-met-res-${s.id}`,
        source: `metrics-${s.id}`,
        target: `result-${s.id}`,
        type: "flow",
        data: {
          status: branchActive ? "active" : status === "done" ? "done" : status,
        },
      } as Edge);
      if (result && result.status === "completed") {
        list.push({
          id: `e-res-syn-${s.id}`,
          source: `result-${s.id}`,
          target: "synthesis",
          type: "flow",
          data: { status: finalResult ? "done" : "idle" },
        } as Edge);
      }
    });
    return list;
  }, [strategies, candidates, completedResults, finalResult]);

  return (
    <ReactFlowProvider>
      <div
        className="fixed inset-0 z-[100] flex flex-col"
        style={{ background: BG, fontFamily: SANS }}
      >
        <style>{`
          @keyframes arenaPulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.82); } }
          @keyframes arenaRingPulse { 0% { box-shadow: 0 0 0 0 rgba(245,196,0,0.35); } 100% { box-shadow: 0 0 0 10px rgba(245,196,0,0); } }
          @keyframes drawerIn { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: translateX(0); } }
          .arena-node { transition: box-shadow 140ms ease, border-color 140ms ease, opacity 200ms ease; }
          .arena-node:hover { box-shadow: 0 10px 26px rgba(20,17,0,0.08); }
          .react-flow__attribution { display: none; }
          .react-flow__controls { box-shadow: none; border: 1px solid ${BORDER}; border-radius: 10px; overflow: hidden; }
          .react-flow__controls-button { background: ${BG}; border-bottom: 1px solid ${BORDER}; }
          .react-flow__controls-button svg { fill: ${TEXT_SECONDARY}; }
          @media (prefers-reduced-motion: reduce) { *[style*="animation"] { animation: none !important; } }
        `}</style>

        <TopBar
          finalResult={finalResult}
          finalizing={finalizing}
          routeLabel={routeLabel}
          testedCount={testedCount}
          strategyCount={strategies.length}
          runningCount={runningCount}
          totalElapsed={totalElapsed}
          totalRequestsFired={totalRequestsFired}
          onClose={onClose}
        />

        {initError && <ErrorBanner text={initError} />}
        {streamError && (
          <ErrorBanner text={`Arena stream error: ${streamError}`} />
        )}
        {runError && <ErrorBanner text={runError} />}
        <ScenarioBanner description={description} scenario={scenario} />

        <div className="relative min-h-0 flex-1">
          {prewarm.status !== "idle" && prewarm.status !== "done" && (
            <div className="pointer-events-none absolute inset-x-0 top-4 z-10 flex justify-center">
              <PrewarmPill
                message={prewarm.status === "running" ? prewarm.message : ""}
              />
            </div>
          )}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            onInit={handleInit}
            // Scroll zooms, like every other tool on the page — it does NOT
            // pan. Panning only happens on an explicit click-drag, and even
            // then it's clamped to translateExtent below so the board can
            // never end up scrolled somewhere with nothing in view.
            panOnScroll={false}
            zoomOnScroll
            panOnDrag
            translateExtent={canvasBounds}
            zoomOnDoubleClick={false}
            proOptions={{ hideAttribution: true }}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            minZoom={0.4}
            maxZoom={1.25}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={22}
              size={1}
              color={BORDER}
            />
            <Controls showInteractive={false} position="bottom-left" />
            <MiniMap
              position="bottom-right"
              pannable
              zoomable
              maskColor="rgba(245, 196, 0, 0.06)"
              style={{
                background: BG,
                border: `1px solid ${BORDER}`,
                borderRadius: 10,
              }}
              nodeColor={() => BORDER_STRONG}
            />
          </ReactFlow>
        </div>

        {selectedId && selectedKind && (
          <InspectorDrawer
            strategy={strategies.find((s) => s.id === selectedId)!}
            kind={selectedKind}
            live={candidates[selectedId]}
            result={completedResults[selectedId]}
            isRunning={runningIds.has(selectedId)}
            onClose={() => {
              setSelectedId(null);
              setSelectedKind(null);
            }}
            onRun={() =>
              handleRun(strategies.find((s) => s.id === selectedId)!)
            }
            repositoryId={repositoryId}
            routeIndex={routeIndex}
          />
        )}

        {reportOpen && finalResult && (
          <ReportDrawer
            result={finalResult}
            strategies={strategies}
            repositoryId={repositoryId}
            routeIndex={routeIndex}
            onClose={() => setReportOpen(false)}
          />
        )}
      </div>
    </ReactFlowProvider>
  );
}

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------
function TopBar({
  finalResult,
  finalizing,
  routeLabel,
  testedCount,
  strategyCount,
  runningCount,
  totalElapsed,
  totalRequestsFired,
  onClose,
}: {
  finalResult: ArenaResult | null;
  finalizing: boolean;
  routeLabel: string;
  testedCount: number;
  strategyCount: number;
  runningCount: number;
  totalElapsed: number;
  totalRequestsFired: number;
  onClose: () => void;
}) {
  const live = !finalResult;
  return (
    <div
      className="relative z-20 flex shrink-0 flex-wrap items-center justify-between gap-4 border-b px-6 py-3.5"
      style={{ borderColor: BORDER, background: BG }}
    >
      <div className="flex min-w-0 items-center gap-3.5">
        <div
          className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
          style={{
            background: finalResult ? ACCENT_SOFT : LIVE_SOFT,
            animation: live
              ? "arenaRingPulse 2.2s ease-out infinite"
              : undefined,
          }}
        >
          {finalResult ? (
            <Trophy size={15} style={{ color: "#8A6D00" }} />
          ) : (
            <Layers size={15} style={{ color: LIVE }} />
          )}
        </div>
        <div className="min-w-0">
          <div
            className="flex items-center gap-2 text-[10.5px] font-bold uppercase tracking-[0.08em]"
            style={{ color: TEXT_TERTIARY }}
          >
            <span
              className="flex h-1.5 w-1.5 rounded-full"
              style={{
                background: finalResult ? TEXT_QUIET : LIVE,
                animation: live
                  ? "arenaPulse 1.6s ease-in-out infinite"
                  : undefined,
              }}
            />
            Optimization Arena
          </div>
          <h1
            className="mt-0.5 truncate text-[16.5px] font-semibold"
            style={{ color: TEXT_PRIMARY }}
          >
            {finalResult
              ? "Verdict reached — synthesis ready"
              : finalizing
                ? "Scoring every strategy…"
                : runningCount > 0
                  ? `${runningCount} strategies running in parallel`
                  : "Starting all strategies…"}
          </h1>
        </div>
      </div>

      <div
        className="flex items-center gap-5 text-[12px]"
        style={{ color: TEXT_TERTIARY, fontFamily: MONO }}
      >
        <span
          className="rounded-full border px-2.5 py-1 text-[10.5px] font-bold"
          style={{ borderColor: BORDER_STRONG, color: TEXT_SECONDARY }}
        >
          {routeLabel}
        </span>
        <span className="flex items-center gap-1.5">
          <Flag size={12} style={{ color: TEXT_QUIET }} />
          {testedCount}/{strategyCount} tested
        </span>
        <span className="flex items-center gap-1.5">
          <Activity
            size={12}
            style={{ color: totalRequestsFired > 0 ? LIVE : TEXT_QUIET }}
          />
          {totalRequestsFired.toLocaleString()} req fired
        </span>
        <span
          className="flex items-center gap-1.5"
          style={{ color: TEXT_QUIET }}
        >
          <Clock size={11} />
          {fmtElapsed(totalElapsed)}
        </span>
      </div>

      <button
        onClick={onClose}
        className="flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[12.5px] font-medium transition-colors"
        style={{ borderColor: BORDER_STRONG, color: TEXT_SECONDARY }}
      >
        <X size={13} />
        {finalResult ? "Close" : "Minimize"}
      </button>
    </div>
  );
}

function ErrorBanner({ text }: { text: string }) {
  return (
    <div className="relative z-20 px-6 pt-3">
      <div
        className="flex items-start gap-2 rounded-xl border px-4 py-3"
        style={{ borderColor: ERROR, background: ERROR_SOFT }}
      >
        <AlertTriangle
          size={14}
          style={{ color: ERROR }}
          className="mt-0.5 shrink-0"
        />
        <p className="text-[12.5px]" style={{ color: ERROR }}>
          {text}
        </p>
      </div>
    </div>
  );
}

function PrewarmPill({ message }: { message: string }) {
  return (
    <div
      className="pointer-events-auto flex items-center gap-2.5 rounded-full border px-4 py-2 shadow-sm"
      style={{ borderColor: BORDER_STRONG, background: BG }}
    >
      <Loader2 size={13} className="animate-spin" style={{ color: GOLD }} />
      <span
        className="text-[12px] font-medium"
        style={{ color: TEXT_SECONDARY }}
      >
        {message || "Preparing a shared environment for all three strategies…"}
      </span>
      <Package size={13} style={{ color: TEXT_QUIET }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inspector drawer — the deep dive for whichever node was clicked. Both the
// Telemetry node and the Metrics node open this with kind="telemetry" —
// they're two views of the same live candidate state, so they share one
// drawer instead of forking into duplicate gauge/console/table code.
// ---------------------------------------------------------------------------
function InspectorDrawer({
  strategy,
  kind,
  live,
  result,
  isRunning,
  onClose,
  onRun,
  repositoryId,
  routeIndex,
}: {
  strategy: OptimizationStrategy;
  kind: "strategy" | "telemetry" | "result";
  live?: CandidateLiveState;
  result?: ArenaCandidateResult;
  isRunning: boolean;
  onClose: () => void;
  onRun: () => void;
  repositoryId: string;
  routeIndex: number;
}) {
  const [tab, setTab] = useState<"console" | "requests">("console");
  const stage = live?.stage ?? (result ? result.status : "queued");
  const failed = stage === "failed";
  const idx = stageIndex(stage);
  const isLive =
    stage === "benchmarking" ||
    stage === "healthcheck" ||
    stage === "provisioning";

  const cpuTrend = useMemo(
    () => (live?.metrics ?? []).map((m) => m.cpuPercent),
    [live?.metrics],
  );
  const memTrend = useMemo(
    () => (live?.metrics ?? []).map((m) => m.memoryMB),
    [live?.metrics],
  );
  const latestMetric = live?.metrics[live.metrics.length - 1];
  const memMax = Math.max(256, ...memTrend, result?.memoryMB ?? 0) * 1.15;

  return (
    <div
      className="fixed inset-y-0 right-0 z-[110] flex w-full flex-col overflow-hidden border-l shadow-2xl sm:w-[440px]"
      style={{
        borderColor: BORDER,
        background: SURFACE,
        animation: "drawerIn 200ms ease-out",
      }}
    >
      <div
        className="flex items-start justify-between gap-3 border-b px-5 py-4"
        style={{ borderColor: BORDER, background: BG }}
      >
        <div className="min-w-0">
          <div
            className="text-[10px] font-bold uppercase tracking-[0.06em]"
            style={{ color: TEXT_TERTIARY }}
          >
            {kind === "strategy"
              ? "Strategy"
              : kind === "telemetry"
                ? "Live telemetry & metrics"
                : "Result"}
          </div>
          <h3
            className="mt-0.5 truncate text-[15px] font-semibold"
            style={{ color: TEXT_PRIMARY, fontFamily: MONO }}
          >
            {strategy.title}
          </h3>
        </div>
        <button
          onClick={onClose}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
          style={{ color: TEXT_QUIET }}
        >
          <X size={15} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {kind === "strategy" && (
          <div className="flex flex-col gap-4">
            <p
              className="text-[13px] leading-[1.6]"
              style={{ color: TEXT_SECONDARY }}
            >
              {strategy.description}
            </p>
            <div
              className="flex items-center gap-1.5 text-[11.5px]"
              style={{ color: TEXT_TERTIARY }}
            >
              <Sparkles size={12} style={{ color: GOLD }} />
              Estimated +{strategy.estimatedImprovementPercent.min}–
              {strategy.estimatedImprovementPercent.max}% ·{" "}
              {strategy.confidence} confidence
            </div>

            <div>
              <div
                className="mb-2 flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.06em]"
                style={{ color: TEXT_TERTIARY }}
              >
                <GitBranch size={12} /> Pipeline
              </div>
              <div className="flex items-center gap-1.5">
                {PIPELINE_STAGES.map((step, i) => {
                  const StepIcon = step.icon;
                  const stepState =
                    failed && i >= Math.max(idx, 0)
                      ? "failed"
                      : i < idx || stage === "completed"
                        ? "done"
                        : i === idx
                          ? "active"
                          : "pending";
                  const color =
                    stepState === "done"
                      ? LIVE
                      : stepState === "active"
                        ? GOLD
                        : stepState === "failed"
                          ? ERROR
                          : TEXT_QUIET;
                  return (
                    <div
                      key={step.stage}
                      className="flex flex-1 flex-col items-center gap-1"
                    >
                      <div
                        className="flex h-7 w-7 items-center justify-center rounded-full border"
                        style={{ borderColor: color, color }}
                      >
                        {stepState === "active" ? (
                          <Loader2 size={11} className="animate-spin" />
                        ) : stepState === "done" ? (
                          <Check size={11} />
                        ) : (
                          <StepIcon size={11} />
                        )}
                      </div>
                      <span
                        className="text-[9px] font-medium"
                        style={{ color }}
                      >
                        {step.label}
                      </span>
                    </div>
                  );
                })}
              </div>
              <p
                className="mt-2 text-[12.5px]"
                style={{ color: failed ? ERROR : TEXT_SECONDARY }}
              >
                {failed
                  ? (live?.error ?? result?.error ?? "Failed")
                  : result
                    ? "Finished."
                    : STAGE_MESSAGE[stage]}
              </p>
            </div>

            {(stage === "queued" || failed) && (
              <button
                onClick={onRun}
                disabled={isRunning}
                className="flex items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-[12.5px] font-bold transition-all hover:brightness-105 disabled:opacity-40"
                style={{ background: GOLD, color: "#241C00" }}
              >
                {isRunning ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : failed ? (
                  <RotateCcw size={13} />
                ) : (
                  <Play size={13} />
                )}
                {isRunning
                  ? "Starting…"
                  : failed
                    ? "Retry strategy"
                    : "Run strategy"}
              </button>
            )}

            <div>
              <div
                className="mb-2 flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.06em]"
                style={{ color: TEXT_TERTIARY }}
              >
                <FileCode size={12} /> Code change
              </div>
              <StrategyDiffs strategy={strategy} />
            </div>
          </div>
        )}

        {kind === "telemetry" && (
          <div className="flex flex-col gap-4">
            <GaugeRing
              label="CPU"
              icon={Cpu}
              value={latestMetric?.cpuPercent ?? result?.cpuPercent ?? null}
              max={100}
              unit="%"
              color={LIVE}
              isLive={isLive}
              trend={cpuTrend}
            />
            <GaugeRing
              label="Memory"
              icon={MemoryStick}
              value={latestMetric?.memoryMB ?? result?.memoryMB ?? null}
              max={memMax}
              unit="MB"
              color={GOLD}
              isLive={isLive}
              trend={memTrend}
            />
            <LatencyPanel live={live} result={result} isLive={isLive} />
            <ThroughputPanel live={live} isLive={isLive} />
            <TelemetryPanel live={live} isLive={isLive} />

            <div className="flex items-center gap-1">
              <button
                onClick={() => setTab("console")}
                className="rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-colors"
                style={{
                  background: tab === "console" ? ACCENT_SOFT : "transparent",
                  color: tab === "console" ? "#8A6D00" : TEXT_TERTIARY,
                }}
              >
                Console
              </button>
              <button
                onClick={() => setTab("requests")}
                className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-colors"
                style={{
                  background: tab === "requests" ? ACCENT_SOFT : "transparent",
                  color: tab === "requests" ? "#8A6D00" : TEXT_TERTIARY,
                }}
              >
                <List size={11} /> Requests
                {live?.requestLog.length ? (
                  <span
                    className="rounded-full px-1.5 text-[9px]"
                    style={{
                      background: SURFACE_SUNKEN,
                      color: TEXT_SECONDARY,
                    }}
                  >
                    {live.requestLog.length}
                  </span>
                ) : null}
              </button>
            </div>
            {tab === "console" ? (
              <div
                className="max-h-[280px] overflow-y-auto rounded-lg px-3 py-2.5"
                style={{
                  background: CONSOLE_BG,
                  border: `1px solid ${CONSOLE_BORDER}`,
                }}
              >
                {!live || live.logs.length === 0 ? (
                  <p
                    className="text-[12px]"
                    style={{ color: CONSOLE_TEXT_DIM, fontFamily: MONO }}
                  >
                    Waiting for output…
                  </p>
                ) : (
                  live.logs.map((line, i) => (
                    <div
                      key={i}
                      className="whitespace-pre-wrap break-all text-[12px] leading-[1.65]"
                      style={{ color: CONSOLE_TEXT, fontFamily: MONO }}
                    >
                      {line}
                    </div>
                  ))
                )}
              </div>
            ) : (
              <RequestLogTable entries={live?.requestLog ?? []} />
            )}
          </div>
        )}

        {kind === "result" && (
          <div className="flex flex-col gap-4">
            {!result ? (
              <p className="text-[12.5px]" style={{ color: TEXT_QUIET }}>
                This strategy hasn't finished a run yet.
              </p>
            ) : result.status === "failed" ? (
              <div
                className="flex items-start gap-2 rounded-xl border px-4 py-3"
                style={{ borderColor: ERROR, background: ERROR_SOFT }}
              >
                <AlertTriangle
                  size={15}
                  style={{ color: ERROR }}
                  className="mt-0.5 shrink-0"
                />
                <p className="text-[13px]" style={{ color: "#8F4436" }}>
                  {result.error}
                </p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2.5">
                  <MiniStat
                    label="Avg"
                    value={
                      result.runResult
                        ? `${Math.round(result.runResult.avgDurationMs)}ms`
                        : "—"
                    }
                  />
                  <MiniStat
                    label="p95"
                    value={
                      result.runResult?.p95DurationMs != null
                        ? `${Math.round(result.runResult.p95DurationMs)}ms`
                        : "—"
                    }
                  />
                  <MiniStat
                    label="Errors"
                    value={
                      result.runResult
                        ? String(result.runResult.errorCount)
                        : "—"
                    }
                    accent={
                      result.runResult && result.runResult.errorCount > 0
                        ? ERROR
                        : undefined
                    }
                  />
                  <MiniStat
                    label="Requests"
                    value={
                      result.runResult
                        ? String(result.runResult.requestsSent)
                        : "—"
                    }
                  />
                </div>
                <CreatePrButton
                  repositoryId={repositoryId}
                  routeIndex={routeIndex}
                  strategy={strategy}
                  candidateResult={result}
                />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Report drawer — full ranked comparison, opened from the Synthesis node.
// ---------------------------------------------------------------------------
function ReportDrawer({
  result,
  strategies,
  repositoryId,
  routeIndex,
  onClose,
}: {
  result: ArenaResult;
  strategies: OptimizationStrategy[];
  repositoryId: string;
  routeIndex: number;
  onClose: () => void;
}) {
  const strategyById = useMemo(
    () => Object.fromEntries(strategies.map((s) => [s.id, s])),
    [strategies],
  );
  const ranked = [...result.candidates].sort((a, b) => {
    if (a.status === "failed" && b.status !== "failed") return 1;
    if (b.status === "failed" && a.status !== "failed") return -1;
    return (b.score ?? -Infinity) - (a.score ?? -Infinity);
  });
  const [expandedId, setExpandedId] = useState<string | null>(
    result.winnerStrategyId,
  );

  return (
    <div className="fixed inset-0 z-[120] flex justify-end">
      <div className="absolute inset-0 bg-black/25" onClick={onClose} />
      <div
        className="relative flex h-full w-full flex-col overflow-hidden border-l shadow-2xl sm:w-[560px]"
        style={{
          borderColor: BORDER,
          background: SURFACE,
          animation: "drawerIn 220ms ease-out",
        }}
      >
        <div
          className="flex items-center justify-between border-b px-6 py-4"
          style={{ borderColor: BORDER, background: BG }}
        >
          <div className="flex items-center gap-2">
            <Trophy size={16} style={{ color: "#8A6D00" }} />
            <h3
              className="text-[15px] font-semibold"
              style={{ color: TEXT_PRIMARY }}
            >
              Full report
            </h3>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md"
            style={{ color: TEXT_QUIET }}
          >
            <X size={15} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <div className="flex flex-col gap-2.5">
            {ranked.map((c, i) => {
              const strategy = strategyById[c.strategyId];
              const isWinner = c.strategyId === result.winnerStrategyId;
              const failed = c.status === "failed";
              const rankColor = i < 3 ? RANK_COLOR[i] : TEXT_TERTIARY;
              const expanded = expandedId === c.strategyId;
              return (
                <div
                  key={c.strategyId}
                  className="overflow-hidden rounded-2xl border"
                  style={{
                    borderColor: isWinner ? GOLD : BORDER_STRONG,
                    background: isWinner ? "#FFFBEE" : SURFACE_RAISED,
                  }}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() =>
                      setExpandedId(expanded ? null : c.strategyId)
                    }
                    className="flex w-full cursor-pointer flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 text-left"
                  >
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[12px] font-bold"
                      style={{ borderColor: BORDER_STRONG, color: rankColor }}
                    >
                      {failed ? (
                        <XCircle size={15} style={{ color: ERROR }} />
                      ) : (
                        i + 1
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div
                        className="truncate text-[13.5px] font-semibold"
                        style={{ color: TEXT_PRIMARY, fontFamily: MONO }}
                      >
                        {c.title || strategy?.title}
                      </div>
                      <div
                        className="text-[10.5px]"
                        style={{ color: TEXT_TERTIARY }}
                      >
                        {strategy?.approach}
                      </div>
                    </div>
                    {isWinner && (
                      <span
                        className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em]"
                        style={{ background: GOLD, color: "#241C00" }}
                      >
                        <Trophy size={11} /> Best
                      </span>
                    )}
                    {!failed && (
                      <span
                        className="rounded-lg border px-2.5 py-1 text-[12px] font-bold"
                        style={{
                          borderColor: isWinner ? GOLD : BORDER_STRONG,
                          color: isWinner ? "#8A6D00" : TEXT_PRIMARY,
                          fontFamily: MONO,
                        }}
                      >
                        score {c.score ?? "—"}
                      </span>
                    )}
                    <ChevronDown
                      size={15}
                      style={{
                        color: TEXT_TERTIARY,
                        transform: expanded ? "rotate(180deg)" : "none",
                        transition: "transform 150ms",
                      }}
                    />
                  </div>
                  {expanded && !failed && (
                    <div
                      className="border-t px-4 py-4"
                      style={{ borderColor: BORDER }}
                    >
                      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                        <StatBox
                          label="Avg"
                          value={
                            c.runResult
                              ? `${Math.round(c.runResult.avgDurationMs)}ms`
                              : "—"
                          }
                        />
                        <StatBox
                          label="p95"
                          value={
                            c.runResult?.p95DurationMs != null
                              ? `${Math.round(c.runResult.p95DurationMs)}ms`
                              : "—"
                          }
                        />
                        <StatBox
                          label="Errors"
                          value={
                            c.runResult ? String(c.runResult.errorCount) : "—"
                          }
                          accent={
                            c.runResult && c.runResult.errorCount > 0
                              ? ERROR
                              : undefined
                          }
                        />
                        <StatBox
                          label="Files"
                          value={
                            strategy ? String(strategy.changes.length) : "—"
                          }
                        />
                      </div>
                      {strategy && (
                        <div
                          className="mt-4"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <CreatePrButton
                            repositoryId={repositoryId}
                            routeIndex={routeIndex}
                            strategy={strategy}
                            candidateResult={c}
                          />
                        </div>
                      )}
                    </div>
                  )}
                  {expanded && failed && (
                    <div
                      className="border-t px-4 py-3 text-[12.5px]"
                      style={{ borderColor: BORDER, color: ERROR }}
                    >
                      {c.error}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small shared pieces (diffs, gauges, panels, stats) — unchanged mechanics,
// only spacing/scale tuned to sit inside the new drawers.
// ---------------------------------------------------------------------------
function SingleFileDiff({ change }: { change: FileChange }) {
  const isCreate = change.changeType === "create";
  const oldLines = isCreate ? [] : (change.originalCode ?? "").split("\n");
  const newLines = change.newCode.split("\n");
  return (
    <div
      className="overflow-hidden rounded-xl border"
      style={{ borderColor: CONSOLE_BORDER }}
    >
      <div
        className="flex items-center gap-2 border-b px-3.5 py-2"
        style={{ borderColor: CONSOLE_BORDER, background: SURFACE_RAISED }}
      >
        <FileCode size={12} style={{ color: TEXT_TERTIARY }} />
        <span
          className="text-[11.5px] font-medium"
          style={{ color: TEXT_SECONDARY, fontFamily: MONO }}
        >
          {change.filePath}
        </span>
        <span
          className="ml-auto rounded-full px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.05em]"
          style={{
            background: isCreate ? LIVE_SOFT : SURFACE_SUNKEN,
            color: isCreate ? LIVE : TEXT_SECONDARY,
          }}
        >
          {isCreate ? "New file" : "Modified"}
        </span>
      </div>
      <div
        style={{ background: CONSOLE_BG, maxHeight: 220, overflowY: "auto" }}
      >
        {!isCreate && (
          <div className="border-b" style={{ borderColor: ERROR_SOFT }}>
            {oldLines.map((line, i) => (
              <div
                key={`old-${i}`}
                className="flex px-3.5 py-0.5 text-[11.5px] leading-[1.6]"
                style={{ background: ERROR_SOFT, fontFamily: MONO }}
              >
                <span className="mr-3 select-none" style={{ color: ERROR }}>
                  −
                </span>
                <span style={{ color: "#8F4436" }}>{line || " "}</span>
              </div>
            ))}
          </div>
        )}
        <div>
          {newLines.map((line, i) => (
            <div
              key={`new-${i}`}
              className="flex px-3.5 py-0.5 text-[11.5px] leading-[1.6]"
              style={{ background: LIVE_SOFT, fontFamily: MONO }}
            >
              <span className="mr-3 select-none" style={{ color: LIVE }}>
                +
              </span>
              <span style={{ color: "#1F6B44" }}>{line || " "}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StrategyDiffs({ strategy }: { strategy: OptimizationStrategy }) {
  return (
    <div className="flex flex-col gap-3">
      {strategy.changes.map((c) => (
        <SingleFileDiff key={c.filePath} change={c} />
      ))}
    </div>
  );
}

function MiniStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div
      className="rounded-lg border px-3.5 py-2.5"
      style={{ borderColor: BORDER_STRONG, background: SURFACE }}
    >
      <div
        className="text-[10px] font-medium uppercase tracking-[0.06em]"
        style={{ color: TEXT_TERTIARY }}
      >
        {label}
      </div>
      <div
        className="mt-1 text-[14px] font-semibold"
        style={{ color: accent ?? TEXT_PRIMARY, fontFamily: MONO }}
      >
        {value}
      </div>
    </div>
  );
}

function StatBox({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div
      className="rounded-xl border px-3.5 py-3"
      style={{ borderColor: BORDER, background: SURFACE }}
    >
      <div
        className="text-[10px] font-semibold uppercase tracking-[0.05em]"
        style={{ color: TEXT_TERTIARY }}
      >
        {label}
      </div>
      <div
        className="mt-1 text-[15px] font-bold"
        style={{ color: accent ?? TEXT_PRIMARY, fontFamily: MONO }}
      >
        {value}
      </div>
    </div>
  );
}

function LiveBadge() {
  return (
    <span
      className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.05em]"
      style={{ background: LIVE_SOFT, color: LIVE }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{
          background: LIVE,
          animation: "arenaPulse 1.4s ease-in-out infinite",
        }}
      />
      Live
    </span>
  );
}

function GaugeRing({
  label,
  icon: Icon,
  value,
  max,
  unit,
  color,
  isLive,
  trend,
}: {
  label: string;
  icon: typeof Cpu;
  value: number | null;
  max: number;
  unit: string;
  color: string;
  isLive: boolean;
  trend: number[];
}) {
  const r = 28;
  const circumference = 2 * Math.PI * r;
  const pct = value != null ? Math.min(1, value / max) : 0;
  const offset = circumference - pct * circumference;
  return (
    <div
      className="flex items-center gap-3 rounded-xl border px-4 py-3"
      style={{ borderColor: BORDER, background: SURFACE_RAISED }}
    >
      <div className="relative flex h-[68px] w-[68px] shrink-0 items-center justify-center">
        <svg width={68} height={68} viewBox="0 0 68 68" className="-rotate-90">
          <circle
            cx={34}
            cy={34}
            r={r}
            fill="none"
            stroke={BORDER}
            strokeWidth={6}
          />
          <circle
            cx={34}
            cy={34}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={6}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            style={{ transition: "stroke-dashoffset 700ms ease-out" }}
          />
        </svg>
        <div className="absolute flex flex-col items-center">
          <span
            className="text-[13px] font-bold"
            style={{ color: TEXT_PRIMARY, fontFamily: MONO }}
          >
            {value != null ? Math.round(value) : "—"}
          </span>
          <span
            className="text-[8.5px] font-semibold"
            style={{ color: TEXT_QUIET }}
          >
            {unit}
          </span>
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div
          className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.05em]"
          style={{ color: TEXT_TERTIARY }}
        >
          <Icon size={12} />
          {label}
          {isLive && <LiveBadge />}
        </div>
        <Sparkline data={trend} color={color} />
      </div>
    </div>
  );
}

function LatencyPanel({
  live,
  result,
  isLive,
}: {
  live?: CandidateLiveState;
  result?: ArenaCandidateResult;
  isLive: boolean;
}) {
  const chartData = useMemo(
    () =>
      (live?.requestLog ?? [])
        .filter((r) => r.durationMs != null)
        .map((r) => ({ i: r.index, latency: r.durationMs as number })),
    [live?.requestLog],
  );
  const latest = chartData[chartData.length - 1];
  const value = latest
    ? `${Math.round(latest.latency)}ms`
    : result?.runResult
      ? `${Math.round(result.runResult.avgDurationMs)}ms avg`
      : undefined;
  return (
    <div
      className="rounded-xl border px-4 py-3"
      style={{ borderColor: BORDER, background: SURFACE_RAISED }}
    >
      <div className="mb-1.5 flex items-center justify-between">
        <span
          className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.05em]"
          style={{ color: TEXT_TERTIARY }}
        >
          <Gauge size={12} />
          Latency{isLive && <LiveBadge />}
        </span>
        {value && (
          <span
            className="text-[12.5px] font-semibold"
            style={{ color: TEXT_PRIMARY, fontFamily: MONO }}
          >
            {value}
          </span>
        )}
      </div>
      <div className="h-[64px]">
        {chartData.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <YAxis hide domain={[0, "auto"]} />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                labelFormatter={(l) => `request #${l}`}
                formatter={(v: number) => [`${Math.round(v)}ms`, "latency"]}
              />
              <Area
                type="monotone"
                dataKey="latency"
                stroke={GOLD}
                fill={GOLD}
                fillOpacity={0.16}
                strokeWidth={1.5}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div
            className="flex h-full items-center text-[11px]"
            style={{ color: TEXT_QUIET }}
          >
            Plots as each request finishes…
          </div>
        )}
      </div>
    </div>
  );
}

function ThroughputPanel({
  live,
  isLive,
}: {
  live?: CandidateLiveState;
  isLive: boolean;
}) {
  const chartData = useMemo(() => {
    const entries = live?.requestLog ?? [];
    if (entries.length === 0) return [];
    const buckets = new Map<number, number>();
    for (const r of entries)
      buckets.set(
        Math.floor(r.timestamp / 1000),
        (buckets.get(Math.floor(r.timestamp / 1000)) ?? 0) + 1,
      );
    const keys = [...buckets.keys()].sort((a, b) => a - b);
    return keys.map((k, i) => ({ i, rps: buckets.get(k)! }));
  }, [live?.requestLog]);
  const latest = chartData[chartData.length - 1];
  return (
    <div
      className="rounded-xl border px-4 py-3"
      style={{ borderColor: BORDER, background: SURFACE_RAISED }}
    >
      <div className="mb-1.5 flex items-center justify-between">
        <span
          className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.05em]"
          style={{ color: TEXT_TERTIARY }}
        >
          <TrendingUp size={12} />
          Throughput{isLive && <LiveBadge />}
        </span>
        {latest && (
          <span
            className="text-[12.5px] font-semibold"
            style={{ color: TEXT_PRIMARY, fontFamily: MONO }}
          >
            {latest.rps} req/s
          </span>
        )}
      </div>
      <div className="h-[64px]">
        {chartData.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <YAxis hide domain={[0, "auto"]} />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(v: number) => [`${v}`, "req/s"]}
              />
              <Bar
                dataKey="rps"
                fill={LIVE}
                radius={[2, 2, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div
            className="flex h-full items-center text-[11px]"
            style={{ color: TEXT_QUIET }}
          >
            Requests per second, bucketed live…
          </div>
        )}
      </div>
    </div>
  );
}

function TelemetryPanel({
  live,
  isLive,
}: {
  live?: CandidateLiveState;
  isLive: boolean;
}) {
  const chartData = useMemo(
    () =>
      (live?.telemetryHistory ?? []).map((t, i) => ({
        i,
        p50: t.p50,
        p95: t.p95,
      })),
    [live?.telemetryHistory],
  );
  const t = live?.telemetry;
  return (
    <div
      className="rounded-xl border px-4 py-3"
      style={{ borderColor: BORDER, background: SURFACE_RAISED }}
    >
      <div className="mb-1.5 flex items-center justify-between">
        <span
          className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.05em]"
          style={{ color: TEXT_TERTIARY }}
        >
          <Database size={12} />
          SigNoz{isLive && <LiveBadge />}
        </span>
        {t && (
          <span
            className="text-[11px]"
            style={{ fontFamily: MONO, color: TEXT_SECONDARY }}
          >
            p50 {t.latencyMs.p50}ms · p95 {t.latencyMs.p95}ms
          </span>
        )}
      </div>
      <div className="h-[64px]">
        {chartData.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <YAxis hide domain={[0, "auto"]} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Line
                type="monotone"
                dataKey="p50"
                stroke={TEXT_QUIET}
                dot={false}
                strokeWidth={1.5}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="p95"
                stroke={GOLD}
                dot={false}
                strokeWidth={1.75}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div
            className="flex h-full items-center text-[11px]"
            style={{ color: TEXT_QUIET }}
          >
            Waiting for spans…
          </div>
        )}
      </div>
    </div>
  );
}

function RequestLogTable({
  entries,
}: {
  entries: CandidateLiveState["requestLog"];
}) {
  if (entries.length === 0) {
    return (
      <p
        className="rounded-lg border px-3 py-2 text-[11.5px]"
        style={{ borderColor: BORDER, color: TEXT_TERTIARY }}
      >
        Waiting for the first request…
      </p>
    );
  }
  return (
    <div
      className="max-h-[280px] overflow-y-auto rounded-lg border"
      style={{ borderColor: CONSOLE_BORDER }}
    >
      <table className="w-full text-[11px]" style={{ fontFamily: MONO }}>
        <thead>
          <tr className="sticky top-0" style={{ background: SURFACE_RAISED }}>
            <th
              className="px-2.5 py-1.5 text-left font-semibold"
              style={{ color: TEXT_TERTIARY }}
            >
              #
            </th>
            <th
              className="px-2.5 py-1.5 text-left font-semibold"
              style={{ color: TEXT_TERTIARY }}
            >
              Method
            </th>
            <th
              className="px-2.5 py-1.5 text-left font-semibold"
              style={{ color: TEXT_TERTIARY }}
            >
              Status
            </th>
            <th
              className="px-2.5 py-1.5 text-right font-semibold"
              style={{ color: TEXT_TERTIARY }}
            >
              Duration
            </th>
          </tr>
        </thead>
        <tbody>
          {[...entries]
            .slice(-150)
            .reverse()
            .map((r) => (
              <tr
                key={r.index}
                style={{ borderTop: `1px solid ${CONSOLE_BORDER}` }}
              >
                <td className="px-2.5 py-1.5" style={{ color: TEXT_QUIET }}>
                  {r.index}
                </td>
                <td className="px-2.5 py-1.5" style={{ color: TEXT_TERTIARY }}>
                  {r.method ?? "—"}
                </td>
                <td
                  className="px-2.5 py-1.5 font-semibold"
                  style={{ color: r.ok ? LIVE : ERROR }}
                >
                  {r.status}
                </td>
                <td
                  className="px-2.5 py-1.5 text-right"
                  style={{ color: TEXT_SECONDARY }}
                >
                  {r.durationMs != null ? `${r.durationMs}ms` : "—"}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

type PrState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; prUrl: string; prNumber: number }
  | { status: "error"; message: string };

function CreatePrButton({
  repositoryId,
  routeIndex,
  strategy,
  candidateResult,
}: {
  repositoryId: string;
  routeIndex: number;
  strategy: OptimizationStrategy;
  candidateResult: ArenaCandidateResult;
}) {
  const [state, setState] = useState<PrState>({ status: "idle" });
  const handleClick = async () => {
    if (state.status === "loading") return;
    setState({ status: "loading" });
    try {
      const result = await createPullRequestForStrategy(
        repositoryId,
        routeIndex,
        strategy,
        candidateResult,
      );
      setState({
        status: "done",
        prUrl: result.prUrl,
        prNumber: result.prNumber,
      });
    } catch (err: any) {
      setState({
        status: "error",
        message:
          err?.response?.data?.error ??
          (err instanceof Error ? err.message : "Failed to create PR"),
      });
    }
  };
  if (state.status === "done") {
    return (
      <a
        href={state.prUrl}
        target="_blank"
        rel="noreferrer"
        className="flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-[12px] font-bold transition-colors"
        style={{ borderColor: LIVE, color: LIVE, background: LIVE_SOFT }}
      >
        <GitPullRequestArrow size={13} /> PR #{state.prNumber}{" "}
        <ExternalLink size={11} />
      </a>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <button
        onClick={handleClick}
        disabled={state.status === "loading"}
        className="flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-[12px] font-bold transition-colors disabled:opacity-50"
        style={{ borderColor: BORDER_STRONG, color: TEXT_PRIMARY }}
      >
        {state.status === "loading" ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <GitPullRequestArrow size={13} />
        )}
        {state.status === "loading" ? "Opening PR…" : "Open PR"}
      </button>
      {state.status === "error" && (
        <span
          className="truncate text-[11px]"
          style={{ color: ERROR }}
          title={state.message}
        >
          {state.message}
        </span>
      )}
    </div>
  );
}
