import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  Area, AreaChart, CartesianGrid, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  getEndpointMetrics, getMetricHistory, getRecentErrors, getRecentTraces,
  getServiceHealth, getSystemStatus, signozServiceUrl, signozTraceUrl,
  type EndpointMetric, type ErrorEvent, type ServiceHealth,
  type SystemStatus, type TraceSummary,
} from "../api/observability";
import { useServiceObserver } from "../hooks/useServiceObserver";
import { startRun, stopRun } from "../api/repos";

const MONO = "'Berkeley Mono', ui-monospace, monospace";
const POLL_MS = 10_000;
const SIGNOZ_BLUE = "#4c9aff";

type Section = "overview" | "logs" | "traces" | "errors" | "infra";
type ContainerState = "running" | "stopping" | "stopped" | "starting";

const SECTIONS: { key: Section; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "logs", label: "Logs" },
  { key: "traces", label: "Traces" },
  { key: "errors", label: "Errors" },
  { key: "infra", label: "Infra" },
];

const BOOT_STEPS = [
  { key: "starting", label: "Starting container" },
  { key: "installing", label: "Installing dependencies & building" },
  { key: "running", label: "Service is live" },
] as const;

export default function ObservabilityDashboard() {
  const { repositoryId = "" } = useParams<{ repositoryId: string }>();
  const [section, setSection] = useState<Section>("overview");
  const [health, setHealth] = useState<ServiceHealth | null>(null);
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [endpoints, setEndpoints] = useState<EndpointMetric[]>([]);
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [errors, setErrors] = useState<ErrorEvent[]>([]);

  const {
    connected, logs, latestMetric, metricHistory, seedMetricHistory,
    bootLogs, runStatus, trackRun,
  } = useServiceObserver(repositoryId || null);

  const [containerState, setContainerState] = useState<ContainerState>("running");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [startupModalOpen, setStartupModalOpen] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "error" | "success"; message: string } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // Drive containerState off the *real* run status coming from the socket,
  // not an optimistic guess. This is what fixes the "instant" start.
  useEffect(() => {
    if (!runStatus) return;
    if (runStatus.status === "starting" || runStatus.status === "installing") {
      setContainerState("starting");
    } else if (runStatus.status === "running") {
      setContainerState("running");
      setToast({ kind: "success", message: "Container is up and running." });
      // give the user a beat to see the final checkmark before closing
      setTimeout(() => setStartupModalOpen(false), 900);
    } else if (runStatus.status === "error") {
      setContainerState("stopped");
      setStartupError("The container exited with an error while starting. See logs below.");
    } else if (runStatus.status === "exited") {
      setContainerState("stopped");
    }
  }, [runStatus]);

  const handleStopConfirmed = async () => {
    setConfirmOpen(false);
    setContainerState("stopping");
    try {
      await stopRun(repositoryId);
      setContainerState("stopped");
      setToast({ kind: "success", message: "Container stopped and removed." });
    } catch (err) {
      console.error("Failed to stop run:", err);
      setContainerState("running");
      setToast({ kind: "error", message: "Failed to stop the container. Check the logs and try again." });
    }
  };

  const handleStart = async () => {
    setStartupError(null);
    setContainerState("starting");
    setStartupModalOpen(true);
    try {
      const { runId } = await startRun(repositoryId);
      trackRun(runId); // now the hook starts attributing run:log/run:status to this run
    } catch (err) {
      console.error("Failed to start run:", err);
      setContainerState("stopped");
      setStartupModalOpen(false);
      setToast({ kind: "error", message: "Failed to start the container. Check the logs and try again." });
    }
  };

  useEffect(() => {
    if (!repositoryId) return;
    getMetricHistory(repositoryId, 15).then(seedMetricHistory).catch(() => {});
  }, [repositoryId]);

  useEffect(() => {
    if (!repositoryId) return;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const [h, s] = await Promise.allSettled([
          getServiceHealth(repositoryId),
          getSystemStatus(repositoryId),
        ]);
        if (h.status === "fulfilled") setHealth(h.value);
        if (s.status === "fulfilled") setSystem(s.value);
      } finally {
        inFlight = false;
      }
    };
    tick();
    const interval = setInterval(tick, POLL_MS);
    return () => clearInterval(interval);
  }, [repositoryId]);

  useEffect(() => {
    if (!repositoryId) return;
    let inFlight = false;
    const fetchers: Partial<Record<Section, () => Promise<void>>> = {
      overview: async () => setEndpoints(await getEndpointMetrics(repositoryId)),
      traces: async () => setTraces(await getRecentTraces(repositoryId)),
      errors: async () => setErrors(await getRecentErrors(repositoryId)),
    };
    const fetcher = fetchers[section];
    if (!fetcher) return;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await fetcher();
      } catch {
        // swallow — next tick retries
      } finally {
        inFlight = false;
      }
    };
    tick();
    const interval = setInterval(tick, POLL_MS);
    return () => clearInterval(interval);
  }, [section, repositoryId]);

  const errorCount = useMemo(() => errors.length, [errors]);
  const activeEndpointCount = useMemo(
    () => endpoints.filter((e) => e.requestCount > 0).length,
    [endpoints],
  );

  return (
    <div className="px-8 py-6" style={{ fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif" }}>
      <div className="mb-5 flex items-center justify-between">
        <StatusStrip health={health} connected={connected} />
        <div className="flex items-center gap-3">
          <a
            href={signozServiceUrl(repositoryId)}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-[#161718] px-3 py-1.5 text-[12px] text-[#a0a6b0] hover:text-white hover:border-[#2a2c2e]"
          >
            Open in SigNoz ↗
          </a>
          <ContainerControl
            state={containerState}
            onStopRequested={() => setConfirmOpen(true)}
            onStart={handleStart}
          />
        </div>
      </div>

      <nav className="mb-6 flex gap-1 border-b border-[#161718]">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            onClick={() => setSection(s.key)}
            className={`relative px-3 py-2 text-[13px] -mb-px border-b-2 ${
              section === s.key
                ? "border-[#4c9aff] text-white"
                : "border-transparent text-[#62666d] hover:text-[#a0a6b0]"
            }`}
          >
            {s.label}
            {s.key === "errors" && errorCount > 0 && (
              <span className="ml-1.5 rounded-full bg-[#eb5757]/15 px-1.5 py-0.5 text-[10px] text-[#eb5757]">
                {errorCount}
              </span>
            )}
          </button>
        ))}
      </nav>

      {section === "overview" && (
        <OverviewSection
          latest={latestMetric}
          history={metricHistory}
          endpointsPreview={endpoints.slice(0, 5)}
          activeEndpointCount={activeEndpointCount}
          repositoryId={repositoryId}
        />
      )}
      {section === "logs" && <LogsSection logs={logs} />}
      {section === "traces" && <TracesSection traces={traces} />}
      {section === "errors" && <ErrorsSection errors={errors} />}
      {section === "infra" && <InfraSection system={system} health={health} />}

      {confirmOpen && (
        <ConfirmDialog
          title="Stop this container?"
          description="This will stop and permanently delete the running container. You can start a new one afterward, but any unsaved in-memory state will be lost."
          confirmLabel="Stop & delete"
          onCancel={() => setConfirmOpen(false)}
          onConfirm={handleStopConfirmed}
        />
      )}

      {startupModalOpen && (
        <StartupModal
          status={runStatus?.status ?? "starting"}
          logs={bootLogs}
          error={startupError}
          onClose={() => setStartupModalOpen(false)}
          onRetry={() => {
            setStartupModalOpen(false);
            handleStart();
          }}
        />
      )}

      {toast && <Toast kind={toast.kind} message={toast.message} onClose={() => setToast(null)} />}
    </div>
  );
}

function ContainerControl({
  state, onStopRequested, onStart,
}: { state: ContainerState; onStopRequested: () => void; onStart: () => void }) {
  if (state === "running") {
    return (
      <button
        type="button"
        onClick={onStopRequested}
        className="rounded-lg border border-[#eb5757]/30 bg-[#eb5757]/10 px-3 py-1.5 text-[12px] font-medium text-[#eb5757] transition-colors hover:bg-[#eb5757]/20"
      >
        Stop Container
      </button>
    );
  }
  if (state === "stopping") {
    return (
      <span className="flex items-center gap-2 rounded-lg border border-[#161718] bg-[#0d0e0f] px-3 py-1.5 text-[12px] font-medium text-[#a0a6b0]">
        <Spinner color="#eb5757" /> Stopping…
      </span>
    );
  }
  if (state === "starting") {
    return (
      <span className="flex items-center gap-2 rounded-lg border border-[#161718] bg-[#0d0e0f] px-3 py-1.5 text-[12px] font-medium text-[#a0a6b0]">
        <Spinner color="#27a644" /> Starting…
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onStart}
      className="rounded-lg border border-[#27a644]/30 bg-[#27a644]/10 px-3 py-1.5 text-[12px] font-medium text-[#27a644] transition-colors hover:bg-[#27a644]/20"
    >
      Start Container
    </button>
  );
}

function Spinner({ color }: { color: string }) {
  return (
    <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" style={{ color }}>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

function StartupModal({
  status,
  logs,
  error,
  onClose,
  onRetry,
}: {
  status: "starting" | "installing" | "running" | "exited" | "error";
  logs: { stream: "stdout" | "stderr"; chunk: string; timestamp: number }[];
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
}) {
  const stepIndex = BOOT_STEPS.findIndex((s) => s.key === status);
  const failed = status === "error" || !!error;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl border border-[#232527] bg-[#141516] p-5 shadow-2xl">
        <div className="mb-4 flex items-center gap-2">
          {!failed && <Spinner color="#4c9aff" />}
          {failed && (
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#eb5757]/15 text-[12px] text-[#eb5757]">
              !
            </span>
          )}
          <h3 className="text-[14px] font-medium text-white">
            {failed ? "Startup failed" : "Starting container…"}
          </h3>
        </div>

        {/* Step tracker */}
        <div className="mb-4 flex flex-col gap-2">
          {BOOT_STEPS.map((step, i) => {
            const done = !failed && stepIndex > i;
            const active = !failed && stepIndex === i;
            return (
              <div key={step.key} className="flex items-center gap-2 text-[12.5px]">
                <span
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px]"
                  style={{
                    background: done
                      ? "#27a64422"
                      : active
                        ? "#4c9aff22"
                        : "#1c1d1e",
                    color: done ? "#27a644" : active ? "#4c9aff" : "#4c4f54",
                  }}
                >
                  {done ? "✓" : i + 1}
                </span>
                <span className={active ? "text-white" : done ? "text-[#a0a6b0]" : "text-[#4c4f54]"}>
                  {step.label}
                </span>
                {active && <Spinner color="#4c9aff" />}
              </div>
            );
          })}
        </div>

        {error && (
          <p className="mb-3 rounded-lg border border-[#eb5757]/30 bg-[#eb5757]/10 px-3 py-2 text-[12px] text-[#f0b8b8]">
            {error}
          </p>
        )}

        {/* Live boot logs */}
        <div
          className="max-h-56 overflow-y-auto rounded-xl border border-[#161718] bg-[#0d0e0f] px-3 py-2 text-[11.5px] leading-[1.6]"
          style={{ fontFamily: MONO }}
        >
          {logs.length === 0 && (
            <p className="text-[#4c4f54]">Waiting for container output…</p>
          )}
          {logs.map((line, i) => (
            <pre
              key={i}
              className={`whitespace-pre-wrap ${line.stream === "stderr" ? "text-[#eb5757]" : "text-[#d0d6e0]"}`}
            >
              {line.chunk}
            </pre>
          ))}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          {failed ? (
            <>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-[#232527] px-3 py-1.5 text-[12px] text-[#a0a6b0] hover:text-white"
              >
                Close
              </button>
              <button
                type="button"
                onClick={onRetry}
                className="rounded-lg bg-[#4c9aff] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#3d87e6]"
              >
                Retry
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-[#232527] px-3 py-1.5 text-[12px] text-[#a0a6b0] hover:text-white"
            >
              Run in background
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ConfirmDialog({
  title, description, confirmLabel, onCancel, onConfirm,
}: {
  title: string; description: string; confirmLabel: string;
  onCancel: () => void; onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onCancel}>
      <div className="w-full max-w-sm rounded-2xl border border-[#232527] bg-[#141516] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#eb5757]/15 text-[#eb5757]">!</span>
          <h3 className="text-[14px] font-medium text-white">{title}</h3>
        </div>
        <p className="mb-5 text-[12.5px] leading-[1.6] text-[#a0a6b0]">{description}</p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg border border-[#232527] px-3 py-1.5 text-[12px] text-[#a0a6b0] hover:text-white">Cancel</button>
          <button type="button" onClick={onConfirm} className="rounded-lg bg-[#eb5757] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#d94848]">{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function Toast({ kind, message, onClose }: { kind: "error" | "success"; message: string; onClose: () => void }) {
  const isError = kind === "error";
  return (
    <div className="fixed bottom-5 right-5 z-50">
      <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-[12.5px] shadow-xl ${
        isError ? "border-[#eb5757]/30 bg-[#1c1010] text-[#f0b8b8]" : "border-[#27a644]/30 bg-[#0f1a10] text-[#b8e6c0]"
      }`}>
        <span>{isError ? "⚠" : "✓"}</span>
        <span>{message}</span>
        <button type="button" onClick={onClose} className="ml-2 text-[#62666d] hover:text-white">✕</button>
      </div>
    </div>
  );
}

function StatusStrip({
  health,
  connected,
}: {
  health: ServiceHealth | null;
  connected: boolean;
}) {
  const dot =
    health?.status === "healthy"
      ? "#27a644"
      : health?.status === "degraded"
        ? "#f2b94b"
        : health?.status === "down"
          ? "#eb5757"
          : "#62666d";
  return (
    <div className="flex items-center gap-4">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full" style={{ background: dot }} />
        <span className="text-[14px] font-medium text-white capitalize">
          {health?.status ?? "checking…"}
        </span>
      </div>
      <span className="text-[12px] text-[#62666d]" style={{ fontFamily: MONO }}>
        {health ? `up ${formatUptime(health.uptimeSeconds)}` : "—"}
      </span>
      <span
        className={`text-[12px] ${connected ? "text-[#27a644]" : "text-[#eb5757]"}`}
      >
        {connected ? "● live" : "○ reconnecting…"}
      </span>
    </div>
  );
}

function OverviewSection({
  latest,
  history,
  activeEndpointCount,
}: {
  latest: ReturnType<typeof useServiceObserver>["latestMetric"];
  history: ReturnType<typeof useServiceObserver>["metricHistory"];
  endpointsPreview: EndpointMetric[];
  activeEndpointCount: number;
  repositoryId: string;
}) {
  const chartData = history.map((m) => ({
    time: new Date(m.timestamp).toLocaleTimeString([], {
      minute: "2-digit",
      second: "2-digit",
    }),
    cpu: m.cpuPercent,
    memory: m.memoryMB,
    p50: m.p50Ms,
    p95: m.p95Ms,
    p99: m.p99Ms,
  }));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <SectionHeader title="Service Health" badge="Powered by SigNoz" />
        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <MetricCard
            label="Requests/sec"
            value={latest ? latest.requestRate.toFixed(1) : "—"}
          />
          <MetricCard
            label="P95 Latency"
            value={latest ? `${latest.p95Ms.toFixed(0)} ms` : "—"}
          />
          <MetricCard
            label="Error Rate"
            value={latest ? `${(latest.errorRate * 100).toFixed(2)}%` : "—"}
            alert={!!latest && latest.errorRate > 0.02}
          />
          <MetricCard
            label="Active Endpoints"
            value={String(activeEndpointCount)}
          />
        </div>

        <div className="mt-4">
          <ChartCard title="Latency (p50 / p95 / p99)">
            <ResponsiveContainer width="100%" height={190}>
              <LineChart data={chartData}>
                <CartesianGrid stroke="#161718" vertical={false} />
                <XAxis dataKey="time" stroke="#4c4f54" fontSize={10} />
                <YAxis stroke="#4c4f54" fontSize={10} />
                <Tooltip contentStyle={tooltipStyle} />
                <Line type="monotone" dataKey="p50" stroke="#62666d" dot={false} strokeWidth={1.5} />
                <Line type="monotone" dataKey="p95" stroke={SIGNOZ_BLUE} dot={false} strokeWidth={1.5} />
                <Line type="monotone" dataKey="p99" stroke="#eb5757" dot={false} strokeWidth={1.5} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      </div>

      <div>
        <SectionHeader title="Infrastructure" />
        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <MetricCard
            label="CPU"
            value={latest ? `${latest.cpuPercent.toFixed(1)}%` : "—"}
          />
          <MetricCard
            label="Memory"
            value={latest ? `${latest.memoryMB.toFixed(0)} MB` : "—"}
          />
        </div>
        <div className="mt-4">
          <ChartCard title="CPU & Memory">
            <ResponsiveContainer width="100%" height={190}>
              <AreaChart data={chartData}>
                <CartesianGrid stroke="#161718" vertical={false} />
                <XAxis dataKey="time" stroke="#4c4f54" fontSize={10} />
                <YAxis stroke="#4c4f54" fontSize={10} />
                <Tooltip contentStyle={tooltipStyle} />
                <Area type="monotone" dataKey="cpu" name="CPU %" stroke={SIGNOZ_BLUE} fill={`${SIGNOZ_BLUE}22`} />
                <Area type="monotone" dataKey="memory" name="Mem MB" stroke="#27a644" fill="#27a64422" />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ title, badge }: { title: string; badge?: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] font-medium uppercase tracking-wide text-[#62666d]">
        {title}
      </span>
      {badge && (
        <span
          className="rounded-full px-2 py-0.5 text-[10px]"
          style={{ background: `${SIGNOZ_BLUE}1a`, color: SIGNOZ_BLUE }}
        >
          {badge}
        </span>
      )}
    </div>
  );
}

function LogsSection({
  logs,
}: {
  logs: { stream: "stdout" | "stderr"; chunk: string; timestamp: number }[];
}) {
  return (
    <div
      className="max-h-[620px] overflow-y-auto rounded-xl border border-[#161718] bg-[#0d0e0f] px-4 py-3 text-[12px] leading-[1.6]"
      style={{ fontFamily: MONO }}
    >
      {logs.length === 0 && (
        <p className="text-[#4c4f54]">Watching for output…</p>
      )}
      {logs.map((line, i) => (
        <pre
          key={i}
          className={`whitespace-pre-wrap ${line.stream === "stderr" ? "text-[#eb5757]" : "text-[#d0d6e0]"}`}
        >
          <span className="mr-2 text-[#4c4f54]">
            {new Date(line.timestamp).toLocaleTimeString()}
          </span>
          {line.chunk}
        </pre>
      ))}
    </div>
  );
}

function TracesSection({ traces }: { traces: TraceSummary[] }) {
  if (traces.length === 0) {
    return (
      <p className="text-[12px] text-[#4c4f54]">
        No traces yet — hit an endpoint to generate one.
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-[#161718]">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-[#161718] bg-[#0d0e0f] text-[#62666d]">
            <th className="px-4 py-2 text-left font-medium">Route</th>
            <th className="px-4 py-2 text-left font-medium">Trace ID</th>
            <th className="px-4 py-2 text-right font-medium">Duration</th>
            <th className="px-4 py-2 text-right font-medium">Status</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody>
          {traces.map((t) => (
            <tr
              key={t.traceId}
              className="border-b border-[#161718] last:border-0 hover:bg-[#0d0e0f]"
            >
              <td className="px-4 py-2">
                <span className="text-[#4c9aff]">{t.method}</span> {t.routePath}
              </td>
              <td className="px-4 py-2 text-[#62666d]" style={{ fontFamily: MONO }}>
                {t.traceId.slice(0, 12)}…
              </td>
              <td className="px-4 py-2 text-right" style={{ fontFamily: MONO }}>
                {t.durationMs.toFixed(0)}ms
              </td>
              <td className="px-4 py-2 text-right">
                <span
                  className={
                    t.status === "error" ? "text-[#eb5757]" : "text-[#27a644]"
                  }
                >
                  {t.status}
                </span>
              </td>
              <td className="px-4 py-2 text-right">
                <a
                  href={signozTraceUrl(t.traceId)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[#4c9aff] hover:underline"
                >
                  view ↗
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ErrorsSection({ errors }: { errors: ErrorEvent[] }) {
  if (errors.length === 0) {
    return (
      <p className="text-[12px] text-[#4c4f54]">
        No errors in the recent window. 🎉
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {errors.map((e) => (
        <details
          key={e.id}
          className="rounded-xl border border-[#161718] bg-[#0d0e0f] px-4 py-3"
        >
          <summary className="flex cursor-pointer items-center justify-between text-[12px]">
            <span className="text-[#d0d6e0]">
              {e.method && (
                <span className="mr-2 text-[#eb5757]">{e.method}</span>
              )}
              {e.routePath ? `${e.routePath} — ` : ""}
              {e.message}
            </span>
            <span className="text-[#62666d]" style={{ fontFamily: MONO }}>
              {new Date(e.timestamp).toLocaleTimeString()}
            </span>
          </summary>
          {e.stack && (
            <pre
              className="mt-3 max-h-[240px] overflow-y-auto whitespace-pre-wrap text-[11px] text-[#62666d]"
              style={{ fontFamily: MONO }}
            >
              {e.stack}
            </pre>
          )}
        </details>
      ))}
    </div>
  );
}

function InfraSection({
  system,
  health,
}: {
  system: SystemStatus | null;
  health: ServiceHealth | null;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <InfraCard label="Container" status={system?.container.status ?? "unknown"}>
        <div className="mt-2 space-y-1 text-[12px] text-[#62666d]" style={{ fontFamily: MONO }}>
          <div>{system?.container.image ?? "—"}</div>
          <div>port {system?.container.port ?? "—"}</div>
        </div>
      </InfraCard>
      <InfraCard
        label="MongoDB"
        status={system?.mongo === "connected" ? "running" : "stopped"}
      />
      <InfraCard
        label="Redis"
        status={system?.redis === "connected" ? "running" : "stopped"}
      />
      <div className="col-span-full rounded-xl border border-[#161718] bg-[#0d0e0f] px-4 py-3 text-[12px] text-[#62666d]">
        Last heartbeat:{" "}
        {health ? new Date(health.lastSeenAt).toLocaleTimeString() : "—"}
      </div>
    </div>
  );
}

function InfraCard({
  label,
  status,
  children,
}: {
  label: string;
  status: string;
  children?: React.ReactNode;
}) {
  const dot =
    status === "running"
      ? "#27a644"
      : status === "restarting"
        ? "#f2b94b"
        : "#eb5757";
  return (
    <div className="rounded-xl border border-[#161718] bg-[#0d0e0f] px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-[#62666d]">{label}</span>
        <span className="h-2 w-2 rounded-full" style={{ background: dot }} />
      </div>
      <div className="mt-1 text-[13px] capitalize text-white">{status}</div>
      {children}
    </div>
  );
}

function MetricCard({
  label,
  value,
  alert,
}: {
  label: string;
  value: string;
  alert?: boolean;
}) {
  return (
    <div className="rounded-xl border border-[#161718] bg-[#0d0e0f] px-4 py-3">
      <div className="text-[11px] text-[#62666d]">{label}</div>
      <div
        className={`mt-1 text-[18px] font-medium ${alert ? "text-[#eb5757]" : "text-white"}`}
        style={{ fontFamily: MONO }}
      >
        {value}
      </div>
    </div>
  );
}

function ChartCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-[#161718] bg-[#0d0e0f] px-4 py-3">
      <div className="mb-2 text-[11px] text-[#62666d]">{title}</div>
      {children}
    </div>
  );
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const tooltipStyle = {
  background: "#0d0e0f",
  border: "1px solid #161718",
  fontSize: 11,
  fontFamily: MONO,
};