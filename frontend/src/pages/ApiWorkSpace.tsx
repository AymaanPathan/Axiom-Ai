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
  RefreshCw,
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
import ExecutionConsole from "../components/ExecutionConsole";
import {
  analyzePerformance,
  applyFixAndRetest,
  type PerformanceReport,
} from "../api/repos";// ---------------------------------------------------------------------------
import PerformanceReportFull from "../components/PerformanceReportFull";
// Design tokens
// ---------------------------------------------------------------------------
const MONO = "'Berkeley Mono', ui-monospace, monospace";
const SANS = "'Inter', ui-sans-serif, system-ui, sans-serif";

const BG = "#0a0a0a";
const SURFACE = "#111111";
const BORDER = "#1e1e1e";
const BORDER_STRONG = "#2e2e2e";
const BORDER_HOVER = "#454545";
const TEXT_PRIMARY = "#f5f5f5";
const TEXT_SECONDARY = "#b3b3b3";
const TEXT_TERTIARY = "#6e6e6e";
const TEXT_QUIET = "#4a4a4a";

const CONTENT_WIDTH = "max-w-[1240px]";

const CONSOLE_WIDTH_NARROW = 400;
const CONSOLE_WIDTH_WIDE = 720;

const TELEMETRY_POLL_MS = 2000;
const TELEMETRY_POLL_DURATION_MS = 20_000;
const MAX_CHART_POINTS = 30;

// Height of the docked composer row (px + py). Content gets this much
// bottom padding so nothing hides behind the sticky composer.
const COMPOSER_HEIGHT = 76;

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

// "results" -> split into "script" (generated code) and "report" (run
// stats + live telemetry). Report tab only renders when there's a report.
type TabKey = "overview" | "source" | "script" | "report";

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------
function Eyebrow({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <span
        className="text-[11px] font-semibold uppercase tracking-[0.08em]"
        style={{ color: TEXT_TERTIARY }}
      >
        {children}
      </span>
      {action}
    </div>
  );
}

function CodeBlock({
  code,
  filePath,
  startLine = 1,
  highlightLine,
}: {
  code: string;
  filePath: string;
  startLine?: number;
  highlightLine?: number;
}) {
  return (
    <Highlight
      code={code}
      language={languageFor(filePath)}
      theme={themes.vsDark}
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
            height: "100%",
          }}
        >
          {tokens.map((line, i) => {
            const lineNumber = startLine + i;
            const isTarget = highlightLine === lineNumber;
            return (
              <div
                key={i}
                {...getLineProps({ line })}
                style={{
                  display: "flex",
                  background: isTarget ? "#ffffff0d" : "transparent",
                  borderLeft: isTarget
                    ? "2px solid #ffffff"
                    : "2px solid transparent",
                }}
              >
                <span
                  style={{
                    width: 48,
                    flexShrink: 0,
                    textAlign: "right",
                    paddingRight: 16,
                    color: TEXT_QUIET,
                    userSelect: "none",
                  }}
                >
                  {lineNumber}
                </span>
                <span style={{ flex: 1, whiteSpace: "pre", paddingRight: 20 }}>
                  {line.map((token, key) => (
                    <span key={key} {...getTokenProps({ token })} />
                  ))}
                </span>
              </div>
            );
          })}
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
      className="rounded-lg border px-3.5 py-3 transition-colors"
      style={{ borderColor: BORDER_STRONG, background: SURFACE }}
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
        {alert && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
      </div>
    </div>
  );
}

function InvertChip({
  icon: Icon,
  children,
}: {
  icon: typeof Check;
  children: React.ReactNode;
}) {
  return (
    <span className="flex items-center gap-1.5 rounded-lg bg-white px-3.5 py-2 text-[12.5px] font-semibold text-black">
      <Icon size={13} />
      {children}
    </span>
  );
}

function OutlineChip({
  icon: Icon,
  children,
}: {
  icon: typeof Check;
  children: React.ReactNode;
}) {
  return (
    <span
      className="flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-[12.5px] font-medium"
      style={{ borderColor: BORDER_STRONG, color: TEXT_SECONDARY }}
    >
      <Icon size={13} />
      {children}
    </span>
  );
}

function TabButton({
  active,
  onClick,
  children,
  dot,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  dot?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="relative flex items-center gap-1.5 border-b-2 px-1 pb-3 text-[13px] font-medium transition-colors"
      style={{
        borderColor: active ? "#ffffff" : "transparent",
        color: active ? TEXT_PRIMARY : TEXT_TERTIARY,
      }}
    >
      {children}
      {dot && !active && (
        <span className="absolute -right-2 top-0 h-1.5 w-1.5 rounded-full bg-white" />
      )}
    </button>
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

  const [tab, setTab] = useState<TabKey>("overview");
  const [reportUnseen, setReportUnseen] = useState(false);

  // --- endpoint context ---
  const [explanation, setExplanation] = useState<string | null>(null);
  const [explanationLoading, setExplanationLoading] = useState(false);
  const [connected, setConnected] = useState<ConnectedFilesResult | null>(null);
  const [activeFile, setActiveFile] = useState<ConnectedFile | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [authToken, setAuthToken] = useState("");

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
  // --- execution console visibility (only opens when a run starts) ---
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleExpanded, setConsoleExpanded] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);


  const reportAvailable = !!(
    loadResult ||
    telemetry ||
    scriptRunning ||
    pollRef.current
  );

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

  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!loadResult || !telemetry) return;
    if (analyzedRunRef.current === loadResult) return; // already analyzed this run

    // Wait for a telemetry tick whose window fully covers the completed
    // run — the first tick after loadResult lands is often a partial
    // window (SigNoz hasn't ingested the tail-end spans yet, or the
    // window's `end` predates loadResult.windowEnd), which skews
    // avg/cumulative DB numbers and can make sequential calls look like
    // they "overlap" the request when they don't.
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
  // clear the "unseen report" dot once the user actually looks at the tab
  useEffect(() => {
    if (tab === "report") setReportUnseen(false);
  }, [tab]);

  // auto-grow the composer textarea (starts at one line, caps at ~4 lines)
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
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
      setTab("script");
    } catch (err) {
      setScriptError(
        err instanceof Error ? err.message : "Failed to generate script",
      );
      setTab("script");
    } finally {
      setScriptLoading(false);
    }
  };

  const handleRunScript = async () => {
    if (!repo || !script) return;
    setScriptError(null);
    setScriptRunning(true);
    setLoadResult(null);
    setTelemetry(null);
    setChartData([]);
    reset();
    setConsoleOpen(true);
    setTab("report");
    setReportUnseen(false);
    try {
      const result = await runLoadScript(
        repositoryId,
        script,
        authToken.trim() || undefined,
      );
      setLoadResult(result);
      setReportUnseen(tab !== "report");
      const serviceName = repo.githubFullName.split("/")[1];
      pollTelemetry(result.windowStart, result.windowEnd, serviceName);
    } catch (err) {
      setScriptError(err instanceof Error ? err.message : "Load test failed");
      setReportUnseen(tab !== "report");
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


  const handleApplyFix = async () => {
    if (!repo || !script || !perfReport?.diff) return;
    setApplyFixLoading(true);
    setApplyFixError(null);

    // Same treatment as a fresh run: clear the console and telemetry chart
    // so the retest's output isn't mixed in with the baseline run's, and
    // make sure the console panel is actually visible to show it live.
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

      // Restart live polling against the NEW run's window, same as a
      // normal run — a single one-shot telemetry snapshot (result.telemetry)
      // undersells what actually happened, since the run already streamed
      // per-request logs into the console via the socket while it executed.
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

  const consoleWidth = consoleExpanded
    ? CONSOLE_WIDTH_WIDE
    : CONSOLE_WIDTH_NARROW;

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
    // Fixed-height, non-scrolling shell. `overflow-hidden` here is the key
    // fix: without it, anything inside that overflows drags the *whole
    // page* into scroll (composer included). Only the content region below
    // scrolls; header, tabs, and the composer stay pinned in the viewport.
    // h-[100dvh] instead of h-screen so mobile browser chrome doesn't clip it.
    <div
      className="flex h-[100dvh] flex-col overflow-hidden"
      style={{
        fontFamily: SANS,
        background: BG,
        marginRight: consoleOpen ? consoleWidth : 0,
        transition: "margin-right 160ms ease",
      }}
    >
      {/* --------------------------------------------------------- */}
      {/* Header                                                     */}
      {/* --------------------------------------------------------- */}
      <header className={`mx-auto w-full ${CONTENT_WIDTH} shrink-0 px-8 pt-6`}>
        <div className="flex flex-wrap items-center gap-3">
          <span
            className="ml-auto flex items-center gap-2 text-[12px]"
            style={{ color: isLivePolling ? TEXT_PRIMARY : TEXT_QUIET }}
          >
            <Radio size={13} />
            {isBusy ? "Sending traffic" : isLivePolling ? "Live" : "Idle"}
          </span>
        </div>

        {/* --------------------------------------------------------- */}
        {/* Tabs                                                       */}
        {/* --------------------------------------------------------- */}
        <div
          className="flex items-center gap-6 border-b"
          style={{ borderColor: BORDER }}
        >
          <TabButton
            active={tab === "overview"}
            onClick={() => setTab("overview")}
          >
            Overview
          </TabButton>
          <TabButton active={tab === "source"} onClick={() => setTab("source")}>
            Source &amp; Schema
          </TabButton>
          <TabButton active={tab === "script"} onClick={() => setTab("script")}>
            Script
          </TabButton>
          {reportAvailable && (
            <TabButton
              active={tab === "report"}
              onClick={() => setTab("report")}
              dot={reportUnseen}
            >
              Report
            </TabButton>
          )}
        </div>
      </header>

      {/* --------------------------------------------------------- */}
      {/* Scrollable content region — the only part of the page that */}
      {/* scrolls; header, tabs, and composer stay fixed in place.   */}
      {/* --------------------------------------------------------- */}
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        style={{ paddingBottom: COMPOSER_HEIGHT }}
      >
        <div
          className={`mx-auto flex w-full ${CONTENT_WIDTH} flex-col px-8 py-6`}
        >
          {/* Overview tab */}
          {tab === "overview" && (
            <section className="grid grid-cols-1 gap-10 lg:grid-cols-[1fr_320px]">
              <div>
                <Eyebrow
                  action={
                    <button
                      onClick={() => {
                        setExplanationLoading(true);
                        getExplanation(repositoryId, route.file, route.line)
                          .then(setExplanation)
                          .finally(() => setExplanationLoading(false));
                      }}
                      className="flex items-center gap-1.5 text-[11.5px] font-medium transition-colors"
                      style={{ color: TEXT_TERTIARY }}
                    >
                      <RefreshCw
                        size={12}
                        className={explanationLoading ? "animate-spin" : ""}
                      />
                      Regenerate
                    </button>
                  }
                >
                  What this endpoint does
                </Eyebrow>
                {explanationLoading ? (
                  <div className="space-y-2.5">
                    <div className="h-3.5 w-[92%] animate-pulse rounded bg-[#161616]" />
                    <div className="h-3.5 w-[76%] animate-pulse rounded bg-[#161616]" />
                    <div className="h-3.5 w-[54%] animate-pulse rounded bg-[#161616]" />
                  </div>
                ) : (
                  <p
                    className="text-[14px] leading-[1.75]"
                    style={{ color: TEXT_SECONDARY }}
                  >
                    {explanation ?? "No explanation available yet."}
                  </p>
                )}
              </div>

              {connected && connected.files.length > 0 && (
                <div>
                  <Eyebrow>Call chain</Eyebrow>
                  <nav className="flex flex-col gap-2">
                    {connected.files.map((f) => {
                      const meta = ROLE_META[f.role];
                      const Icon = meta.icon;
                      return (
                        <button
                          key={f.path}
                          onClick={() => {
                            setActiveFile(f);
                            setTab("source");
                          }}
                          className="flex items-center gap-2 rounded-lg border px-3 py-2 text-[12.5px] transition-colors"
                          style={{ borderColor: BORDER, color: TEXT_TERTIARY }}
                        >
                          <Icon size={13} className="shrink-0" />
                          <span className="shrink-0">{meta.label}</span>
                          <span
                            className="truncate text-[11.5px] opacity-70"
                            style={{ fontFamily: MONO }}
                          >
                            {f.path.split("/").pop()}
                          </span>
                        </button>
                      );
                    })}
                  </nav>
                </div>
              )}
            </section>
          )}

          {/* Source & Schema tab */}
          {tab === "source" && (
            <section className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_280px]">
              <div>
                {connected && connected.files.length > 0 && (
                  <nav className="mb-4 flex flex-wrap items-center gap-2">
                    {connected.files.map((f) => {
                      const meta = ROLE_META[f.role];
                      const Icon = meta.icon;
                      const isActive = activeFile?.path === f.path;
                      return (
                        <button
                          key={f.path}
                          onClick={() => setActiveFile(f)}
                          className={
                            isActive
                              ? "flex items-center gap-2 rounded-lg bg-white px-3 py-1.5 text-[12.5px] font-semibold text-black"
                              : "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12.5px] transition-colors"
                          }
                          style={
                            isActive
                              ? undefined
                              : { borderColor: BORDER, color: TEXT_TERTIARY }
                          }
                        >
                          <Icon size={13} />
                          {meta.label}
                          <span
                            className="max-w-[150px] truncate text-[11.5px] opacity-70"
                            style={{ fontFamily: MONO }}
                          >
                            {f.path.split("/").pop()}
                          </span>
                        </button>
                      );
                    })}
                  </nav>
                )}

                <div
                  className="overflow-hidden rounded-xl border"
                  style={{ borderColor: BORDER, background: "#0d0d0d" }}
                >
                  <div
                    className="flex items-center justify-between border-b px-5 py-3"
                    style={{ borderColor: BORDER }}
                  >
                    <div
                      className="flex items-center gap-2.5 text-[13px]"
                      style={{ color: TEXT_SECONDARY }}
                    >
                      {activeFile && (
                        <>
                          {(() => {
                            const Icon = ROLE_META[activeFile.role].icon;
                            return (
                              <Icon
                                size={14}
                                style={{ color: TEXT_TERTIARY }}
                              />
                            );
                          })()}
                          <span style={{ fontFamily: MONO }}>
                            {activeFile.path}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="max-h-[55vh] overflow-auto px-3">
                    {activeFile ? (
                      <CodeBlock
                        code={activeFile.content}
                        filePath={activeFile.path}
                        startLine={activeFile.startLine}
                        highlightLine={activeFile.highlightLine}
                      />
                    ) : (
                      <p
                        className="px-4 py-8 text-[13px]"
                        style={{ color: TEXT_QUIET }}
                      >
                        {connected === null
                          ? "Loading source…"
                          : "No source available for this file."}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <div>
                <Eyebrow>Request body</Eyebrow>
                {connected?.requestBodyFields.length ? (
                  <div
                    className="overflow-hidden rounded-lg border"
                    style={{ borderColor: BORDER }}
                  >
                    {connected.requestBodyFields.map((f, i) => (
                      <div
                        key={f}
                        className="flex items-center justify-between px-3.5 py-2.5 text-[12.5px]"
                        style={{
                          borderTop: i > 0 ? `1px solid ${BORDER}` : undefined,
                        }}
                      >
                        <span style={{ fontFamily: MONO, color: TEXT_PRIMARY }}>
                          {f}
                        </span>
                        <span
                          className="rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.06em]"
                          style={{
                            borderColor: BORDER_STRONG,
                            color: TEXT_TERTIARY,
                          }}
                        >
                          field
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p
                    className="text-[12.5px] leading-[1.7]"
                    style={{ color: TEXT_QUIET }}
                  >
                    No{" "}
                    <code style={{ fontFamily: MONO, color: TEXT_SECONDARY }}>
                      req.body
                    </code>{" "}
                    usage found — this handler likely doesn't read a request
                    body (e.g. a GET/list route).
                  </p>
                )}
              </div>
            </section>
          )}

          {/* Script tab — the generated k6 code. Full width, fills the */}
          {/* available height instead of being capped/split in half.   */}
          {tab === "script" && (
            <section className="flex flex-1 flex-col">
              {!script && !scriptError && (
                <p className="text-[13px]" style={{ color: TEXT_QUIET }}>
                  Nothing here yet — describe a scenario below and hit Generate.
                </p>
              )}

              {scriptError && !script && (
                <div className="mb-6">
                  <InvertChip icon={X}>{scriptError}</InvertChip>
                </div>
              )}

              {script && (
                <div
                  className="flex min-h-[60vh] flex-1 flex-col overflow-hidden rounded-xl border text-left"
                  style={{ borderColor: BORDER, background: "#0d0d0d" }}
                >
                  <div
                    className="flex shrink-0 items-center justify-between border-b px-3.5 py-2.5"
                    style={{ borderColor: BORDER }}
                  >
                    <span
                      className="text-[11px] font-semibold uppercase tracking-[0.06em]"
                      style={{ color: TEXT_TERTIARY }}
                    >
                      Generated test · k6
                    </span>
                    <button
                      onClick={() => setScriptEditing((e) => !e)}
                      className="rounded-md px-1.5 py-0.5 text-[11.5px] font-medium transition-colors"
                      style={{ color: TEXT_SECONDARY }}
                    >
                      {scriptEditing ? "Done" : "Edit"}
                    </button>
                  </div>
                  {scriptEditing ? (
                    <textarea
                      value={script}
                      onChange={(e) => setScript(e.target.value)}
                      spellCheck={false}
                      className="w-full flex-1 resize-none bg-transparent px-3.5 py-3 text-[12.5px] leading-[1.7] outline-none"
                      style={{ fontFamily: MONO, color: TEXT_SECONDARY }}
                    />
                  ) : (
                    <div className="flex-1 overflow-auto px-2.5">
                      <CodeBlock code={script} filePath="script.js" />
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {/* Report tab — run stats + live telemetry. Only mounted when */}
          {/* there's actually a report to show (see reportAvailable).   */}
          {tab === "report" && reportAvailable && (
            <section>
              {scriptError && (
                <div className="mb-6">
                  <InvertChip icon={X}>{scriptError}</InvertChip>
                </div>
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
                <div className="mb-8">
                  <Eyebrow>Run results</Eyebrow>
                  <div className="grid grid-cols-3 gap-2.5">
                    <StatBlock label="Total" value={loadResult.requestsSent} />
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
                  {loadResult.thresholdsPassed !== null && (
                    <div className="mt-3">
                      {loadResult.thresholdsPassed ? (
                        <OutlineChip icon={Check}>
                          All thresholds passed
                        </OutlineChip>
                      ) : (
                        <InvertChip icon={X}>
                          One or more thresholds failed
                        </InvertChip>
                      )}
                    </div>
                  )}
                </div>
              )}

              {(telemetry || isLivePolling) && (
                <div>
                  <Eyebrow
                    action={
                      isLivePolling ? (
                        <span
                          className="flex items-center gap-1.5 text-[11.5px] font-semibold"
                          style={{ color: TEXT_PRIMARY }}
                        >
                          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                          Live
                        </span>
                      ) : undefined
                    }
                  >
                    Live telemetry
                  </Eyebrow>

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
                          <ResponsiveContainer width="100%" height={200}>
                            <LineChart data={chartData}>
                              <CartesianGrid stroke={BORDER} vertical={false} />
                              <XAxis
                                dataKey="time"
                                stroke={TEXT_QUIET}
                                fontSize={10}
                              />
                              <YAxis stroke={TEXT_QUIET} fontSize={10} />
                              <Tooltip
                                contentStyle={{
                                  background: SURFACE,
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
                                stroke="#ffffff"
                                dot={false}
                                strokeWidth={1.75}
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
                    <p className="text-[13px]" style={{ color: TEXT_QUIET }}>
                      Run traffic to see live numbers here.
                    </p>
                  )}
                </div>
              )}
              <PerformanceReportFull
                method={route.method}
                routePath={route.routePath}
                loadResult={loadResult}
                scriptRunning={scriptRunning}
                scriptError={scriptError}
                report={perfReport}
                perfLoading={perfLoading}
                perfError={perfError}
                telemetry={telemetry}
                baseline={baselineResult}
                comparison={comparisonResult}
                comparisonLoading={comparisonLoading}
                onRunAgain={handleRunAgain}
                onApplyFix={handleApplyFix}
                applyFixLoading={applyFixLoading}
                applyFixError={applyFixError}
                fixApplied={fixApplied}
              />
            </section>
          )}
        </div>
      </div>

      {/* --------------------------------------------------------- */}
      {/* Composer — sticky to the bottom of the viewport so it's    */}
      {/* always visible without scrolling, regardless of content    */}
      {/* height above it.                                            */}
      {/* --------------------------------------------------------- */}
      <div
        className="sticky bottom-0 z-10 shrink-0 border-t"
        style={{ borderColor: BORDER, background: BG }}
      >
        <div className={`mx-auto w-full ${CONTENT_WIDTH} px-8 py-3`}>
          <div
            className="flex w-full items-end gap-2 rounded-xl border px-3 py-2"
            style={{ borderColor: BORDER_STRONG, background: SURFACE }}
          >
            <textarea
              ref={textareaRef}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Simulate 100 concurrent users checking out with random products for 30 seconds."
              rows={1}
              disabled={scriptLoading}
              className="min-h-[22px] flex-1 resize-none bg-transparent py-1 text-[13px] leading-[1.5] outline-none"
              style={{ color: TEXT_PRIMARY, fontFamily: SANS }}
            />

            {authRequired && (
              <div
                className="flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5"
                style={{ borderColor: BORDER_STRONG }}
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
                  className="w-[130px] bg-transparent text-[11.5px] outline-none"
                  style={{ fontFamily: MONO, color: TEXT_PRIMARY }}
                />
              </div>
            )}

            <button
              onClick={handleGenerateScript}
              disabled={scriptLoading || !description.trim()}
              className="flex shrink-0 items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition-colors disabled:opacity-30"
              style={{ borderColor: BORDER_STRONG, color: TEXT_SECONDARY }}
            >
              {scriptLoading ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Generating
                </>
              ) : (
                <>
                  <Sparkles size={12} />
                  Generate
                </>
              )}
            </button>
            <button
              onClick={handleRunScript}
              disabled={scriptRunning || !script}
              className="flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-[12px] font-bold text-black transition-colors hover:bg-[#e5e5e5] disabled:opacity-30"
            >
              {scriptRunning ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Running
                </>
              ) : (
                <>
                  <Play size={12} />
                  Run
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {consoleOpen && (
        <ExecutionConsole
          entries={entries}
          progress={progress}
          expanded={consoleExpanded}
          onToggleExpand={() => setConsoleExpanded((v) => !v)}
          onClear={reset}
          onClose={() => setConsoleOpen(false)}
        />
      )}
    </div>
  );
}
