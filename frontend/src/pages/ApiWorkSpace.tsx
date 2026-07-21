import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useDispatch, useSelector } from "react-redux";
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import type { AppDispatch, RootState } from "../store/store";
import { fetchRepoDetail } from "../store/slices/reposSlice";
import {
  generateTraffic,
  getTelemetry,
  getExplanation,
  getConnectedFiles,
  type RouteTelemetry,
  type ConnectedFilesResult,
  type ConnectedFile,
} from "../api/repos";
import { useTrafficStream } from "../hooks/useTrafficStream";

const MONO = "'Berkeley Mono', ui-monospace, monospace";
const SIGNOZ_BLUE = "#4c9aff";
const TELEMETRY_POLL_MS = 2000;
const TELEMETRY_POLL_DURATION_MS = 20_000;
const MAX_CHART_POINTS = 30;

interface TelemetryPoint {
  time: string;
  p50: number;
  p95: number;
}

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

  const { logs, progress, reset } = useTrafficStream(repositoryId || null);

  // --- endpoint context: explanation + connected files + schema ---
  const [explanation, setExplanation] = useState<string | null>(null);
  const [explanationLoading, setExplanationLoading] = useState(false);
  const [connected, setConnected] = useState<ConnectedFilesResult | null>(null);
  const [activeFile, setActiveFile] = useState<ConnectedFile | null>(null);

  // --- traffic + live telemetry ---
  const [requestCount, setRequestCount] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<RouteTelemetry | null>(null);
  const [chartData, setChartData] = useState<TelemetryPoint[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  const handleGenerateTraffic = async () => {
    if (!repo || !route) return;
    setError(null);
    setTelemetry(null);
    setChartData([]);
    reset();
    try {
      const result = await generateTraffic(
        repositoryId,
        Number(routeIndex),
        requestCount,
      );
      const serviceName = repo.githubFullName.split("/")[1];
      pollTelemetry(result.windowStart, result.windowEnd, serviceName);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
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

  if (!repo || !route) {
    return (
      <div className="px-8 py-6 text-[13px] text-[#62666d]">
        Loading endpoint…
      </div>
    );
  }

  return (
    <div
      className="px-8 py-6"
      style={{ fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif" }}
    >
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-[#4c9aff1a] px-2 py-0.5 text-[12px] font-medium text-[#4c9aff]">
            {route.method}
          </span>
          <span
            className="text-[18px] font-medium text-white"
            style={{ fontFamily: MONO }}
          >
            {route.routePath}
          </span>
        </div>
        <div
          className="mt-1 text-[12px] text-[#62666d]"
          style={{ fontFamily: MONO }}
        >
          {route.file}:{route.line}
        </div>
      </div>

      {/* AI Explanation */}
      <div className="mb-6 rounded-xl border border-[#161718] bg-[#0d0e0f] px-4 py-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wide text-[#62666d]">
            ✨ AI Explanation
          </span>
          <button
            onClick={() => {
              setExplanationLoading(true);
              getExplanation(repositoryId, route.file, route.line)
                .then(setExplanation)
                .finally(() => setExplanationLoading(false));
            }}
            className="text-[11px] text-[#4c9aff] hover:underline"
          >
            Regenerate
          </button>
        </div>
        <p className="text-[13px] leading-[1.6] text-[#d0d6e0]">
          {explanationLoading
            ? "Generating…"
            : (explanation ?? "No explanation available yet.")}
        </p>
      </div>

      {/* Two-column body */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_420px]">
        {/* LEFT: request schema + connected files */}
        <div className="flex flex-col gap-6">
          <div className="rounded-xl border border-[#161718] bg-[#0d0e0f] px-4 py-3">
            <div className="mb-2 text-[11px] uppercase tracking-wide text-[#62666d]">
              Request Body
            </div>
            {connected?.requestBodyFields.length ? (
              <ul className="flex flex-wrap gap-2">
                {connected.requestBodyFields.map((f) => (
                  <li
                    key={f}
                    style={{ fontFamily: MONO }}
                    className="rounded-md border border-[#161718] bg-[#0a0b0c] px-2 py-1 text-[12px] text-[#d0d6e0]"
                  >
                    {f}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12px] text-[#4c4f54]">
                No req.body usage found in the controller — this handler likely
                doesn't read a request body (e.g. a GET/list route).
              </p>
            )}
          </div>

          <div className="rounded-xl border border-[#161718] bg-[#0d0e0f]">
            <div className="flex items-center justify-between border-b border-[#161718] px-4 py-2.5">
              <span className="text-[12px] text-[#62666d]">
                Connected Files
              </span>
              <span
                className="text-[11px] text-[#4c4f54]"
                style={{ fontFamily: MONO }}
              >
                {route.file}
              </span>
            </div>
            <div className="flex gap-1 border-b border-[#161718] px-2 pt-2">
              {connected?.files.map((f) => (
                <button
                  key={f.path}
                  onClick={() => setActiveFile(f)}
                  className={`rounded-t-md px-3 py-1.5 text-[12px] capitalize ${
                    activeFile?.path === f.path
                      ? "bg-[#161718] text-white"
                      : "text-[#62666d] hover:text-[#a0a6b0]"
                  }`}
                >
                  {f.role}
                </button>
              ))}
              {!connected && (
                <span className="px-3 py-1.5 text-[12px] text-[#4c4f54]">
                  Loading…
                </span>
              )}
            </div>
            <div
              className="border-b border-[#161718] px-4 py-1.5 text-[11px] text-[#4c4f54]"
              style={{ fontFamily: MONO }}
            >
              {activeFile?.path ?? "—"}
            </div>
            <pre
              className="max-h-[360px] overflow-auto px-4 py-3 text-[12px] leading-[1.6] text-[#d0d6e0]"
              style={{ fontFamily: MONO }}
            >
              {activeFile?.content ?? "No source available for this file."}
            </pre>
          </div>
        </div>

        {/* RIGHT: traffic controls + live log + live metrics */}
        <div className="flex flex-col gap-4">
          <div className="rounded-xl border border-[#161718] bg-[#0d0e0f] px-4 py-4">
            <div className="text-[13px] font-medium text-white">
              Generate Traffic
            </div>
            <div className="mt-0.5 text-[12px] text-[#62666d]">
              Sends real requests and streams telemetry live.
            </div>
            <div className="mt-3 flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={200}
                value={requestCount}
                disabled={isBusy}
                onChange={(e) => setRequestCount(Number(e.target.value) || 1)}
                className="w-16 rounded-md border border-[#161718] bg-[#0a0b0c] px-2 py-1 text-[12px] text-white"
                style={{ fontFamily: MONO }}
              />
              <button
                onClick={handleGenerateTraffic}
                disabled={isBusy}
                className="flex-1 rounded-lg bg-[#4c9aff] px-3 py-1.5 text-[13px] font-medium text-black disabled:opacity-50"
              >
                {isBusy
                  ? `Sending ${progress?.sent ?? 0}/${progress?.total ?? requestCount}…`
                  : "Generate Traffic"}
              </button>
            </div>
            {error && (
              <div className="mt-2 rounded-md bg-[#eb57571a] px-3 py-2 text-[12px] text-[#eb5757]">
                {error}
              </div>
            )}
            {progress && (
              <div className="mt-3 grid grid-cols-3 gap-2 text-[12px]">
                <StatBlock
                  label="Sent"
                  value={`${progress.sent}/${progress.total}`}
                />
                <StatBlock
                  label="OK"
                  value={progress.successCount ?? 0}
                  tone="good"
                />
                <StatBlock
                  label="Failed"
                  value={progress.errorCount ?? 0}
                  tone={(progress.errorCount ?? 0) > 0 ? "bad" : undefined}
                />
              </div>
            )}
          </div>

          {/* Live per-request log */}
          <div className="rounded-xl border border-[#161718] bg-[#0d0e0f]">
            <div className="border-b border-[#161718] px-4 py-2 text-[12px] text-[#62666d]">
              Request log {logs.length > 0 && `(${logs.length})`}
            </div>
            <div
              className="max-h-[220px] overflow-y-auto px-4 py-2 text-[11px] leading-[1.7]"
              style={{ fontFamily: MONO }}
            >
              {logs.length === 0 && (
                <p className="text-[#4c4f54]">No requests sent yet.</p>
              )}
              {logs.map((l) => (
                <div key={l.index} className="flex items-start gap-2">
                  <span className="text-[#4c4f54]">#{l.index}</span>
                  <span className={l.ok ? "text-[#27a644]" : "text-[#eb5757]"}>
                    {l.status || "ERR"}
                  </span>
                  {!l.ok && l.responseBody && (
                    <span className="truncate text-[#eb5757]/80">
                      — {l.responseBody}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Live metrics — inline, no navigating away */}
          <div className="rounded-xl border border-[#161718] bg-[#0d0e0f] px-4 py-4">
            <div className="mb-3 flex items-center justify-between text-[11px] uppercase tracking-wide text-[#62666d]">
              <span>Live telemetry (SigNoz)</span>
              {isLivePolling && <span className="text-[#27a644]">● live</span>}
            </div>

            {telemetry ? (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <StatBlock label="Requests" value={telemetry.requestCount} />
                  <StatBlock
                    label="Error rate"
                    value={`${telemetry.errorRatePercent}%`}
                    tone={telemetry.errorRatePercent > 2 ? "bad" : undefined}
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
                  <div className="mt-3">
                    <ResponsiveContainer width="100%" height={120}>
                      <LineChart data={chartData}>
                        <CartesianGrid stroke="#161718" vertical={false} />
                        <XAxis dataKey="time" stroke="#4c4f54" fontSize={9} />
                        <YAxis stroke="#4c4f54" fontSize={9} />
                        <Tooltip
                          contentStyle={{
                            background: "#0d0e0f",
                            border: "1px solid #161718",
                            fontSize: 11,
                          }}
                        />
                        <Line
                          type="monotone"
                          dataKey="p50"
                          stroke="#62666d"
                          dot={false}
                          strokeWidth={1.5}
                        />
                        <Line
                          type="monotone"
                          dataKey="p95"
                          stroke={SIGNOZ_BLUE}
                          dot={false}
                          strokeWidth={1.5}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
                {telemetry.requestCount === 0 && (
                  <p className="mt-3 text-[11px] text-[#f2b94b]">
                    No spans matched yet — still polling.
                  </p>
                )}
              </>
            ) : (
              <p className="text-[12px] text-[#4c4f54]">
                Run traffic to see live numbers here.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatBlock({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: "good" | "bad";
}) {
  const color =
    tone === "good" ? "#27a644" : tone === "bad" ? "#eb5757" : "#ffffff";
  return (
    <div className="rounded-lg border border-[#161718] bg-[#0a0b0c] px-3 py-2">
      <div className="text-[10px] text-[#62666d]">{label}</div>
      <div
        className="mt-0.5 text-[13px] font-medium"
        style={{ color, fontFamily: MONO }}
      >
        {value}
      </div>
    </div>
  );
}
