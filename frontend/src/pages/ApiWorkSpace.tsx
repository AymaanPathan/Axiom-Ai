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
  Braces,
  Radio,
  Copy,
  Check,
  X,
  Loader2,
  Activity,
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

// ---------------------------------------------------------------------------
// Design tokens — pure monochrome, Linear-style. No hue anywhere: state is
// carried by weight, border, and inversion (filled-white-on-black) instead
// of color. One layout column, centered, generous vertical rhythm.
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

const CONTENT_WIDTH = "max-w-[760px]";

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

// ---------------------------------------------------------------------------
// Section eyebrow — a small uppercase label, the only thing that plays the
// role three different colored icons used to play in the old layout.
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

// ---------------------------------------------------------------------------
// Syntax-highlighted code viewer
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------
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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11.5px] font-medium transition-colors"
      style={{ borderColor: BORDER_STRONG, color: TEXT_SECONDARY }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = BORDER_HOVER;
        e.currentTarget.style.color = TEXT_PRIMARY;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = BORDER_STRONG;
        e.currentTarget.style.color = TEXT_SECONDARY;
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? "Copied" : "Copy path"}
    </button>
  );
}

// An inverted (white-fill, black-text) chip is the one alert signal this
// page uses in place of color — reserved for "needs your attention now".
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

  // --- endpoint context: explanation + connected files + schema ---
  const [explanation, setExplanation] = useState<string | null>(null);
  const [explanationLoading, setExplanationLoading] = useState(false);
  const [connected, setConnected] = useState<ConnectedFilesResult | null>(null);
  const [activeFile, setActiveFile] = useState<ConnectedFile | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [authToken, setAuthToken] = useState("");
  // --- live telemetry (shared by any traffic-producing action) ---
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
    setTelemetry(null);
    setChartData([]);
    reset();
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

  const isBusy =
    progress?.status === "starting" || progress?.status === "running";
  const isLivePolling = !!pollRef.current;

  const filesByRole = useMemo(() => {
    if (!connected) return {};
    const map: Partial<Record<ConnectedFile["role"], ConnectedFile>> = {};
    for (const f of connected.files) if (!map[f.role]) map[f.role] = f;
    return map;
  }, [connected]);
  void filesByRole; // kept for parity with existing derived-state shape

  if (!repo || !route) {
    return (
      <div
        className="flex min-h-screen items-center justify-center text-[13px]"
        style={{ fontFamily: SANS, background: BG, color: TEXT_TERTIARY }}
      >
        <Loader2 size={14} className="mr-2 animate-spin" />
        Loading endpoint…
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ fontFamily: SANS, background: BG }}>
      <div className={`mx-auto ${CONTENT_WIDTH} px-6 pb-56 pt-16`}>
        {/* --------------------------------------------------------- */}
        {/* Header                                                     */}
        {/* --------------------------------------------------------- */}
        <header
          className="mb-10 flex flex-col gap-4 border-b pb-8"
          style={{ borderColor: BORDER }}
        >
          <div className="flex flex-wrap items-center gap-3">
            <span
              className="rounded-md border px-2.5 py-1 text-[12px] font-bold tracking-wide"
              style={{
                borderColor: BORDER_STRONG,
                color: TEXT_PRIMARY,
                fontFamily: MONO,
              }}
            >
              {route.method}
            </span>
            <span
              className="text-[19px] font-medium tracking-tight"
              style={{ fontFamily: MONO, color: TEXT_PRIMARY }}
            >
              {route.routePath}
            </span>
            <span
              className="ml-auto flex items-center gap-2 text-[12px]"
              style={{ color: isLivePolling ? TEXT_PRIMARY : TEXT_QUIET }}
            >
              <Radio size={13} />
              {isBusy ? "Sending traffic" : isLivePolling ? "Live" : "Idle"}
            </span>
          </div>
          <div
            className="flex flex-wrap items-center gap-2.5 text-[12.5px]"
            style={{ color: TEXT_TERTIARY }}
          >
            <span style={{ fontFamily: MONO, color: TEXT_SECONDARY }}>
              {route.file}:{route.line}
            </span>
            <CopyButton text={`${route.file}:${route.line}`} />
            <span style={{ color: BORDER_STRONG }}>·</span>
            <span
              className="rounded border px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.06em]"
              style={{ borderColor: BORDER, color: TEXT_SECONDARY }}
            >
              {repo.framework}
            </span>
          </div>
        </header>

        {/* --------------------------------------------------------- */}
        {/* What this endpoint does                                    */}
        {/* --------------------------------------------------------- */}
        <section
          className="mb-10 border-b pb-8"
          style={{ borderColor: BORDER }}
        >
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
              className="text-[14.5px] leading-[1.75]"
              style={{ color: TEXT_SECONDARY }}
            >
              {explanation ?? "No explanation available yet."}
            </p>
          )}
        </section>

        {/* --------------------------------------------------------- */}
        {/* Call chain — route → controller → service                 */}
        {/* --------------------------------------------------------- */}
        {connected && connected.files.length > 0 && (
          <nav
            className="mb-10 flex flex-wrap items-center gap-2 border-b pb-8"
            style={{ borderColor: BORDER }}
          >
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

        {/* --------------------------------------------------------- */}
        {/* Source                                                     */}
        {/* --------------------------------------------------------- */}
        <section
          className="mb-10 border-b pb-8"
          style={{ borderColor: BORDER }}
        >
          <div
            className="overflow-hidden rounded-xl border"
            style={{ borderColor: BORDER, background: "#0d0d0d" }}
          >
            <div
              className="flex items-center justify-between border-b px-5 py-3.5"
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
                        <Icon size={14} style={{ color: TEXT_TERTIARY }} />
                      );
                    })()}
                    <span style={{ fontFamily: MONO }}>{activeFile.path}</span>
                  </>
                )}
              </div>
              {activeFile && <CopyButton text={activeFile.path} />}
            </div>
            <div className="max-h-[480px] overflow-auto px-3">
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
        </section>

        {/* --------------------------------------------------------- */}
        {/* Request body schema                                        */}
        {/* --------------------------------------------------------- */}
        <section
          className="mb-14 border-b pb-8"
          style={{ borderColor: BORDER }}
        >
          <Eyebrow>Request body</Eyebrow>
          {connected?.requestBodyFields.length ? (
            <div
              className="overflow-hidden rounded-lg border"
              style={{ borderColor: BORDER }}
            >
              {connected.requestBodyFields.map((f, i) => (
                <div
                  key={f}
                  className="flex items-center justify-between px-4 py-3 text-[13px]"
                  style={{
                    borderTop: i > 0 ? `1px solid ${BORDER}` : undefined,
                  }}
                >
                  <span style={{ fontFamily: MONO, color: TEXT_PRIMARY }}>
                    {f}
                  </span>
                  <span
                    className="rounded border px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-[0.06em]"
                    style={{ borderColor: BORDER_STRONG, color: TEXT_TERTIARY }}
                  >
                    field
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p
              className="text-[13px] leading-[1.7]"
              style={{ color: TEXT_QUIET }}
            >
              No{" "}
              <code style={{ fontFamily: MONO, color: TEXT_SECONDARY }}>
                req.body
              </code>{" "}
              usage found in the controller — this handler likely doesn't read a
              request body (e.g. a GET/list route).
            </p>
          )}
        </section>

        {/* --------------------------------------------------------- */}
        {/* Traffic generator — the centered focal point of the page  */}
        {/* --------------------------------------------------------- */}
        <section className="flex flex-col items-center pt-2 text-center">
          <span
            className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em]"
            style={{ color: TEXT_TERTIARY }}
          >
            Traffic generator
          </span>
          <h2 className="mb-7 text-[15px]" style={{ color: TEXT_SECONDARY }}>
            Describe a scenario. Get a runnable k6 script.
          </h2>

          <div
            className="w-full max-w-[620px] rounded-2xl border p-2 transition-colors"
            style={{ borderColor: BORDER_STRONG, background: SURFACE }}
          >
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Simulate 100 concurrent users checking out with random products for 30 seconds."
              rows={3}
              disabled={scriptLoading}
              className="w-full resize-none bg-transparent px-3.5 py-3 text-left text-[13.5px] leading-[1.6] outline-none"
              style={{ color: TEXT_PRIMARY, fontFamily: SANS }}
            />
            <div className="flex items-center justify-end gap-2 px-1 pb-1">
              <button
                onClick={handleGenerateScript}
                disabled={scriptLoading || !description.trim()}
                className="flex items-center justify-center gap-2 rounded-lg border px-3.5 py-2 text-[12.5px] font-semibold transition-colors disabled:opacity-30"
                style={{ borderColor: BORDER_STRONG, color: TEXT_SECONDARY }}
              >
                {scriptLoading ? (
                  <>
                    <Loader2 size={13} className="animate-spin" />
                    Generating
                  </>
                ) : (
                  <>
                    <Sparkles size={13} />
                    Generate
                  </>
                )}
              </button>
              <button
                onClick={handleRunScript}
                disabled={scriptRunning || !script}
                className="flex items-center justify-center gap-2 rounded-lg bg-white px-3.5 py-2 text-[12.5px] font-bold text-black transition-colors hover:bg-[#e5e5e5] disabled:opacity-30"
              >
                {scriptRunning ? (
                  <>
                    <Loader2 size={13} className="animate-spin" />
                    Running
                  </>
                ) : (
                  <>
                    <Play size={13} />
                    Run
                  </>
                )}
              </button>
            </div>
          </div>

          {authRequired && (
            <div
              className="mt-3 flex w-full max-w-[620px] items-center gap-2.5 rounded-xl border px-3.5 py-2.5"
              style={{ borderColor: BORDER_STRONG }}
            >
              <KeyRound
                size={14}
                className="shrink-0"
                style={{ color: TEXT_TERTIARY }}
              />
              <input
                type="password"
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                placeholder="Bearer token for this route (auth middleware detected)"
                className="w-full bg-transparent text-[12.5px] outline-none"
                style={{ fontFamily: MONO, color: TEXT_PRIMARY }}
              />
            </div>
          )}

          {scriptError && (
            <div className="mt-3">
              <InvertChip icon={X}>{scriptError}</InvertChip>
            </div>
          )}

          {script && (
            <div
              className="mt-6 w-full overflow-hidden rounded-xl border text-left"
              style={{ borderColor: BORDER, background: "#0d0d0d" }}
            >
              <div
                className="flex items-center justify-between border-b px-3.5 py-2.5"
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
                  rows={16}
                  spellCheck={false}
                  className="w-full resize-y bg-transparent px-3.5 py-3 text-[12.5px] leading-[1.7] outline-none"
                  style={{ fontFamily: MONO, color: TEXT_SECONDARY }}
                />
              ) : (
                <div className="max-h-[380px] overflow-auto px-2.5">
                  <CodeBlock code={script} filePath="script.js" />
                </div>
              )}
            </div>
          )}

          {progress && progress.status !== "done" && (
            <p className="mt-3 text-[11.5px]" style={{ color: TEXT_TERTIARY }}>
              {progress.status === "starting"
                ? "Starting k6…"
                : `${progress.sent} requests sent so far…`}
            </p>
          )}

          {/* Run results */}
          {loadResult && (
            <div className="mt-8 w-full text-left">
              <Eyebrow>Run results</Eyebrow>
              <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-6">
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

          {/* Live telemetry */}
          {(telemetry || isLivePolling) && (
            <div className="mt-8 w-full text-left">
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
                  <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
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
                      <ResponsiveContainer width="100%" height={140}>
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
        </section>
      </div>

      {/* ----------------------------------------------------------- */}
      {/* Execution console — full-width, fixed to the viewport floor  */}
      {/* ----------------------------------------------------------- */}
      <ExecutionConsole entries={entries} progress={progress} onClear={reset} />
    </div>
  );
}
