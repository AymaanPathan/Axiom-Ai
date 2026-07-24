// components/ArenaLive.tsx
import { useEffect, useMemo, useRef, useState } from "react";
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
  List,
  Activity,
  TrendingUp,
  PieChart as PieIcon,
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
  XAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import type {
  OptimizationStrategy,
  ArenaResult,
  ArenaCandidateResult,
} from "../api/repos";
import { initArena, runArenaCandidate, finalizeArena } from "../api/repos";
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
  BORDER,
  BORDER_STRONG,
  TEXT_PRIMARY,
  TEXT_SECONDARY,
  TEXT_TERTIARY,
  TEXT_QUIET,
  ERROR,
  GOLD,
  LIVE,
} from "../theme";

interface Props {
  repositoryId: string;
  routeIndex: number;
  routeLabel: string;
  strategies: OptimizationStrategy[];
  script: string;
  authToken?: string;
  onClose: () => void;
  onComplete?: (result: ArenaResult) => void;
}

const PIPELINE: { stage: string; label: string; icon: typeof Copy }[] = [
  { stage: "copying", label: "Isolate", icon: Copy },
  { stage: "patching", label: "Patch", icon: GitBranch },
  { stage: "provisioning", label: "Deploy", icon: Box },
  { stage: "healthcheck", label: "Health check", icon: HeartPulse },
  { stage: "benchmarking", label: "Benchmark", icon: Gauge },
  { stage: "telemetry", label: "Telemetry", icon: Database },
];

const STAGE_MESSAGE: Record<string, string> = {
  queued: "Waiting to be started…",
  copying: "Copying the repo into an isolated sandbox…",
  patching: "Applying this strategy's diff…",
  provisioning: "Booting an isolated container…",
  healthcheck: "Waiting for the app to come up…",
  benchmarking: "Sending live traffic and measuring…",
  telemetry: "Pulling trace data for this run…",
  completed: "Finished.",
  failed: "Failed.",
};

function stageIndex(stage: string): number {
  return PIPELINE.findIndex((p) => p.stage === stage);
}

function useElapsed(active: boolean, since: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [active]);
  return active ? Math.max(0, now - since) : 0;
}

function fmtElapsed(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function ArenaLive({
  repositoryId,
  routeIndex,
  routeLabel,
  strategies,
  script,
  authToken,
  onClose,
  onComplete,
}: Props) {
  const [arenaId, setArenaId] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [arenaStartedAt] = useState(() => Date.now());
  const { candidates, prewarm, error: streamError } = useArenaStream(arenaId);

  const [runIndex, setRunIndex] = useState(0);
  const [completedResults, setCompletedResults] = useState<
    Record<string, ArenaCandidateResult>
  >({});
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const [finalResult, setFinalResult] = useState<ArenaResult | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);

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
    if (finalResult && onComplete) onComplete(finalResult);
  }, [finalResult, onComplete]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const totalElapsed = useElapsed(!finalResult, arenaStartedAt);
  const prewarming = prewarm.status === "running";
  const currentStrategy = strategies[runIndex];
  const currentResult = currentStrategy
    ? completedResults[currentStrategy.id]
    : undefined;
  const isLastStrategy = runIndex === strategies.length - 1;
  const allTested = strategies.every((s) => completedResults[s.id]);
  const testedCount = strategies.filter((s) => completedResults[s.id]).length;

  async function handleRunCurrent() {
    if (!arenaId || !currentStrategy) return;
    setRunError(null);
    setRunningId(currentStrategy.id);
    try {
      const result = await runArenaCandidate(
        repositoryId,
        arenaId,
        currentStrategy,
        script,
        authToken,
      );
      setCompletedResults((prev) => ({
        ...prev,
        [currentStrategy.id]: result,
      }));
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Strategy run failed");
    } finally {
      setRunningId(null);
    }
  }

  function handleRerunCurrent() {
    if (!currentStrategy) return;
    setCompletedResults((prev) => {
      const next = { ...prev };
      delete next[currentStrategy.id];
      return next;
    });
  }

  function handleNextStrategy() {
    if (runIndex < strategies.length - 1) {
      setRunIndex((i) => i + 1);
      setRunError(null);
    }
  }

  function handlePrevStrategy() {
    if (runIndex > 0) {
      setRunIndex((i) => i - 1);
      setRunError(null);
    }
  }

  async function handleFinalize() {
    if (!arenaId) return;
    setFinalizing(true);
    setFinalizeError(null);
    try {
      const result = await finalizeArena(repositoryId, arenaId);
      setFinalResult(result);
    } catch (err) {
      setFinalizeError(
        err instanceof Error ? err.message : "Failed to finalize arena",
      );
    } finally {
      setFinalizing(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col"
      style={{ background: BG, fontFamily: SANS }}
    >
      <div
        className="flex shrink-0 items-center justify-between border-b px-6 py-4"
        style={{ borderColor: BORDER }}
      >
        <div>
          <div
            className="flex items-center gap-2 text-[10.5px] font-bold uppercase tracking-[0.08em]"
            style={{ color: TEXT_TERTIARY }}
          >
            <span
              className="flex h-1.5 w-1.5 rounded-full"
              style={{ background: finalResult ? TEXT_QUIET : LIVE }}
            />
            {finalResult ? "Arena complete" : "Optimization Arena · manual"}
          </div>
          <h1
            className="mt-1 text-[18px] font-semibold"
            style={{ color: TEXT_PRIMARY }}
          >
            {finalResult
              ? "Final results"
              : prewarming
                ? "Preparing environment"
                : currentStrategy
                  ? `Strategy ${runIndex + 1} of ${strategies.length}`
                  : "—"}
          </h1>
          <div
            className="mt-1 flex items-center gap-1.5 text-[12px]"
            style={{ color: TEXT_TERTIARY, fontFamily: MONO }}
          >
            <span
              className="rounded border px-1.5 py-0.5 text-[10.5px] font-bold"
              style={{ borderColor: BORDER_STRONG }}
            >
              {routeLabel}
            </span>
            <span>
              {finalResult
                ? "benchmarked across tested strategies"
                : `${testedCount}/${strategies.length} tested · you control when each runs`}
            </span>
            <span
              className="flex items-center gap-1"
              style={{ color: TEXT_QUIET }}
            >
              <Clock size={11} />
              {fmtElapsed(totalElapsed)}
            </span>
          </div>
        </div>
        <button
          onClick={onClose}
          className="flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[12.5px] font-medium transition-colors hover:border-[#4d4f56]"
          style={{ borderColor: BORDER_STRONG, color: TEXT_SECONDARY }}
        >
          <X size={13} />
          {finalResult ? "Close" : "Minimize"}
        </button>
      </div>

      {initError && (
        <div className="px-6 pt-6">
          <p className="text-[13px]" style={{ color: ERROR }}>
            {initError}
          </p>
        </div>
      )}
      {streamError && (
        <div className="px-6 pt-6">
          <p className="text-[13px]" style={{ color: ERROR }}>
            Arena failed: {streamError}
          </p>
        </div>
      )}
      {runError && (
        <div className="px-6 pt-6">
          <p className="text-[13px]" style={{ color: ERROR }}>
            Strategy failed: {runError}
          </p>
        </div>
      )}
      {finalizeError && (
        <div className="px-6 pt-6">
          <p className="text-[13px]" style={{ color: ERROR }}>
            {finalizeError}
          </p>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 lg:px-10">
        {finalResult ? (
          <div className="mx-auto max-w-6xl">
            <FinalBoard result={finalResult} strategies={strategies} />
          </div>
        ) : (
          <>
            {prewarm.status !== "idle" && <PrewarmBanner state={prewarm} />}
            <RaceStrip
              strategies={strategies}
              candidates={candidates}
              currentIndex={runIndex}
              disabled={prewarming || !arenaId}
              onSelect={(i) => {
                if (completedResults[strategies[i].id] || i === runIndex) {
                  setRunIndex(i);
                  setRunError(null);
                }
              }}
            />
            {currentStrategy && (
              <FocusedCandidate
                key={currentStrategy.id}
                strategy={currentStrategy}
                live={candidates[currentStrategy.id]}
                result={currentResult}
                isRunning={runningId === currentStrategy.id}
                canRun={
                  !prewarming && !!arenaId && !runningId && !currentResult
                }
                onRun={handleRunCurrent}
                onRerun={handleRerunCurrent}
              />
            )}

            <div className="mt-6 flex items-center justify-between gap-3">
              <button
                onClick={handlePrevStrategy}
                disabled={runIndex === 0}
                className="rounded-lg border px-4 py-2 text-[12.5px] font-semibold transition-colors disabled:opacity-30"
                style={{ borderColor: BORDER_STRONG, color: TEXT_SECONDARY }}
              >
                ← Previous strategy
              </button>

              <div className="flex items-center gap-3">
                {currentResult && !isLastStrategy && (
                  <button
                    onClick={handleNextStrategy}
                    className="rounded-lg border px-4 py-2 text-[12.5px] font-semibold transition-colors"
                    style={{ borderColor: BORDER_STRONG, color: TEXT_SECONDARY }}
                  >
                    Test next strategy →
                  </button>
                )}
                {allTested && (
                  <button
                    onClick={handleFinalize}
                    disabled={finalizing}
                    className="flex items-center gap-1.5 rounded-lg bg-white px-4 py-2 text-[12.5px] font-bold text-black transition-colors hover:bg-[#e5e5e5] disabled:opacity-40"
                  >
                    {finalizing && (
                      <Loader2 size={13} className="animate-spin" />
                    )}
                    {finalizing ? "Scoring…" : "View leaderboard"}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prewarm banner
// ---------------------------------------------------------------------------
function PrewarmBanner({
  state,
}: {
  state:
    | { status: "running"; message: string }
    | { status: "done"; cached: boolean };
}) {
  const done = state.status === "done";
  return (
    <div
      className="mb-6 flex items-center gap-3 rounded-xl border px-4 py-3.5"
      style={{
        borderColor: done ? BORDER : BORDER_STRONG,
        background: done ? "transparent" : SURFACE_RAISED,
      }}
    >
      <span
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border"
        style={{
          borderColor: done ? LIVE : TEXT_PRIMARY,
          color: done ? LIVE : TEXT_PRIMARY,
        }}
      >
        {done ? (
          <Check size={14} />
        ) : (
          <Loader2 size={14} className="animate-spin" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div
          className="text-[13px] font-semibold"
          style={{ color: TEXT_PRIMARY }}
        >
          {done ? "Environment ready" : "Preparing shared environment"}
        </div>
        <div className="text-[12px]" style={{ color: TEXT_TERTIARY }}>
          {done
            ? state.cached
              ? "Dependencies installed once and shared across every strategy."
              : "Dependency cache unavailable — each strategy will install its own."
            : state.message}
        </div>
      </div>
      <Package size={16} style={{ color: TEXT_QUIET }} className="shrink-0" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Race strip
// ---------------------------------------------------------------------------
function RaceStrip({
  strategies,
  candidates,
  currentIndex,
  disabled,
  onSelect,
}: {
  strategies: OptimizationStrategy[];
  candidates: Record<string, CandidateLiveState>;
  currentIndex: number;
  disabled?: boolean;
  onSelect?: (index: number) => void;
}) {
  return (
    <div
      className="mb-6 flex items-center gap-2"
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      {strategies.map((s, i) => {
        const stage = candidates[s.id]?.stage ?? "queued";
        const done = stage === "completed";
        const failed = stage === "failed";
        const active = !disabled && i === currentIndex && !done && !failed;
        return (
          <div key={s.id} className="flex flex-1 items-center gap-2">
            <button
              onClick={() => onSelect?.(i)}
              disabled={disabled}
              className="flex flex-1 items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-left transition-colors"
              style={{
                borderColor: failed
                  ? ERROR
                  : i === currentIndex
                    ? BORDER_STRONG
                    : BORDER,
                background: i === currentIndex ? SURFACE_RAISED : "transparent",
              }}
            >
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold"
                style={{
                  borderColor: failed
                    ? ERROR
                    : done
                      ? LIVE
                      : active
                        ? TEXT_PRIMARY
                        : BORDER_STRONG,
                  color: failed
                    ? ERROR
                    : done
                      ? LIVE
                      : active
                        ? TEXT_PRIMARY
                        : TEXT_QUIET,
                }}
              >
                {done ? (
                  <Check size={12} />
                ) : failed ? (
                  <XCircle size={12} />
                ) : active ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  i + 1
                )}
              </span>
              <div className="min-w-0">
                <div
                  className="truncate text-[12px] font-semibold"
                  style={{
                    color:
                      i === currentIndex || done ? TEXT_PRIMARY : TEXT_TERTIARY,
                    fontFamily: MONO,
                  }}
                >
                  {s.title}
                </div>
                <div className="text-[10px]" style={{ color: TEXT_QUIET }}>
                  Strategy {s.id}
                </div>
              </div>
            </button>
            {i < strategies.length - 1 && (
              <div
                className="h-px w-4 shrink-0"
                style={{ background: i < currentIndex ? LIVE : BORDER }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diff viewer
// ---------------------------------------------------------------------------
function DiffViewer({ strategy }: { strategy: OptimizationStrategy }) {
  const oldLines = strategy.diff.originalCode.split("\n");
  const newLines = strategy.diff.newCode.split("\n");

  return (
    <div
      className="overflow-hidden rounded-xl border"
      style={{ borderColor: BORDER }}
    >
      <div
        className="flex items-center gap-2 border-b px-4 py-2.5"
        style={{ borderColor: BORDER, background: SURFACE_RAISED }}
      >
        <FileCode size={13} style={{ color: TEXT_TERTIARY }} />
        <span
          className="text-[12px] font-medium"
          style={{ color: TEXT_SECONDARY, fontFamily: MONO }}
        >
          {strategy.diff.filePath}
        </span>
      </div>
      <div style={{ background: "#0a0a0a" }}>
        <div className="border-b" style={{ borderColor: "#2a1414" }}>
          {oldLines.map((line, i) => (
            <div
              key={`old-${i}`}
              className="flex px-4 py-0.5 text-[12px] leading-[1.6]"
              style={{ background: "#2a141480", fontFamily: MONO }}
            >
              <span className="mr-3 select-none" style={{ color: "#c85a5a" }}>
                −
              </span>
              <span style={{ color: "#e0a0a0" }}>{line || " "}</span>
            </div>
          ))}
        </div>
        <div>
          {newLines.map((line, i) => (
            <div
              key={`new-${i}`}
              className="flex px-4 py-0.5 text-[12px] leading-[1.6]"
              style={{ background: "#14321480", fontFamily: MONO }}
            >
              <span className="mr-3 select-none" style={{ color: LIVE }}>
                +
              </span>
              <span style={{ color: "#a0e0b0" }}>{line || " "}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small stat box
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Live badge — small pulsing "LIVE" indicator shown on panel headers
// while the candidate is actively benchmarking.
// ---------------------------------------------------------------------------
function LiveBadge() {
  return (
    <span
      className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.05em]"
      style={{ background: "#12321f", color: LIVE }}
    >
      <span
        className="h-1.5 w-1.5 animate-pulse rounded-full"
        style={{ background: LIVE }}
      />
      Live
    </span>
  );
}

// ---------------------------------------------------------------------------
// Monitoring panel shell — consistent header (icon, title, live badge,
// current value) + chart body, used by every metric panel below so the
// whole grid reads as one dashboard, not assorted components.
// ---------------------------------------------------------------------------
function MonitorPanel({
  icon: Icon,
  title,
  value,
  isLive,
  children,
}: {
  icon: typeof Cpu;
  title: string;
  value?: string;
  isLive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-xl border px-4 py-3"
      style={{ borderColor: BORDER, background: SURFACE_RAISED }}
    >
      <div className="mb-1.5 flex items-center justify-between">
        <span
          className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em]"
          style={{ color: TEXT_TERTIARY }}
        >
          <Icon size={12} />
          {title}
          {isLive && <LiveBadge />}
        </span>
        {value && (
          <span
            className="text-[13px] font-semibold"
            style={{ color: TEXT_PRIMARY, fontFamily: MONO }}
          >
            {value}
          </span>
        )}
      </div>
      <div className="h-[88px]">{children}</div>
    </div>
  );
}

function EmptyChartHint({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex h-full items-center text-[11px]"
      style={{ color: TEXT_QUIET }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Latency panel — per-request latency, plotted the instant each request
// finishes (from live.requestLog), not a periodic sample.
// ---------------------------------------------------------------------------
function LatencyPanel({
  live,
  result,
  isLive,
}: {
  live?: CandidateLiveState;
  result?: ArenaCandidateResult;
  isLive: boolean;
}) {
  const chartData = useMemo(() => {
    const entries = live?.requestLog ?? [];
    return entries
      .filter((r) => r.durationMs != null)
      .map((r) => ({ i: r.index, latency: r.durationMs as number, ok: r.ok }));
  }, [live?.requestLog]);

  const latest = chartData[chartData.length - 1];
  const value = latest
    ? `${Math.round(latest.latency)}ms`
    : result?.runResult
      ? `${Math.round(result.runResult.avgDurationMs)}ms avg`
      : undefined;

  return (
    <MonitorPanel icon={Gauge} title="Latency / request" value={value} isLive={isLive}>
      {chartData.length > 1 ? (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData}>
            <YAxis hide domain={[0, "auto"]} />
            <Tooltip
              contentStyle={{
                background: "#0a0a0a",
                border: `1px solid ${BORDER_STRONG}`,
                fontSize: 11,
                fontFamily: MONO,
              }}
              labelFormatter={(l) => `request #${l}`}
              formatter={(v: number) => [`${Math.round(v)}ms`, "latency"]}
            />
            <Area
              type="monotone"
              dataKey="latency"
              stroke={LIVE}
              fill={LIVE}
              fillOpacity={0.15}
              strokeWidth={1.5}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <EmptyChartHint>Plots as each request finishes…</EmptyChartHint>
      )}
    </MonitorPanel>
  );
}

// ---------------------------------------------------------------------------
// Throughput panel — requests/sec, bucketed from request timestamps.
// ---------------------------------------------------------------------------
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
    for (const r of entries) {
      const sec = Math.floor(r.timestamp / 1000);
      buckets.set(sec, (buckets.get(sec) ?? 0) + 1);
    }
    const sortedKeys = [...buckets.keys()].sort((a, b) => a - b);
    return sortedKeys.map((k, i) => ({ i, rps: buckets.get(k)! }));
  }, [live?.requestLog]);

  const latest = chartData[chartData.length - 1];

  return (
    <MonitorPanel
      icon={TrendingUp}
      title="Throughput"
      value={latest ? `${latest.rps} req/s` : undefined}
      isLive={isLive}
    >
      {chartData.length > 1 ? (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData}>
            <YAxis hide domain={[0, "auto"]} />
            <Tooltip
              contentStyle={{
                background: "#0a0a0a",
                border: `1px solid ${BORDER_STRONG}`,
                fontSize: 11,
                fontFamily: MONO,
              }}
              formatter={(v: number) => [`${v}`, "req/s"]}
            />
            <Bar dataKey="rps" fill={GOLD} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <EmptyChartHint>Requests per second, bucketed live…</EmptyChartHint>
      )}
    </MonitorPanel>
  );
}

// ---------------------------------------------------------------------------
// Status distribution — live success/error tally as requests come in.
// ---------------------------------------------------------------------------
function StatusDistributionPanel({
  live,
  isLive,
}: {
  live?: CandidateLiveState;
  isLive: boolean;
}) {
  const entries = live?.requestLog ?? [];
  const okCount = entries.filter((r) => r.ok).length;
  const errCount = entries.length - okCount;
  const total = entries.length || 1;
  const okPct = Math.round((okCount / total) * 100);

  return (
    <MonitorPanel
      icon={PieIcon}
      title="Status codes"
      value={entries.length ? `${okCount}/${entries.length} ok` : undefined}
      isLive={isLive}
    >
      {entries.length > 0 ? (
        <div className="flex h-full flex-col justify-center gap-3">
          <div
            className="flex h-2.5 w-full overflow-hidden rounded-full"
            style={{ background: "#2a1414" }}
          >
            <div
              className="h-full transition-all"
              style={{ width: `${okPct}%`, background: LIVE }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px]" style={{ fontFamily: MONO }}>
            <span className="flex items-center gap-1.5" style={{ color: LIVE }}>
              <span className="h-2 w-2 rounded-full" style={{ background: LIVE }} />
              {okCount} success
            </span>
            <span className="flex items-center gap-1.5" style={{ color: errCount > 0 ? ERROR : TEXT_QUIET }}>
              <span className="h-2 w-2 rounded-full" style={{ background: errCount > 0 ? ERROR : TEXT_QUIET }} />
              {errCount} error
            </span>
          </div>
        </div>
      ) : (
        <EmptyChartHint>Tally builds as requests land…</EmptyChartHint>
      )}
    </MonitorPanel>
  );
}

// ---------------------------------------------------------------------------
// CPU / Memory panels
// ---------------------------------------------------------------------------
function ResourcePanel({
  label,
  icon: Icon,
  value,
  data,
  dataKey,
  color,
  isLive,
}: {
  label: string;
  icon: typeof Cpu;
  value: string;
  data: { i: number; cpu: number; mem: number }[];
  dataKey: "cpu" | "mem";
  color: string;
  isLive: boolean;
}) {
  return (
    <MonitorPanel icon={Icon} title={label} value={value} isLive={isLive}>
      {data.length > 1 ? (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <YAxis hide domain={[0, "auto"]} />
            <Tooltip
              contentStyle={{
                background: "#0a0a0a",
                border: `1px solid ${BORDER_STRONG}`,
                fontSize: 11,
                fontFamily: MONO,
              }}
            />
            <Area
              type="monotone"
              dataKey={dataKey}
              stroke={color}
              fill={color}
              fillOpacity={0.12}
              strokeWidth={1.5}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <EmptyChartHint>Sampling every second…</EmptyChartHint>
      )}
    </MonitorPanel>
  );
}

// ---------------------------------------------------------------------------
// SigNoz telemetry panel
// ---------------------------------------------------------------------------
function TelemetryPanel({ live, isLive }: { live?: CandidateLiveState; isLive: boolean }) {
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
          className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em]"
          style={{ color: TEXT_TERTIARY }}
        >
          <Activity size={12} />
          SigNoz telemetry
          {isLive && <LiveBadge />}
        </span>
      </div>
      {t ? (
        <div className="mb-2 grid grid-cols-4 gap-2">
          <MiniStat label="Reqs" value={String(t.requestCount)} />
          <MiniStat
            label="Err"
            value={`${t.errorRatePercent}%`}
            accent={t.errorRatePercent > 2 ? ERROR : undefined}
          />
          <MiniStat label="p50" value={`${t.latencyMs.p50}ms`} />
          <MiniStat label="p95" value={`${t.latencyMs.p95}ms`} />
        </div>
      ) : (
        <p className="mb-2 text-[11px]" style={{ color: TEXT_QUIET }}>
          Waiting for spans…
        </p>
      )}
      <div className="h-20">
        {chartData.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid stroke={BORDER} vertical={false} />
              <YAxis hide domain={[0, "auto"]} />
              <XAxis hide />
              <Tooltip
                contentStyle={{
                  background: "#0a0a0a",
                  border: `1px solid ${BORDER_STRONG}`,
                  fontSize: 11,
                  fontFamily: MONO,
                }}
              />
              <Line type="monotone" dataKey="p50" stroke={TEXT_TERTIARY} dot={false} strokeWidth={1.5} isAnimationActive={false} />
              <Line type="monotone" dataKey="p95" stroke={LIVE} dot={false} strokeWidth={1.75} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <EmptyChartHint>Not enough samples yet…</EmptyChartHint>
        )}
      </div>
    </div>
  );
}

function StatusPill({ stage }: { stage: string }) {
  if (stage === "completed")
    return (
      <span
        className="flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-[0.05em]"
        style={{ background: "#12321f", color: LIVE }}
      >
        <Check size={11} /> Done
      </span>
    );
  if (stage === "failed")
    return (
      <span
        className="flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-[0.05em]"
        style={{ background: "#321414", color: ERROR }}
      >
        <XCircle size={11} /> Failed
      </span>
    );
  if (stage === "queued")
    return (
      <span
        className="shrink-0 rounded-full border px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-[0.05em]"
        style={{ borderColor: BORDER_STRONG, color: TEXT_TERTIARY }}
      >
        Not run yet
      </span>
    );
  return (
    <span
      className="flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-[0.05em]"
      style={{ background: "#ffffff14", color: TEXT_PRIMARY }}
    >
      <Loader2 size={10} className="animate-spin" /> Live
    </span>
  );
}

// ---------------------------------------------------------------------------
// Per-request table
// ---------------------------------------------------------------------------
function RequestLogTable({ entries }: { entries: CandidateLiveState["requestLog"] }) {
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
    <div className="max-h-72 overflow-y-auto rounded-lg border" style={{ borderColor: BORDER }}>
      <table className="w-full text-[11.5px]" style={{ fontFamily: MONO }}>
        <thead>
          <tr className="sticky top-0" style={{ background: SURFACE_RAISED }}>
            <th className="px-3 py-1.5 text-left font-semibold" style={{ color: TEXT_TERTIARY }}>#</th>
            <th className="px-3 py-1.5 text-left font-semibold" style={{ color: TEXT_TERTIARY }}>Method</th>
            <th className="px-3 py-1.5 text-left font-semibold" style={{ color: TEXT_TERTIARY }}>URL</th>
            <th className="px-3 py-1.5 text-left font-semibold" style={{ color: TEXT_TERTIARY }}>Status</th>
            <th className="px-3 py-1.5 text-right font-semibold" style={{ color: TEXT_TERTIARY }}>Duration</th>
          </tr>
        </thead>
        <tbody>
          {[...entries].slice(-100).reverse().map((r) => (
            <tr key={r.index} style={{ borderTop: `1px solid ${BORDER}` }}>
              <td className="px-3 py-1.5" style={{ color: TEXT_QUIET }}>{r.index}</td>
              <td className="px-3 py-1.5" style={{ color: TEXT_TERTIARY }}>{r.method ?? "—"}</td>
              <td className="max-w-[320px] truncate px-3 py-1.5" style={{ color: TEXT_SECONDARY }} title={r.url ?? undefined}>
                {r.url ?? "—"}
              </td>
              <td className="px-3 py-1.5 font-semibold" style={{ color: r.ok ? LIVE : ERROR }}>{r.status}</td>
              <td className="px-3 py-1.5 text-right" style={{ color: TEXT_SECONDARY }}>
                {r.durationMs != null ? `${r.durationMs}ms` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Focused, single strategy — now a genuine live monitoring dashboard:
// a top-of-panel monitoring grid (latency, throughput, status codes,
// CPU, memory, SigNoz telemetry — 6 live panels) is the primary view,
// with the diff / per-request log / raw console pushed below as
// secondary detail. Every panel updates as requests stream in, not
// just once at the end.
// ---------------------------------------------------------------------------
function FocusedCandidate({
  strategy,
  live,
  result,
  isRunning,
  canRun,
  onRun,
  onRerun,
}: {
  strategy: OptimizationStrategy;
  live?: CandidateLiveState;
  result?: ArenaCandidateResult;
  isRunning: boolean;
  canRun: boolean;
  onRun: () => void;
  onRerun: () => void;
}) {
  const stage = live?.stage ?? (result ? result.status : "queued");
  const failed = stage === "failed";
  const isLive = stage === "benchmarking" || stage === "healthcheck" || stage === "provisioning";
  const idx = stageIndex(stage);
  const elapsed = useElapsed(
    !!live && stage !== "queued" && !result,
    live?.stageEnteredAt ?? Date.now(),
  );

  const resourceChartData = useMemo(
    () => (live?.metrics ?? []).map((m, i) => ({ i, cpu: m.cpuPercent, mem: m.memoryMB })),
    [live?.metrics],
  );
  const latestMetric = live?.metrics[live.metrics.length - 1];
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [live?.logs.length]);

  const hasStarted = !!live || !!result;

  return (
    <div
      className="rounded-2xl border"
      style={{
        borderColor: failed ? ERROR : BORDER_STRONG,
        background: SURFACE,
      }}
    >
      <div
        className="flex flex-wrap items-start justify-between gap-3 border-b px-6 py-5"
        style={{ borderColor: BORDER }}
      >
        <div>
          <div
            className="text-[10.5px] font-bold uppercase tracking-[0.07em]"
            style={{ color: TEXT_TERTIARY }}
          >
            Strategy {strategy.id} · {strategy.approach}
          </div>
          <h2
            className="mt-1 text-[20px] font-semibold"
            style={{ color: TEXT_PRIMARY, fontFamily: MONO }}
          >
            {strategy.title}
          </h2>
          <p
            className="mt-1.5 max-w-2xl text-[13px] leading-[1.6]"
            style={{ color: TEXT_SECONDARY }}
          >
            {strategy.description}
          </p>
          <div className="mt-2 flex items-center gap-1.5">
            <Sparkles size={12} style={{ color: GOLD }} />
            <span className="text-[11.5px]" style={{ color: TEXT_TERTIARY }}>
              Estimated +{strategy.estimatedImprovementPercent.min}–
              {strategy.estimatedImprovementPercent.max}% ·{" "}
              {strategy.confidence} confidence
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {result && (
            <button
              onClick={onRerun}
              className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11.5px] font-medium transition-colors"
              style={{ borderColor: BORDER_STRONG, color: TEXT_SECONDARY }}
            >
              <Play size={11} />
              Run again
            </button>
          )}
          {stage !== "queued" && !result && (
            <span
              className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium"
              style={{ borderColor: BORDER_STRONG, color: TEXT_SECONDARY, fontFamily: MONO }}
            >
              <Clock size={11} />
              {fmtElapsed(elapsed)}
            </span>
          )}
          <StatusPill stage={result ? result.status : stage} />
        </div>
      </div>

      {!hasStarted && (
        <div className="flex flex-col items-start gap-3 px-6 py-6">
          <p className="text-[13px]" style={{ color: TEXT_SECONDARY }}>
            This strategy hasn't been tested yet. Running it will patch the
            code, boot an isolated container, and send live traffic against
            it using the same script generated earlier.
          </p>
          <button
            onClick={onRun}
            disabled={!canRun || isRunning}
            className="flex items-center gap-1.5 rounded-lg bg-white px-4 py-2 text-[12.5px] font-bold text-black transition-colors hover:bg-[#e5e5e5] disabled:opacity-40"
          >
            {isRunning ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
            {isRunning ? "Starting…" : "Run this strategy"}
          </button>
        </div>
      )}

      {hasStarted && (
        <>
          {/* Pipeline stepper */}
          <div className="flex items-center gap-1.5 px-6 pt-5">
            {PIPELINE.map((step, i) => {
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
                    ? TEXT_PRIMARY
                    : stepState === "failed"
                      ? ERROR
                      : TEXT_QUIET;
              return (
                <div key={step.stage} className="flex flex-1 items-center gap-1.5">
                  <div className="flex flex-col items-center gap-1.5">
                    <div
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border"
                      style={{ borderColor: color, color, background: stepState === "active" ? "#ffffff0d" : "transparent" }}
                    >
                      {stepState === "active" ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : stepState === "done" ? (
                        <Check size={13} />
                      ) : (
                        <StepIcon size={13} />
                      )}
                    </div>
                    <span className="text-[10px] font-medium" style={{ color }}>
                      {step.label}
                    </span>
                  </div>
                  {i < PIPELINE.length - 1 && (
                    <div
                      className="mb-4 h-px flex-1"
                      style={{ background: i < idx || stage === "completed" ? LIVE : BORDER }}
                    />
                  )}
                </div>
              );
            })}
          </div>

          <p
            className="px-6 pb-1 pt-4 text-[13px]"
            style={{ color: failed ? ERROR : TEXT_SECONDARY }}
          >
            {failed ? (live?.error ?? result?.error ?? "Failed") : result ? "Finished." : STAGE_MESSAGE[stage]}
          </p>

          {failed && (
            <div className="px-6 pt-3">
              <div
                className="flex items-start gap-2 rounded-xl border px-4 py-3"
                style={{ borderColor: ERROR, background: "#2a1414" }}
              >
                <AlertTriangle size={15} style={{ color: ERROR }} className="mt-0.5 shrink-0" />
                <p className="text-[13px]" style={{ color: "#e0a0a0" }}>
                  {live?.error ?? result?.error}
                </p>
              </div>
            </div>
          )}

          {/* ---- LIVE MONITORING GRID — the primary view ---- */}
          <div className="px-6 pt-5">
            <div
              className="mb-3 flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.06em]"
              style={{ color: TEXT_TERTIARY }}
            >
              <Activity size={12} />
              Live monitoring
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <LatencyPanel live={live} result={result} isLive={isLive} />
              <ThroughputPanel live={live} isLive={isLive} />
              <StatusDistributionPanel live={live} isLive={isLive} />
              <ResourcePanel
                label="CPU"
                icon={Cpu}
                value={
                  latestMetric
                    ? `${latestMetric.cpuPercent}%`
                    : result?.cpuPercent != null
                      ? `${result.cpuPercent}%`
                      : "—"
                }
                data={resourceChartData}
                dataKey="cpu"
                color={LIVE}
                isLive={isLive}
              />
              <ResourcePanel
                label="Memory"
                icon={MemoryStick}
                value={
                  latestMetric
                    ? `${Math.round(latestMetric.memoryMB)}MB`
                    : result?.memoryMB != null
                      ? `${Math.round(result.memoryMB)}MB`
                      : "—"
                }
                data={resourceChartData}
                dataKey="mem"
                color={GOLD}
                isLive={isLive}
              />
              <TelemetryPanel live={live} isLive={isLive} />
            </div>
          </div>

          {/* Result summary strip — once finished */}
          {result && result.status === "completed" && (
            <div className="px-6 pt-5">
              <div
                className="mb-2 flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.06em]"
                style={{ color: TEXT_TERTIARY }}
              >
                <Check size={12} style={{ color: LIVE }} />
                Final result for this strategy
              </div>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                <MiniStat
                  label="Avg"
                  value={result.runResult ? `${Math.round(result.runResult.avgDurationMs)}ms` : "—"}
                />
                <MiniStat
                  label="p95"
                  value={result.runResult?.p95DurationMs != null ? `${Math.round(result.runResult.p95DurationMs)}ms` : "—"}
                />
                <MiniStat
                  label="Errors"
                  value={result.runResult ? String(result.runResult.errorCount) : "—"}
                  accent={result.runResult && result.runResult.errorCount > 0 ? ERROR : undefined}
                />
                <MiniStat
                  label="Requests"
                  value={result.runResult ? String(result.runResult.requestsSent) : "—"}
                />
              </div>
            </div>
          )}

          {/* ---- Secondary detail: diff, request log, raw console ---- */}
          <div className="px-6 pt-6">
            <span
              className="flex w-fit items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11.5px]"
              style={{ borderColor: BORDER_STRONG, color: TEXT_SECONDARY, fontFamily: MONO }}
            >
              <FileCode size={11} style={{ color: TEXT_TERTIARY }} />1 file changed · {strategy.diff.filePath}
            </span>
          </div>

          <div className="grid grid-cols-1 gap-5 px-6 pt-4 xl:grid-cols-2">
            <div>
              <div
                className="mb-2 flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.06em]"
                style={{ color: TEXT_TERTIARY }}
              >
                <GitBranch size={12} />
                Code change
              </div>
              <DiffViewer strategy={strategy} />
            </div>

            <div>
              <div
                className="mb-2 flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.06em]"
                style={{ color: TEXT_TERTIARY }}
              >
                <List size={12} />
                Per-request log
              </div>
              <RequestLogTable entries={live?.requestLog ?? []} />
            </div>
          </div>

          <div className="px-6 pb-6 pt-5">
            <div
              className="mb-2 flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.06em]"
              style={{ color: TEXT_TERTIARY }}
            >
              <Terminal size={12} />
              Live output
            </div>
            <div
              ref={logRef}
              className="h-56 overflow-y-auto rounded-xl border px-4 py-3"
              style={{ borderColor: BORDER, background: "#0a0a0a" }}
            >
              {!live || live.logs.length === 0 ? (
                <p className="text-[12px]" style={{ color: TEXT_QUIET, fontFamily: MONO }}>
                  {result ? "Run finished." : "Waiting for output…"}
                </p>
              ) : (
                live.logs.map((line, i) => (
                  <div
                    key={i}
                    className="whitespace-pre-wrap break-all text-[12px] leading-[1.65]"
                    style={{ color: TEXT_SECONDARY, fontFamily: MONO }}
                  >
                    {line}
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Final board — unchanged
// ---------------------------------------------------------------------------
const RANK_ICON_COLOR = [GOLD, "#c9cad0", "#c98a4d"];
type Tab = "overview" | "diff" | "metrics";

function FinalBoard({
  result,
  strategies,
}: {
  result: ArenaResult;
  strategies: OptimizationStrategy[];
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

  const [expandedId, setExpandedId] = useState<string | null>(result.winnerStrategyId);
  const [tabById, setTabById] = useState<Record<string, Tab>>({});

  return (
    <div>
      <div
        className="mb-5 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.06em]"
        style={{ color: TEXT_TERTIARY }}
      >
        <span>Leaderboard</span>
        <span style={{ color: TEXT_SECONDARY }}>
          {result.candidates.length} strategies benchmarked
        </span>
      </div>

      <div className="flex flex-col gap-2.5">
        {ranked.map((c, i) => {
          const strategy = strategyById[c.strategyId];
          const isWinner = c.strategyId === result.winnerStrategyId;
          const failed = c.status === "failed";
          const rankColor = i < 3 ? RANK_ICON_COLOR[i] : TEXT_TERTIARY;
          const expanded = expandedId === c.strategyId;
          const tab = tabById[c.strategyId] ?? "overview";

          return (
            <div
              key={c.strategyId}
              className="overflow-hidden rounded-2xl border opacity-0"
              style={{
                borderColor: isWinner ? GOLD : BORDER_STRONG,
                background: isWinner ? "#1c1a12" : SURFACE_RAISED,
                animation: `arenaRowIn 320ms ease-out ${i * 80}ms forwards`,
              }}
            >
              <button
                onClick={() => setExpandedId(expanded ? null : c.strategyId)}
                className="flex w-full flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4 text-left"
              >
                <div className="flex min-w-[190px] flex-1 items-center gap-3">
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[12px] font-bold"
                    style={{ borderColor: BORDER_STRONG, color: rankColor }}
                  >
                    {failed ? <XCircle size={15} style={{ color: ERROR }} /> : i + 1}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-semibold" style={{ color: TEXT_PRIMARY, fontFamily: MONO }}>
                      {c.title || strategy?.title}
                    </div>
                    <div className="text-[10.5px]" style={{ color: TEXT_TERTIARY }}>
                      Strategy {c.strategyId}
                      {strategy && ` · ${strategy.approach}`}
                    </div>
                  </div>
                  {isWinner && (
                    <span
                      className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em]"
                      style={{ background: GOLD, color: "#1a1400" }}
                    >
                      <Trophy size={11} /> Best
                    </span>
                  )}
                </div>

                {failed ? (
                  <span className="text-[12.5px]" style={{ color: ERROR }}>
                    Failed: {c.error}
                  </span>
                ) : (
                  <div className="flex flex-wrap items-center gap-4 text-[13px]" style={{ fontFamily: MONO }}>
                    <Metric label="avg" value={c.runResult ? `${Math.round(c.runResult.avgDurationMs)}ms` : "—"} />
                    <Metric label="p95" value={c.runResult?.p95DurationMs != null ? `${Math.round(c.runResult.p95DurationMs)}ms` : "—"} />
                    <Metric label="errors" value={c.runResult ? String(c.runResult.errorCount) : "—"} />
                    {c.cpuPercent != null && <Metric icon={Cpu} label="cpu" value={`${c.cpuPercent}%`} />}
                    {c.memoryMB != null && <Metric icon={MemoryStick} label="mem" value={`${Math.round(c.memoryMB)}MB`} />}
                    <span
                      className="ml-1 rounded-lg border px-3 py-1.5 font-bold"
                      style={{ borderColor: isWinner ? GOLD : BORDER_STRONG, color: isWinner ? GOLD : TEXT_PRIMARY }}
                    >
                      score {c.score ?? "—"}
                    </span>
                  </div>
                )}

                <ChevronDown
                  size={16}
                  className="shrink-0 transition-transform"
                  style={{ color: TEXT_TERTIARY, transform: expanded ? "rotate(180deg)" : "none" }}
                />
              </button>

              {expanded && (
                <div className="border-t px-5 py-5" style={{ borderColor: BORDER }}>
                  <div className="mb-4 flex items-center gap-1">
                    {(["overview", "diff", "metrics"] as Tab[]).map((t) => (
                      <button
                        key={t}
                        onClick={() => setTabById((prev) => ({ ...prev, [c.strategyId]: t }))}
                        className="rounded-lg px-3 py-1.5 text-[11.5px] font-semibold capitalize transition-colors"
                        style={{ background: tab === t ? "#ffffff14" : "transparent", color: tab === t ? TEXT_PRIMARY : TEXT_TERTIARY }}
                      >
                        {t === "diff" ? "Code change" : t}
                      </button>
                    ))}
                  </div>

                  {tab === "overview" && <OverviewTab candidate={c} strategy={strategy} />}
                  {tab === "diff" && strategy && <DiffViewer strategy={strategy} />}
                  {tab === "metrics" && <MetricsTab candidate={c} />}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <style>{`
        @keyframes arenaRowIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

function OverviewTab({
  candidate,
  strategy,
}: {
  candidate: ArenaCandidateResult;
  strategy?: OptimizationStrategy;
}) {
  const rr = candidate.runResult;
  const improvementPct =
    strategy && rr
      ? `${strategy.estimatedImprovementPercent.min}–${strategy.estimatedImprovementPercent.max}%`
      : null;

  return (
    <div className="flex flex-col gap-5">
      {strategy && (
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.06em]" style={{ color: TEXT_TERTIARY }}>
            <Sparkles size={12} style={{ color: GOLD }} />
            Why this works
          </div>
          <p className="text-[13.5px] leading-[1.65]" style={{ color: TEXT_SECONDARY }}>
            {strategy.description}
          </p>
          {improvementPct && (
            <div className="mt-2 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11.5px] font-bold" style={{ background: "#fff", color: "#0a0a0a" }}>
              Estimated +{improvementPct} · {strategy.confidence} confidence
            </div>
          )}
        </div>
      )}

      {candidate.status === "failed" ? (
        <div className="flex items-start gap-2 rounded-xl border px-4 py-3" style={{ borderColor: ERROR, background: "#2a1414" }}>
          <AlertTriangle size={15} style={{ color: ERROR }} className="mt-0.5 shrink-0" />
          <p className="text-[13px]" style={{ color: "#e0a0a0" }}>{candidate.error}</p>
        </div>
      ) : (
        <div>
          <div className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.06em]" style={{ color: TEXT_TERTIARY }}>
            Load test results
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatBox label="Avg latency" value={rr ? `${Math.round(rr.avgDurationMs)}ms` : "—"} />
            <StatBox label="p95 latency" value={rr?.p95DurationMs != null ? `${Math.round(rr.p95DurationMs)}ms` : "—"} />
            <StatBox label="Errors" value={rr ? String(rr.errorCount) : "—"} accent={rr && rr.errorCount > 0 ? ERROR : undefined} />
            <StatBox label="File changed" value={strategy ? "1" : "—"} sub={strategy?.diff.filePath} />
          </div>
        </div>
      )}
    </div>
  );
}

function StatBox({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="rounded-xl border px-3.5 py-3" style={{ borderColor: BORDER, background: SURFACE }}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.05em]" style={{ color: TEXT_TERTIARY }}>
        {label}
      </div>
      <div className="mt-1 text-[16px] font-bold" style={{ color: accent ?? TEXT_PRIMARY, fontFamily: MONO }}>
        {value}
      </div>
      {sub && (
        <div className="mt-0.5 truncate text-[10px]" style={{ color: TEXT_QUIET, fontFamily: MONO }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function MetricsTab({ candidate }: { candidate: ArenaCandidateResult }) {
  const chartData = useMemo(
    () => (candidate.metricsHistory ?? []).map((m, i) => ({ i, cpu: m.cpuPercent, mem: m.memoryMB })),
    [candidate.metricsHistory],
  );

  if (chartData.length === 0) {
    return (
      <p className="text-[12.5px]" style={{ color: TEXT_QUIET }}>
        No resource samples were captured for this run.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <div className="rounded-xl border px-4 py-3" style={{ borderColor: BORDER, background: SURFACE }}>
        <div className="mb-2 flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.06em]" style={{ color: TEXT_TERTIARY }}>
          <Cpu size={12} />
          CPU over run
        </div>
        <div className="h-32">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <CartesianGrid stroke={BORDER} strokeDasharray="3 3" vertical={false} />
              <YAxis hide domain={[0, "auto"]} />
              <XAxis hide />
              <Tooltip contentStyle={{ background: "#0a0a0a", border: `1px solid ${BORDER_STRONG}`, fontSize: 11, fontFamily: MONO }} />
              <Area type="monotone" dataKey="cpu" stroke={LIVE} fill={LIVE} fillOpacity={0.15} strokeWidth={1.5} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="rounded-xl border px-4 py-3" style={{ borderColor: BORDER, background: SURFACE }}>
        <div className="mb-2 flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.06em]" style={{ color: TEXT_TERTIARY }}>
          <MemoryStick size={12} />
          Memory over run
        </div>
        <div className="h-32">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <CartesianGrid stroke={BORDER} strokeDasharray="3 3" vertical={false} />
              <YAxis hide domain={[0, "auto"]} />
              <XAxis hide />
              <Tooltip contentStyle={{ background: "#0a0a0a", border: `1px solid ${BORDER_STRONG}`, fontSize: 11, fontFamily: MONO }} />
              <Area type="monotone" dataKey="mem" stroke={GOLD} fill={GOLD} fillOpacity={0.12} strokeWidth={1.5} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon?: typeof Cpu;
  label: string;
  value: string;
}) {
  return (
    <span className="flex items-center gap-1" style={{ color: TEXT_SECONDARY }}>
      {Icon && <Icon size={11} style={{ color: TEXT_TERTIARY }} />}
      <span style={{ color: TEXT_TERTIARY }}>{label}</span>
      {value}
    </span>
  );
}