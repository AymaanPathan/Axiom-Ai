import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useDispatch, useSelector } from "react-redux";
import { Highlight, themes, type Language } from "prism-react-renderer";
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import {
  Sparkles,
  Play,
  GitBranch,
  Server,
  Database,
  FileCode2,
  Radio,
  Check,
  X,
  Loader2,
  KeyRound,
  Terminal,
  Code2,
  BarChart3,
  Wand2,
  ChevronDown,
  ChevronUp,
  Info,
  Workflow,
  Cpu,
  MemoryStick,
} from "lucide-react";
import type { AppDispatch, RootState } from "../store/store";
import { fetchRepoDetail } from "../store/slices/reposSlice";

import {
  generateLoadScript,
  runLoadScript,
  getTelemetry,
  getExplanation,
  getConnectedFiles,
  type LoadScriptResult,
  type RouteTelemetry,
  type ConnectedFilesResult,
  type ConnectedFile,
} from "../api/repos";
import { useTrafficStream } from "../hooks/useTrafficStream";
import {
  analyzePerformance,
  applyFixAndRetest,
  type PerformanceReport,
} from "../api/repos";
import PerformanceReportFull from "../components/PerformanceReportFull";
import ExecutionConsole from "../components/ExecutionConsole";
import SourceOverlay from "../components/SourceOverlay";
import {
  MONO,
  SANS,
  BG,
  SURFACE,
  SURFACE_RAISED,
  BORDER,
  BORDER_STRONG,
  BORDER_HOVER,
  TEXT_PRIMARY,
  TEXT_SECONDARY,
  TEXT_TERTIARY,
  TEXT_QUIET,
  ACCENT,
  ACCENT_HOVER,
  ACCENT_SOFT,
  ACCENT_TEXT,
  LIVE,
  LIVE_SOFT,
  ERROR,
  ERROR_SOFT,
  SIDEBAR_WIDTH,
  CONTENT_MAX_WIDTH,
  CONSOLE_HEIGHT_NARROW,
  CONSOLE_HEIGHT_WIDE,
} from "../theme";
import { useServiceMetrics } from "../hooks/useServiceMetrics";

const TELEMETRY_POLL_MS = 2000;
const TELEMETRY_POLL_DURATION_MS = 20_000;
const MAX_CHART_POINTS = 30;

const ROLE_META: Record<
  ConnectedFile["role"],
  { label: string; icon: typeof GitBranch }
> = {
  route: { label: "Route", icon: GitBranch },
  controller: { label: "Controller", icon: Server },
  service: { label: "Service", icon: Database },
  other: { label: "File", icon: FileCode2 },
};

function languageFor(filePath: string): Language {
  const ext = filePath.split(".").pop();
  if (ext === "ts" || ext === "tsx") return "tsx";
  if (ext === "js" || ext === "jsx") return "jsx";
  return "jsx";
}

interface TelemetryPoint {
  time: string;
  p50: number;
  p95: number;
}

type StageKey = "script" | "run" | "analyze";
type StageStatus = "pending" | "active" | "done";

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function SectionLabel({
  icon: Icon,
  children,
  action,
}: {
  icon?: typeof Info;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <span
        className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em]"
        style={{ color: TEXT_TERTIARY }}
      >
        {Icon && <Icon size={12} />}
        {children}
      </span>
      {action}
    </div>
  );
}

// Generic card shell used for every panel in the playground. A single
// consistent container — instead of ad hoc borders scattered per-section —
// is most of what makes the page read as "one product" rather than a pile
// of components.
function Panel({
  children,
  accent = false,
  className = "",
  style,
}: {
  children: React.ReactNode;
  accent?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={`rounded-2xl border ${className}`}
      style={{
        borderColor: accent ? ACCENT : BORDER,
        background: BG,
        boxShadow: accent
          ? "0 1px 2px rgba(20,20,10,0.04), 0 12px 28px -18px rgba(245,196,0,0.35)"
          : "0 1px 2px rgba(20,20,10,0.03)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function PanelHeader({
  icon: Icon,
  title,
  action,
}: {
  icon?: typeof Info;
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 border-b px-5 py-3.5"
      style={{ borderColor: BORDER }}
    >
      <span
        className="flex items-center gap-2 text-[13px] font-semibold"
        style={{ color: TEXT_PRIMARY }}
      >
        {Icon && <Icon size={14} style={{ color: TEXT_TERTIARY }} />}
        {title}
      </span>
      {action}
    </div>
  );
}

function CodeBlock({ code, filePath }: { code: string; filePath: string }) {
  return (
    <Highlight
      code={code}
      language={languageFor(filePath)}
      theme={themes.vsLight}
    >
      {({ className, tokens, getLineProps, getTokenProps }) => (
        <pre
          className={className}
          style={{
            margin: 0,
            padding: "14px 0",
            background: "transparent",
            fontFamily: MONO,
            fontSize: 13,
            lineHeight: 1.75,
            overflow: "auto",
          }}
        >
          {tokens.map((line, i) => (
            <div
              key={i}
              {...getLineProps({ line })}
              style={{ display: "flex" }}
            >
              <span
                style={{
                  width: 40,
                  flexShrink: 0,
                  textAlign: "right",
                  paddingRight: 16,
                  color: TEXT_QUIET,
                  userSelect: "none",
                }}
              >
                {i + 1}
              </span>
              <span style={{ flex: 1, whiteSpace: "pre", paddingRight: 20 }}>
                {line.map((token, key) => (
                  <span key={key} {...getTokenProps({ token })} />
                ))}
              </span>
            </div>
          ))}
        </pre>
      )}
    </Highlight>
  );
}

function StatBlock({
  label,
  value,
  alert,
}: {
  label: string;
  value: string | number;
  alert?: boolean;
}) {
  return (
    <div
      className="rounded-xl border px-3.5 py-3"
      style={{ borderColor: BORDER, background: SURFACE }}
    >
      <div
        className="text-[10.5px] font-medium uppercase tracking-[0.06em]"
        style={{ color: TEXT_TERTIARY }}
      >
        {label}
      </div>
      <div
        className="mt-1.5 flex items-center gap-1.5 text-[16px] font-semibold"
        style={{ color: TEXT_PRIMARY, fontFamily: MONO }}
      >
        {value}
        {alert && (
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: ERROR }}
          />
        )}
      </div>
    </div>
  );
}

function ErrorChip({
  icon: Icon,
  children,
}: {
  icon: typeof X;
  children: React.ReactNode;
}) {
  return (
    <span
      className="flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-[12.5px] font-semibold"
      style={{ borderColor: ERROR, color: ERROR, background: ERROR_SOFT }}
    >
      <Icon size={13} />
      {children}
    </span>
  );
}

// Horizontal progress — script, run, analyze read left to right the same
// way the user actually moves through the page.
function Stepper({ statuses }: { statuses: Record<StageKey, StageStatus> }) {
  const steps: { key: StageKey; label: string }[] = [
    { key: "script", label: "Script" },
    { key: "run", label: "Run" },
    { key: "analyze", label: "Analyze" },
  ];
  return (
    <div className="flex items-center gap-2.5">
      {steps.map((step, i) => {
        const status = statuses[step.key];
        return (
          <div key={step.key} className="flex items-center gap-2.5">
            <div className="flex items-center gap-1.5">
              <span
                className="flex h-5 w-5 items-center justify-center rounded-full text-[10.5px] font-bold"
                style={{
                  background:
                    status === "done"
                      ? TEXT_PRIMARY
                      : status === "active"
                        ? ACCENT
                        : SURFACE_RAISED,
                  color:
                    status === "pending"
                      ? TEXT_QUIET
                      : status === "active"
                        ? TEXT_PRIMARY
                        : "#fff",
                }}
              >
                {status === "active" ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : status === "done" ? (
                  <Check size={11} />
                ) : (
                  i + 1
                )}
              </span>
              <span
                className="text-[12px] font-semibold"
                style={{
                  color: status === "pending" ? TEXT_QUIET : TEXT_PRIMARY,
                }}
              >
                {step.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <span
                className="h-px w-8"
                style={{ background: BORDER_STRONG }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function ApiWorkspace() {
  const { repositoryId = "", routeIndex = "" } = useParams<{
    repositoryId: string;
    routeIndex: string;
  }>();
  const dispatch = useDispatch<AppDispatch>();
  const repo = useSelector(
    (state: RootState) => state.repos.byId[repositoryId],
  );
  const route = repo?.routes[Number(routeIndex)];

  const { entries, progress, reset } = useTrafficStream(repositoryId || null);
  const {
    history: metricsHistory,
    latest: latestMetrics,
    connected: metricsConnected,
  } = useServiceMetrics(repositoryId || null);

  
  // --- endpoint context ---
  const [explanation, setExplanation] = useState<string | null>(null);
  const [explanationLoading, setExplanationLoading] = useState(false);
  const [explanationExpanded, setExplanationExpanded] = useState(false);
  const [connected, setConnected] = useState<ConnectedFilesResult | null>(null);
  const [activeFile, setActiveFile] = useState<ConnectedFile | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [authToken, setAuthToken] = useState("");
  const [sourceOpen, setSourceOpen] = useState(false);

  // --- live telemetry ---
  const [telemetry, setTelemetry] = useState<RouteTelemetry | null>(null);
  const [chartData, setChartData] = useState<TelemetryPoint[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // --- AI traffic generator (k6) ---
  const [description, setDescription] = useState("");
  const [script, setScript] = useState<string | null>(null);
  const [scriptEditing, setScriptEditing] = useState(false);
  const [scriptLoading, setScriptLoading] = useState(false);
  const [scriptRunning, setScriptRunning] = useState(false);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [loadResult, setLoadResult] = useState<LoadScriptResult | null>(null);
  // Tracks whether a load test has EVER completed for this session — kept
  // separate from `loadResult` itself. `loadResult` is intentionally set
  // back to null at the start of every new run (handleRunScript) so the
  // stats panel can show a "running…" state, but that null shouldn't tear
  // down the whole Analysis & optimization panel just because a new run
  // started.
  const [hasEverRun, setHasEverRun] = useState(false);
  const [perfReport, setPerfReport] = useState<PerformanceReport | null>(null);
  const [perfLoading, setPerfLoading] = useState(false);
  const [perfError, setPerfError] = useState<string | null>(null);
  const [baselineResult, setBaselineResult] = useState<LoadScriptResult | null>(
    null,
  );
  const [comparisonResult, setComparisonResult] =
    useState<LoadScriptResult | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const analyzedRunRef = useRef<LoadScriptResult | null>(null);
  const [applyFixLoading, setApplyFixLoading] = useState(false);
  const [applyFixError, setApplyFixError] = useState<string | null>(null);
  const [fixApplied, setFixApplied] = useState(false);
  void applyFixLoading;
  void applyFixError;
  void fixApplied;

  // --- execution console (bottom drawer) ---
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleExpanded, setConsoleExpanded] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (repositoryId && !repo) dispatch(fetchRepoDetail(repositoryId));
  }, [repositoryId, repo, dispatch]);

  useEffect(() => {
    if (!repositoryId || !route) return;
    setExplanationLoading(true);
    getExplanation(repositoryId, route.file, route.line)
      .then(setExplanation)
      .catch(() => setExplanation(null))
      .finally(() => setExplanationLoading(false));

    getConnectedFiles(repositoryId, route.file, route.line)
      .then((result) => {
        setConnected(result);
        setActiveFile(result.files[0] ?? null);
      })
      .catch(() => setConnected(null));
  }, [repositoryId, route?.file, route?.line]);

  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!loadResult || !telemetry) return;
    if (analyzedRunRef.current === loadResult) return;

    const windowCoversRun = telemetry.window.end >= loadResult.windowEnd;
    if (!windowCoversRun) return;

    analyzedRunRef.current = loadResult;
    setPerfLoading(true);
    setPerfError(null);
    analyzePerformance(repositoryId, Number(routeIndex), loadResult, telemetry)
      .then((report) => {
        setPerfReport(report);
        setBaselineResult(loadResult);
        setComparisonResult(null);
      })
      .catch((err) =>
        setPerfError(err instanceof Error ? err.message : "Analysis failed"),
      )
      .finally(() => setPerfLoading(false));
  }, [loadResult, telemetry, repositoryId, routeIndex]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [description]);

  const pollTelemetry = (start: number, end: number, serviceName: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    const pollEnd = Date.now() + TELEMETRY_POLL_DURATION_MS;

    const tick = async () => {
      try {
        const t = await getTelemetry(
          repositoryId,
          Number(routeIndex),
          start,
          Date.now(),
          serviceName,
        );
        setTelemetry(t);
        setChartData((prev) =>
          [
            ...prev,
            {
              time: new Date().toLocaleTimeString([], {
                minute: "2-digit",
                second: "2-digit",
              }),
              p50: t.latencyMs.p50,
              p95: t.latencyMs.p95,
            },
          ].slice(-MAX_CHART_POINTS),
        );
      } catch {
        // keep last good value, retry next tick
      }
      if (Date.now() > pollEnd && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };

    tick();
    pollRef.current = setInterval(tick, TELEMETRY_POLL_MS);
  };

  const handleGenerateScript = async () => {
    if (!repositoryId || !description.trim()) return;
    setScriptLoading(true);
    setScriptError(null);
    setLoadResult(null);
    setPerfReport(null);
    setPerfError(null);
    setBaselineResult(null);
    setComparisonResult(null);
    analyzedRunRef.current = null;
    setApplyFixError(null);
    setFixApplied(false);
    try {
      const result = await generateLoadScript(
        repositoryId,
        Number(routeIndex),
        description.trim(),
      );
      setScript(result.script);
      setAuthRequired(result.authRequired);
      setScriptEditing(false);
    } catch (err) {
      setScriptError(
        err instanceof Error ? err.message : "Failed to generate script",
      );
    } finally {
      setScriptLoading(false);
    }
  };

  const handleRunScript = async () => {
    if (!repo || !script) return;
    setScriptError(null);
    setScriptRunning(true);
    setLoadResult(null);
    setHasEverRun(true);
    setTelemetry(null);
    setChartData([]);
    reset();
    setConsoleOpen(true);
    try {
      const result = await runLoadScript(
        repositoryId,
        script,
        authToken.trim() || undefined,
      );
      setLoadResult(result);
      const serviceName = repo.githubFullName.split("/")[1];
      pollTelemetry(result.windowStart, result.windowEnd, serviceName);
    } catch (err) {
      setScriptError(err instanceof Error ? err.message : "Load test failed");
    } finally {
      setScriptRunning(false);
    }
  };

  const handleRunAgain = async () => {
    if (!repo || !script) return;
    setComparisonLoading(true);
    try {
      const result = await runLoadScript(
        repositoryId,
        script,
        authToken.trim() || undefined,
      );
      setComparisonResult(result);
    } catch (err) {
      setScriptError(
        err instanceof Error ? err.message : "Benchmark run failed",
      );
    } finally {
      setComparisonLoading(false);
    }
  };

  // Kept for the "apply the winning diff and retest" flow — not yet
  // wired to a button in this pass (strategies each carry their own
  // diff now; this will plug into "apply winner from leaderboard" next).
  const handleApplyFix = async () => {
    if (!repo || !script || !perfReport?.diff) return;
    setApplyFixLoading(true);
    setApplyFixError(null);
    reset();
    setConsoleOpen(true);
    setTelemetry(null);
    setChartData([]);
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    try {
      const result = await applyFixAndRetest(
        repositoryId,
        Number(routeIndex),
        perfReport.diff.filePath,
        perfReport.diff.originalCode,
        perfReport.diff.newCode,
        script,
        authToken.trim() || undefined,
      );
      if (!result.applied || !result.runResult) {
        setApplyFixError(result.error ?? "Failed to apply fix");
        return;
      }
      setComparisonResult(result.runResult);
      setFixApplied(true);
      const serviceName = repo.githubFullName.split("/")[1];
      pollTelemetry(
        result.runResult.windowStart,
        result.runResult.windowEnd,
        serviceName,
      );
    } catch (err: any) {
      setApplyFixError(
        err?.response?.data?.error ??
          (err instanceof Error ? err.message : "Failed to apply fix"),
      );
    } finally {
      setApplyFixLoading(false);
    }
  };
  void handleApplyFix;

  const isBusy =
    progress?.status === "starting" || progress?.status === "running";
  const isLivePolling = !!pollRef.current;

  const filesByRole = useMemo(() => {
    if (!connected) return {};
    const map: Partial<Record<ConnectedFile["role"], ConnectedFile>> = {};
    for (const f of connected.files) if (!map[f.role]) map[f.role] = f;
    return map;
  }, [connected]);
  void filesByRole;

  const consoleHeight = consoleExpanded
    ? CONSOLE_HEIGHT_WIDE
    : CONSOLE_HEIGHT_NARROW;

  const stageStatuses: Record<StageKey, StageStatus> = {
    script: scriptLoading ? "active" : script ? "done" : "pending",
    run: scriptRunning ? "active" : loadResult ? "done" : "pending",
    analyze: perfLoading ? "active" : perfReport ? "done" : "pending",
  };

  if (!repo || !route) {
    return (
      <div
        className="flex h-screen items-center justify-center text-[13px]"
        style={{ fontFamily: SANS, background: BG, color: TEXT_TERTIARY }}
      >
        <Loader2 size={14} className="mr-2 animate-spin" />
        Loading endpoint…
      </div>
    );
  }

  return (
    <div
      className="flex h-[100dvh] flex-col overflow-hidden"
      style={{ fontFamily: SANS, background: BG }}
    >
      {/* ======================================================= */}
      {/* Top bar — endpoint identity + status, full width, always  */}
      {/* visible. Everything needed to orient in one row.          */}
      {/* ======================================================= */}
      <header
        className="flex shrink-0 items-center justify-between gap-4 border-b px-6 py-3.5 lg:px-9"
        style={{ borderColor: BORDER, background: BG }}
      >
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="rounded-md px-2 py-1 text-[11px] font-bold"
            style={{
              background: TEXT_PRIMARY,
              color: "#fff",
              fontFamily: MONO,
            }}
          >
            {route.method}
          </span>
          <h1
            className="truncate text-[14.5px] font-semibold"
            style={{ color: TEXT_PRIMARY, fontFamily: MONO }}
          >
            {route.routePath}
          </h1>
          <span
            className="hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold sm:flex"
            style={{
              borderColor: isBusy || isLivePolling ? ACCENT : BORDER_STRONG,
              background: isBusy || isLivePolling ? ACCENT_SOFT : "transparent",
              color: isBusy || isLivePolling ? ACCENT_TEXT : TEXT_TERTIARY,
            }}
          >
            <Radio size={11} />
            {isBusy ? "Sending traffic" : isLivePolling ? "Live" : "Idle"}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-4">
          <div className="hidden md:block">
            <Stepper statuses={stageStatuses} />
          </div>
          <span
            className="hidden h-5 w-px md:block"
            style={{ background: BORDER_STRONG }}
          />
          <button
            onClick={() => setConsoleOpen((v) => !v)}
            className="flex items-center gap-2 rounded-lg border px-3 py-2 text-[12.5px] font-medium transition-colors"
            style={{
              borderColor: consoleOpen ? TEXT_PRIMARY : BORDER_STRONG,
              color: consoleOpen ? TEXT_PRIMARY : TEXT_TERTIARY,
              background: consoleOpen ? SURFACE_RAISED : "transparent",
            }}
          >
            <Terminal size={13} />
            <span className="hidden sm:inline">Console</span>
            {entries.length > 0 && (
              <span
                className="rounded-full px-1.5 py-0.5 text-[10px] font-bold"
                style={{ background: ACCENT, color: ACCENT_TEXT }}
              >
                {entries.length}
              </span>
            )}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* ======================================================= */}
        {/* Context rail — compact reference cards instead of loose   */}
        {/* floating text. Each section is visually contained so the  */}
        {/* rail reads as a panel, not a leftover margin.              */}
        {/* ======================================================= */}
        <aside
          className="hidden shrink-0 flex-col gap-5 overflow-y-auto border-r px-4 py-5 lg:flex"
          style={{
            width: SIDEBAR_WIDTH,
            borderColor: BORDER,
            background: SURFACE,
          }}
        >
          <div
            className="rounded-xl border px-4 py-3.5"
            style={{ borderColor: BORDER, background: BG }}
          >
            <SectionLabel icon={Info}>What this does</SectionLabel>
            {explanationLoading ? (
              <div className="space-y-2">
                <div
                  className="h-2.5 w-[92%] animate-pulse rounded"
                  style={{ background: SURFACE_RAISED }}
                />
                <div
                  className="h-2.5 w-[76%] animate-pulse rounded"
                  style={{ background: SURFACE_RAISED }}
                />
                <div
                  className="h-2.5 w-[54%] animate-pulse rounded"
                  style={{ background: SURFACE_RAISED }}
                />
              </div>
            ) : (
              <>
                <p
                  className={`text-[12.5px] leading-[1.6] ${
                    explanationExpanded ? "" : "line-clamp-5"
                  }`}
                  style={{ color: TEXT_SECONDARY }}
                >
                  {explanation ?? "No explanation available yet."}
                </p>
                {explanation && explanation.length > 220 && (
                  <button
                    onClick={() => setExplanationExpanded((v) => !v)}
                    className="mt-2 text-[11.5px] font-semibold"
                    style={{ color: ACCENT_TEXT }}
                  >
                    {explanationExpanded ? "Show less" : "Read more"}
                  </button>
                )}
              </>
            )}
          </div>

          {connected && connected.files.length > 0 && (
            <div
              className="rounded-xl border px-4 py-3.5"
              style={{ borderColor: BORDER, background: BG }}
            >
              <SectionLabel icon={Workflow}>Call chain</SectionLabel>
              <nav className="flex flex-col gap-1.5">
                {connected.files.map((f, i) => {
                  const meta = ROLE_META[f.role];
                  const Icon = meta.icon;
                  return (
                    <button
                      key={f.path}
                      onClick={() => {
                        setActiveFile(f);
                        setSourceOpen(true);
                      }}
                      className="group flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] transition-colors"
                      style={{ color: TEXT_SECONDARY }}
                      onMouseEnter={(e) =>
                        (e.currentTarget.style.background = SURFACE_RAISED)
                      }
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.background = "transparent")
                      }
                    >
                      <span
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[10px] font-bold"
                        style={{
                          background: SURFACE_RAISED,
                          color: TEXT_QUIET,
                        }}
                      >
                        {i + 1}
                      </span>
                      <Icon
                        size={12.5}
                        className="shrink-0"
                        style={{ color: TEXT_TERTIARY }}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        <span
                          className="mr-1.5 text-[10.5px] font-medium uppercase tracking-[0.04em]"
                          style={{ color: TEXT_QUIET }}
                        >
                          {meta.label}
                        </span>
                        <span style={{ fontFamily: MONO, fontSize: 11.5 }}>
                          {f.path.split("/").pop()}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </nav>
            </div>
          )}
        </aside>

        {/* ======================================================= */}
        {/* Workspace — full width up to a generous cap, composer as  */}
        {/* the hero, then script + run/telemetry side by side so     */}
        {/* cause and effect sit next to each other like gauges on an  */}
        {/* instrument panel, with analysis running the full width     */}
        {/* below since it can grow long.                              */}
        {/* ======================================================= */}
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-7 lg:px-10 xl:px-14">
            <div
              className="mx-auto flex w-full flex-col gap-6"
              style={{ maxWidth: CONTENT_MAX_WIDTH }}
            >
              {/* Composer — the hero of the page. Full width, first    */}
              {/* thing in the scroll, marked with the yellow signal    */}
              {/* accent since it's the primary control here.           */}
              <Panel accent className="px-6 py-5">
                <div className="mb-3 flex items-center gap-2">
                  <Wand2 size={15} style={{ color: ACCENT_TEXT }} />
                  <span
                    className="text-[13px] font-semibold"
                    style={{ color: TEXT_PRIMARY }}
                  >
                    Describe a load-test scenario
                  </span>
                </div>
                <textarea
                  ref={textareaRef}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. 100 concurrent users checking out with random products for 30 seconds."
                  rows={2}
                  disabled={scriptLoading}
                  className="min-h-[52px] w-full resize-none bg-transparent py-1 text-[14.5px] leading-[1.55] outline-none"
                  style={{ color: TEXT_PRIMARY, fontFamily: SANS }}
                />
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  {authRequired ? (
                    <div
                      className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5"
                      style={{
                        borderColor: BORDER_STRONG,
                        background: SURFACE,
                      }}
                    >
                      <KeyRound
                        size={12}
                        className="shrink-0"
                        style={{ color: TEXT_TERTIARY }}
                      />
                      <input
                        type="password"
                        value={authToken}
                        onChange={(e) => setAuthToken(e.target.value)}
                        placeholder="Bearer token"
                        className="w-[140px] bg-transparent text-[11.5px] outline-none"
                        style={{ fontFamily: MONO, color: TEXT_PRIMARY }}
                      />
                    </div>
                  ) : (
                    <span />
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleGenerateScript}
                      disabled={scriptLoading || !description.trim()}
                      className="flex items-center justify-center gap-1.5 rounded-lg border px-3.5 py-2 text-[12.5px] font-semibold transition-colors disabled:opacity-30"
                      style={{
                        borderColor: BORDER_STRONG,
                        color: TEXT_SECONDARY,
                        background: "#fff",
                      }}
                    >
                      {scriptLoading ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <Sparkles size={13} />
                      )}
                      {scriptLoading ? "Generating" : "Generate"}
                    </button>
                  </div>
                </div>
              </Panel>
              <Panel>
                <PanelHeader
                  icon={Cpu}
                  title="Container health"
                  action={
                    metricsConnected ? (
                      <span
                        className="flex items-center gap-1.5 text-[11px] font-semibold"
                        style={{ color: ACCENT_TEXT }}
                      >
                        <span
                          className="h-1.5 w-1.5 animate-pulse rounded-full"
                          style={{ background: ACCENT }}
                        />
                        Live
                      </span>
                    ) : undefined
                  }
                />
                <div className="px-5 py-4">
                  {!metricsConnected || !latestMetrics ? (
                    <p className="text-[13px]" style={{ color: TEXT_TERTIARY }}>
                      No active container for this repo yet — start a run to see
                      live CPU, memory, and request-rate metrics here.
                    </p>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
                        <StatBlock
                          label="CPU"
                          value={`${latestMetrics.cpuPercent.toFixed(1)}%`}
                          alert={latestMetrics.cpuPercent > 90}
                        />
                        <StatBlock
                          label="Memory"
                          value={`${latestMetrics.memoryMB.toFixed(0)} MB`}
                        />
                        <StatBlock
                          label="Req/sec"
                          value={latestMetrics.requestRate.toFixed(1)}
                        />
                        <StatBlock
                          label="Error rate"
                          value={`${(latestMetrics.errorRate * 100).toFixed(1)}%`}
                          alert={latestMetrics.errorRate > 0.05}
                        />
                      </div>
                      {metricsHistory.length > 1 && (
                        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
                          <div>
                            <div
                              className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em]"
                              style={{ color: TEXT_TERTIARY }}
                            >
                              <Cpu size={11} /> CPU %
                            </div>
                            <ResponsiveContainer width="100%" height={140}>
                              <LineChart data={metricsHistory}>
                                <CartesianGrid
                                  stroke={BORDER}
                                  vertical={false}
                                />
                                <XAxis
                                  dataKey="timestamp"
                                  tickFormatter={(t) =>
                                    new Date(t).toLocaleTimeString([], {
                                      minute: "2-digit",
                                      second: "2-digit",
                                    })
                                  }
                                  stroke={TEXT_QUIET}
                                  fontSize={10}
                                />
                                <YAxis stroke={TEXT_QUIET} fontSize={10} />
                                <Tooltip
                                  contentStyle={{
                                    background: "#fff",
                                    border: `1px solid ${BORDER_STRONG}`,
                                    borderRadius: 8,
                                    fontSize: 11.5,
                                  }}
                                  labelFormatter={(t) =>
                                    new Date(t as number).toLocaleTimeString()
                                  }
                                />
                                <Line
                                  type="monotone"
                                  dataKey="cpuPercent"
                                  stroke={ACCENT_HOVER}
                                  dot={false}
                                  strokeWidth={2}
                                />
                              </LineChart>
                            </ResponsiveContainer>
                          </div>
                          <div>
                            <div
                              className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em]"
                              style={{ color: TEXT_TERTIARY }}
                            >
                              <MemoryStick size={11} /> Memory (MB)
                            </div>
                            <ResponsiveContainer width="100%" height={140}>
                              <LineChart data={metricsHistory}>
                                <CartesianGrid
                                  stroke={BORDER}
                                  vertical={false}
                                />
                                <XAxis
                                  dataKey="timestamp"
                                  tickFormatter={(t) =>
                                    new Date(t).toLocaleTimeString([], {
                                      minute: "2-digit",
                                      second: "2-digit",
                                    })
                                  }
                                  stroke={TEXT_QUIET}
                                  fontSize={10}
                                />
                                <YAxis stroke={TEXT_QUIET} fontSize={10} />
                                <Tooltip
                                  contentStyle={{
                                    background: "#fff",
                                    border: `1px solid ${BORDER_STRONG}`,
                                    borderRadius: 8,
                                    fontSize: 11.5,
                                  }}
                                  labelFormatter={(t) =>
                                    new Date(t as number).toLocaleTimeString()
                                  }
                                />
                                <Line
                                  type="monotone"
                                  dataKey="memoryMB"
                                  stroke={TEXT_TERTIARY}
                                  dot={false}
                                  strokeWidth={2}
                                />
                              </LineChart>
                            </ResponsiveContainer>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </Panel>
              {!script && !scriptError ? (
                <div
                  className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed py-24 text-center"
                  style={{ borderColor: BORDER_STRONG, background: SURFACE }}
                >
                  <BarChart3 size={20} style={{ color: TEXT_QUIET }} />
                  <p
                    className="max-w-sm text-[13.5px]"
                    style={{ color: TEXT_TERTIARY }}
                  >
                    Generate a script above to kick things off — the run
                    results, live telemetry, and optimization strategies will
                    appear here in order.
                  </p>
                </div>
              ) : (
                <>
                  {/* Script + Run/Telemetry side by side on wide       */}
                  {/* screens — cause and effect next to each other,    */}
                  {/* instead of stacked under a narrow centered column. */}
                  <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
                    {/* Panel — generated script */}
                    <Panel className="xl:col-span-2">
                      <PanelHeader
                        icon={Code2}
                        title="Script"
                        action={
                          script && (
                            <div className="flex items-center gap-3">
                              <button
                                onClick={() => setScriptEditing((e) => !e)}
                                className="rounded-md px-1.5 py-0.5 text-[11.5px] font-medium"
                                style={{ color: TEXT_SECONDARY }}
                              >
                                {scriptEditing ? "Done" : "Edit"}
                              </button>
                              <button
                                onClick={handleRunScript}
                                disabled={scriptRunning || !script}
                                className="flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[12px] font-bold transition-colors disabled:opacity-30"
                                style={{
                                  background: ACCENT,
                                  color: TEXT_PRIMARY,
                                }}
                                onMouseEnter={(e) => {
                                  if (!scriptRunning && script)
                                    e.currentTarget.style.background =
                                      ACCENT_HOVER;
                                }}
                                onMouseLeave={(e) =>
                                  (e.currentTarget.style.background = ACCENT)
                                }
                              >
                                {scriptRunning ? (
                                  <Loader2 size={13} className="animate-spin" />
                                ) : (
                                  <Play size={13} />
                                )}
                                {scriptRunning ? "Running" : "Run"}
                              </button>
                            </div>
                          )
                        }
                      />
                      <div className="px-5 py-4">
                        {scriptError && !script && (
                          <ErrorChip icon={X}>{scriptError}</ErrorChip>
                        )}
                        {script && (
                          <div
                            className="max-h-[70vh] overflow-y-auto rounded-xl border"
                            style={{
                              borderColor: BORDER,
                              background: "#FDFCF9",
                            }}
                          >
                            {scriptEditing ? (
                              <textarea
                                value={script}
                                onChange={(e) => setScript(e.target.value)}
                                spellCheck={false}
                                className="w-full resize-none bg-transparent px-3.5 py-3 text-[12.5px] leading-[1.7] outline-none"
                                style={{
                                  fontFamily: MONO,
                                  color: TEXT_SECONDARY,
                                  minHeight: 240,
                                }}
                              />
                            ) : (
                              <div className="overflow-x-auto px-2.5">
                                <CodeBlock code={script} filePath="script.js" />
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </Panel>

                    {/* Panel — run + live telemetry */}
                    <Panel className="xl:col-span-3">
                      <PanelHeader title="Run & live telemetry" />
                      <div className="px-5 py-4">
                        {scriptError &&
                          loadResult === null &&
                          !scriptRunning &&
                          script && (
                            <div className="mb-4">
                              <ErrorChip icon={X}>{scriptError}</ErrorChip>
                            </div>
                          )}

                        {scriptRunning && !loadResult && (
                          <p
                            className="text-[13px]"
                            style={{ color: TEXT_SECONDARY }}
                          >
                            Sending traffic and collecting results — live output
                            is in the console.
                          </p>
                        )}

                        {progress && progress.status !== "done" && (
                          <p
                            className="mb-3 text-[11.5px]"
                            style={{ color: TEXT_TERTIARY }}
                          >
                            {progress.status === "starting"
                              ? "Starting k6…"
                              : `${progress.sent} requests sent so far…`}
                          </p>
                        )}

                        {loadResult && (
                          <div className="mb-6 grid grid-cols-3 gap-2.5">
                            <StatBlock
                              label="Total"
                              value={loadResult.requestsSent}
                            />
                            <StatBlock
                              label="Errors"
                              value={`${(loadResult.errorRate * 100).toFixed(1)}%`}
                              alert={loadResult.errorRate > 0.01}
                            />
                            <StatBlock
                              label="Avg"
                              value={`${Math.round(loadResult.avgDurationMs)}ms`}
                            />
                            <StatBlock
                              label="p95"
                              value={
                                loadResult.p95DurationMs !== null
                                  ? `${Math.round(loadResult.p95DurationMs)}ms`
                                  : "—"
                              }
                            />
                            <StatBlock
                              label="p99"
                              value={
                                loadResult.p99DurationMs !== null
                                  ? `${Math.round(loadResult.p99DurationMs)}ms`
                                  : "—"
                              }
                            />
                            <StatBlock
                              label="Req/sec"
                              value={
                                loadResult.requestsPerSecond !== null
                                  ? loadResult.requestsPerSecond.toFixed(1)
                                  : "—"
                              }
                            />
                          </div>
                        )}

                        {loadResult && loadResult.thresholdsPassed !== null && (
                          <div className="mb-6">
                            {loadResult.thresholdsPassed ? (
                              <span
                                className="flex w-fit items-center gap-1.5 rounded-lg border px-3.5 py-2 text-[12.5px] font-medium"
                                style={{
                                  borderColor: LIVE,
                                  color: LIVE,
                                  background: LIVE_SOFT,
                                }}
                              >
                                <Check size={13} /> All thresholds passed
                              </span>
                            ) : (
                              <ErrorChip icon={X}>
                                One or more thresholds failed
                              </ErrorChip>
                            )}
                          </div>
                        )}

                        {(telemetry || isLivePolling) && (
                          <div>
                            <SectionLabel
                              icon={BarChart3}
                              action={
                                isLivePolling ? (
                                  <span
                                    className="flex items-center gap-1.5 text-[11px] font-semibold"
                                    style={{ color: ACCENT_TEXT }}
                                  >
                                    <span
                                      className="h-1.5 w-1.5 animate-pulse rounded-full"
                                      style={{ background: ACCENT }}
                                    />
                                    Live
                                  </span>
                                ) : undefined
                              }
                            >
                              Telemetry
                            </SectionLabel>

                            {telemetry ? (
                              <>
                                <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
                                  <StatBlock
                                    label="Requests"
                                    value={telemetry.requestCount}
                                  />
                                  <StatBlock
                                    label="Error rate"
                                    value={`${telemetry.errorRatePercent}%`}
                                    alert={telemetry.errorRatePercent > 2}
                                  />
                                  <StatBlock
                                    label="p50"
                                    value={`${telemetry.latencyMs.p50} ms`}
                                  />
                                  <StatBlock
                                    label="p95"
                                    value={`${telemetry.latencyMs.p95} ms`}
                                  />
                                </div>
                                {chartData.length > 1 && (
                                  <div className="mt-4">
                                    <ResponsiveContainer
                                      width="100%"
                                      height={200}
                                    >
                                      <LineChart data={chartData}>
                                        <CartesianGrid
                                          stroke={BORDER}
                                          vertical={false}
                                        />
                                        <XAxis
                                          dataKey="time"
                                          stroke={TEXT_QUIET}
                                          fontSize={10}
                                        />
                                        <YAxis
                                          stroke={TEXT_QUIET}
                                          fontSize={10}
                                        />
                                        <Tooltip
                                          contentStyle={{
                                            background: "#fff",
                                            border: `1px solid ${BORDER_STRONG}`,
                                            borderRadius: 8,
                                            fontSize: 11.5,
                                          }}
                                          labelStyle={{ color: TEXT_PRIMARY }}
                                        />
                                        <Line
                                          type="monotone"
                                          dataKey="p50"
                                          stroke={TEXT_TERTIARY}
                                          dot={false}
                                          strokeWidth={1.5}
                                        />
                                        <Line
                                          type="monotone"
                                          dataKey="p95"
                                          stroke={ACCENT_HOVER}
                                          dot={false}
                                          strokeWidth={2}
                                        />
                                      </LineChart>
                                    </ResponsiveContainer>
                                  </div>
                                )}
                                {telemetry.requestCount === 0 && (
                                  <p
                                    className="mt-4 rounded-lg border px-3 py-2 text-[11.5px] font-medium"
                                    style={{
                                      borderColor: BORDER_STRONG,
                                      color: TEXT_SECONDARY,
                                    }}
                                  >
                                    No spans matched yet — still polling.
                                  </p>
                                )}
                              </>
                            ) : (
                              <p
                                className="text-[13px]"
                                style={{ color: TEXT_TERTIARY }}
                              >
                                Run traffic to see live numbers here.
                              </p>
                            )}
                          </div>
                        )}

                        {!loadResult &&
                          !scriptRunning &&
                          !scriptError &&
                          script && (
                            <p
                              className="text-[13px]"
                              style={{ color: TEXT_TERTIARY }}
                            >
                              Hit Run above to send traffic against this route.
                            </p>
                          )}
                      </div>
                    </Panel>
                  </div>

                  {/* Panel — root cause + strategy leaderboard.
                      Gated on `hasEverRun`, NOT on `loadResult` — loadResult
                      is deliberately nulled at the start of every new run,
                      and gating this panel on it would unmount
                      PerformanceReportFull (and any open Optimization
                      Arena inside it) every time a fresh run kicks off.
                      Full width: this panel can grow long (evidence lists,
                      strategy leaderboard) and deserves the room. */}
                  <Panel>
                    <PanelHeader title="Analysis & optimization" />
                    <div className="px-5 py-4">
                      {!hasEverRun ? (
                        <p
                          className="text-[13px]"
                          style={{ color: TEXT_TERTIARY }}
                        >
                          Finishes automatically once a run completes and
                          telemetry catches up.
                        </p>
                      ) : (
                        <PerformanceReportFull
                          repositoryId={repositoryId}
                          routeIndex={Number(routeIndex)}
                          routeLabel={`${route.method} ${route.routePath}`}
                          script={script ?? ""}
                          authToken={authToken.trim() || undefined}
                          loadResult={loadResult}
                          report={perfReport}
                          perfLoading={perfLoading}
                          perfError={perfError}
                          telemetry={telemetry}
                          baseline={baselineResult}
                          comparison={comparisonResult}
                          comparisonLoading={comparisonLoading}
                          onRunAgain={handleRunAgain}
                        />
                      )}
                    </div>
                  </Panel>
                </>
              )}
            </div>
          </div>

          {/* ======================================================= */}
          {/* Console — a bottom drawer over the workspace, brought     */}
          {/* back into the white/cream family (mono readout on a       */}
          {/* light sunken surface) instead of a black terminal that    */}
          {/* broke the theme.                                          */}
          {/* ======================================================= */}
          {consoleOpen && (
            <div
              className="hidden shrink-0 flex-col overflow-hidden border-t md:flex"
              style={{
                height: consoleHeight,
                borderColor: BORDER,
                background: BG,
                transition: "height 160ms ease",
              }}
            >
              <div
                className="flex items-center justify-between border-b px-4 py-2"
                style={{ borderColor: BORDER, background: SURFACE }}
              >
                <span
                  className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em]"
                  style={{ color: TEXT_TERTIARY }}
                >
                  <Terminal size={12} /> Console
                </span>
                <button
                  onClick={() => setConsoleExpanded((v) => !v)}
                  className="rounded p-1"
                  style={{ color: TEXT_TERTIARY }}
                >
                  {consoleExpanded ? (
                    <ChevronDown size={13} />
                  ) : (
                    <ChevronUp size={13} />
                  )}
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <ExecutionConsole
                  entries={entries}
                  progress={progress}
                  expanded={consoleExpanded}
                  onToggleExpand={() => setConsoleExpanded((v) => !v)}
                  onClear={reset}
                  onClose={() => setConsoleOpen(false)}
                />
              </div>
            </div>
          )}
        </main>
      </div>

      <SourceOverlay
        open={sourceOpen}
        onClose={() => setSourceOpen(false)}
        connected={connected}
        activeFile={activeFile}
        onSelectFile={setActiveFile}
      />
    </div>
  );
}
