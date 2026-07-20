import { useState } from "react";
import { generateTraffic } from "../api/traffic";
import { getTelemetry, type RouteTelemetry } from "../api/telementry";

interface TelemetryPanelProps {
  repositoryId: string;
  routeIndex: number;
}

type Phase = "idle" | "generating" | "querying" | "loaded" | "error";

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-[#23252a] bg-white/[0.02] px-4 py-3">
      <p className="text-[11px] uppercase tracking-[0.04em] text-[#62666d]">
        {label}
      </p>
      <p
        className="mt-1 text-[18px] font-[510] text-white"
        style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-[11px] text-[#62666d]">{sub}</p>}
    </div>
  );
}

export default function TelemetryPanel({
  repositoryId,
  routeIndex,
}: TelemetryPanelProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [telemetry, setTelemetry] = useState<RouteTelemetry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requestCount, setRequestCount] = useState(30);

  async function handleRun() {
    setError(null);
    setPhase("generating");
    try {
      const traffic = await generateTraffic(
        repositoryId,
        routeIndex,
        requestCount,
      );
      setPhase("querying");
      // SigNoz's collector batches and flushes spans on an interval, so the
      // traces from this burst may not be queryable the instant the last
      // response comes back — a short buffer avoids an artificially empty
      // first read.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const result = await getTelemetry(
        repositoryId,
        routeIndex,
        traffic.windowStart,
        traffic.windowEnd + 3000,
      );
      setTelemetry(result);
      setPhase("loaded");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to generate telemetry",
      );
      setPhase("error");
    }
  }

  return (
    <div className="rounded-xl border border-[#23252a] bg-[#0f1011]">
      <div className="flex items-center justify-between border-b border-[#23252a] px-5 py-3">
        <span
          className="text-[11px] text-[#62666d]"
          style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}
        >
          Live Telemetry (SigNoz)
        </span>
        {telemetry && (
          <span className="text-[11px] text-[#4c4f54]">
            {telemetry.requestCount} requests ·{" "}
            {new Date(telemetry.window.start).toLocaleTimeString()} –{" "}
            {new Date(telemetry.window.end).toLocaleTimeString()}
          </span>
        )}
      </div>

      {(phase === "idle" || phase === "error") && (
        <div className="flex flex-col items-center gap-3 px-5 py-8 text-center">
          <p className="text-[13px] text-[#8a8f98]">
            Send real traffic to this route, then pull actual latency, error
            rate, and DB/external call timings from SigNoz.
          </p>
          <div className="flex items-center gap-2">
            <label className="text-[12px] text-[#62666d]">Requests:</label>
            <input
              type="number"
              min={5}
              max={200}
              value={requestCount}
              onChange={(e) => setRequestCount(Number(e.target.value))}
              className="w-16 rounded-md border border-[#23252a] bg-white/[0.03] px-2 py-1 text-[12px] text-[#d0d6e0]"
            />
          </div>
          {phase === "error" && (
            <p className="text-[13px] text-[#eb5757]">{error}</p>
          )}
          <button
            type="button"
            onClick={handleRun}
            className="rounded-md border border-[#23252a] bg-white/[0.03] px-4 py-1.5 text-[12px] font-[510] text-[#d0d6e0] transition-colors hover:border-[#383b3f] hover:text-white"
          >
            🚀 Generate traffic & pull telemetry
          </button>
        </div>
      )}

      {phase === "generating" && (
        <div className="flex flex-col items-center gap-2 px-5 py-8 text-center">
          <div className="h-[6px] w-40 overflow-hidden rounded-full bg-white/[0.06]">
            <div className="h-full w-1/2 animate-pulse rounded-full bg-[#4c9aff]" />
          </div>
          <p className="text-[13px] text-[#8a8f98]">
            Sending {requestCount} requests to the running container…
          </p>
        </div>
      )}

      {phase === "querying" && (
        <div className="flex flex-col items-center gap-2 px-5 py-8 text-center">
          <div className="h-[6px] w-40 overflow-hidden rounded-full bg-white/[0.06]">
            <div className="h-full w-3/4 animate-pulse rounded-full bg-[#27a644]" />
          </div>
          <p className="text-[13px] text-[#8a8f98]">
            Querying SigNoz for the resulting spans…
          </p>
        </div>
      )}

      {phase === "loaded" && telemetry && (
        <div className="p-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard
              label="p50 latency"
              value={`${telemetry.latencyMs.p50} ms`}
            />
            <StatCard
              label="p95 latency"
              value={`${telemetry.latencyMs.p95} ms`}
            />
            <StatCard
              label="p99 latency"
              value={`${telemetry.latencyMs.p99} ms`}
            />
            <StatCard
              label="Error rate"
              value={`${telemetry.errorRatePercent}%`}
              sub={`${telemetry.errorCount} of ${telemetry.requestCount}`}
            />
            <StatCard
              label="DB avg"
              value={
                telemetry.db.avgDurationMs !== null
                  ? `${telemetry.db.avgDurationMs} ms`
                  : "—"
              }
              sub={`${telemetry.db.callCount} calls`}
            />
            <StatCard
              label="External avg"
              value={
                telemetry.external.avgDurationMs !== null
                  ? `${telemetry.external.avgDurationMs} ms`
                  : "—"
              }
              sub={`${telemetry.external.callCount} calls`}
            />
          </div>
          <button
            type="button"
            onClick={handleRun}
            className="mt-4 text-[11px] text-[#62666d] transition-colors hover:text-white"
          >
            Run again
          </button>
        </div>
      )}
    </div>
  );
}
