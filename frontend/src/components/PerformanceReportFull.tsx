import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Sparkles,
  TrendingDown,
  Wrench,
  RotateCcw,
  PlayCircle,
  Database,
  Activity,
  X,
} from "lucide-react";
import type {
  PerformanceReport,
  LoadScriptResult,
  RouteTelemetry,
} from "../api/repos";
import DiffViewer from "./DiffViewer";

const SANS = "'Inter', ui-sans-serif, system-ui, sans-serif";
const MONO = "'Berkeley Mono', ui-monospace, monospace";

const SURFACE = "#111111";
const BORDER = "#1e1e1e";
const BORDER_STRONG = "#2e2e2e";
const TEXT_PRIMARY = "#f5f5f5";
const TEXT_SECONDARY = "#b3b3b3";
const TEXT_TERTIARY = "#6e6e6e";
const TEXT_QUIET = "#4a4a4a";

const SEVERITY_META = {
  critical: { label: "Critical" },
  warning: { label: "Warning" },
  info: { label: "Info" },
};

interface PerformanceReportFullProps {
  method: string;
  routePath: string;
  loadResult: LoadScriptResult | null;
  scriptRunning: boolean;
  scriptError: string | null;
  report: PerformanceReport | null;
  perfLoading: boolean;
  perfError: string | null;
  telemetry: RouteTelemetry | null;
  baseline: LoadScriptResult | null;
  comparison: LoadScriptResult | null;
  comparisonLoading: boolean;
  onRunAgain: () => void;
  onApplyFix: () => void;
  applyFixLoading: boolean;
  applyFixError: string | null;
  fixApplied: boolean;
}

function Divider() {
  return <div className="my-7 border-t" style={{ borderColor: BORDER }} />;
}

function BigStat({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="flex-1 rounded-xl border px-5 py-4"
      style={{ borderColor: BORDER, background: SURFACE }}
    >
      <div
        className="text-[11px] font-medium uppercase tracking-[0.06em]"
        style={{ color: TEXT_TERTIARY }}
      >
        {label}
      </div>
      <div
        className="mt-2 text-[28px] font-semibold leading-none"
        style={{ color: TEXT_PRIMARY, fontFamily: MONO }}
      >
        {value}
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="rounded-lg border px-3 py-2.5"
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
        style={{ color: TEXT_PRIMARY, fontFamily: MONO }}
      >
        {value}
      </div>
    </div>
  );
}

function Stat({
  label,
  before,
  after,
  unit = "",
}: {
  label: string;
  before: number | null;
  after: number | null;
  unit?: string;
}) {
  const improved = before !== null && after !== null && after < before;
  const delta =
    before !== null && after !== null && before > 0
      ? Math.round(((before - after) / before) * 100)
      : null;
  return (
    <div
      className="rounded-lg border px-3.5 py-3"
      style={{ borderColor: BORDER_STRONG, background: SURFACE }}
    >
      <div
        className="text-[10.5px] font-medium uppercase tracking-[0.06em]"
        style={{ color: TEXT_TERTIARY }}
      >
        {label}
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span
          className="text-[11px] line-through"
          style={{ color: TEXT_TERTIARY, fontFamily: MONO }}
        >
          {before !== null ? `${Math.round(before)}${unit}` : "—"}
        </span>
        <span
          className="text-[16px] font-semibold"
          style={{ color: TEXT_PRIMARY, fontFamily: MONO }}
        >
          {after !== null ? `${Math.round(after)}${unit}` : "—"}
        </span>
        {delta !== null && (
          <span
            className="text-[11px] font-semibold"
            style={{ color: improved ? "#7ee2a8" : "#f29b9b" }}
          >
            {improved ? "−" : "+"}
            {Math.abs(delta)}%
          </span>
        )}
      </div>
    </div>
  );
}

function DbBreakdownTable({
  breakdown,
}: {
  breakdown: PerformanceReport["dbBreakdown"];
}) {
  if (!breakdown || breakdown.length === 0) return null;
  const totalTime = breakdown.reduce((sum, b) => sum + b.totalDurationMs, 0);

  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5">
        <Database size={13} style={{ color: TEXT_TERTIARY }} />
        <span
          className="text-[11px] font-semibold uppercase tracking-[0.06em]"
          style={{ color: TEXT_TERTIARY }}
        >
          DB Operations (this run)
        </span>
      </div>
      <div
        className="overflow-hidden rounded-lg border"
        style={{ borderColor: BORDER_STRONG }}
      >
        {breakdown.map((b, i) => {
          const share =
            totalTime > 0
              ? Math.round((b.totalDurationMs / totalTime) * 100)
              : 0;
          return (
            <div
              key={b.operation}
              className="flex items-center gap-3 px-3.5 py-2.5 text-[12.5px]"
              style={{ borderTop: i > 0 ? `1px solid ${BORDER}` : undefined }}
            >
              <span
                className="min-w-0 flex-1 truncate"
                style={{ fontFamily: MONO, color: TEXT_PRIMARY }}
                title={b.operation}
              >
                {b.operation}
              </span>
              <span className="shrink-0" style={{ color: TEXT_TERTIARY }}>
                ×{b.callCount}
              </span>
              <span
                className="shrink-0"
                style={{ fontFamily: MONO, color: TEXT_SECONDARY }}
              >
                avg {b.avgDurationMs}ms
              </span>
              <span
                className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-bold"
                style={{ borderColor: BORDER_STRONG, color: TEXT_PRIMARY }}
              >
                {share}% of DB time
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function PerformanceReportFull({
  method,
  routePath,
  loadResult,
  scriptRunning,
  scriptError,
  report,
  perfLoading,
  perfError,
  telemetry,
  baseline,
  comparison,
  comparisonLoading,
  onRunAgain,
  onApplyFix,
  applyFixLoading,
  applyFixError,
  fixApplied,
}: PerformanceReportFullProps) {
  // Gates the suggested-fix / diff section behind an explicit click,
  // matching the "Recommended Next Step -> Generate Strategies" flow.
  // Resets whenever a new report comes in so a fresh run doesn't
  // silently carry over the previous run's revealed state.
  const [strategiesRevealed, setStrategiesRevealed] = useState(false);
  useEffect(() => {
    setStrategiesRevealed(false);
  }, [report]);

  const revealed = strategiesRevealed || fixApplied;

  const statusPill = (() => {
    if (scriptRunning)
      return { text: "Running Benchmark", tone: "running" as const };
    if (scriptError && !loadResult)
      return { text: "Run Failed", tone: "error" as const };
    if (loadResult && perfLoading)
      return { text: "Analyzing…", tone: "running" as const };
    if (loadResult && report)
      return { text: "Benchmark Completed ✅", tone: "done" as const };
    if (loadResult)
      return { text: "Benchmark Completed", tone: "done" as const };
    return { text: "Not Run Yet", tone: "idle" as const };
  })();

  // Nothing has happened yet — empty state instead of a blank page.
  if (!loadResult && !scriptRunning && !scriptError) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-3 py-20 text-center"
        style={{ fontFamily: SANS }}
      >
        <Activity size={22} style={{ color: TEXT_QUIET }} />
        <p className="text-[13.5px]" style={{ color: TEXT_TERTIARY }}>
          Run a load test from the composer below to generate a performance
          report for this endpoint.
        </p>
      </div>
    );
  }

  const sev = report ? SEVERITY_META[report.severity] : null;

  return (
    <div style={{ fontFamily: SANS }}>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span
            className="rounded border px-2 py-1 text-[11px] font-bold"
            style={{
              borderColor: BORDER_STRONG,
              color: TEXT_SECONDARY,
              fontFamily: MONO,
            }}
          >
            {method}
          </span>
          <span
            className="text-[20px] font-semibold"
            style={{ color: TEXT_PRIMARY, fontFamily: MONO }}
          >
            {routePath}
          </span>
        </div>
        <span
          className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold"
          style={{
            borderColor: BORDER_STRONG,
            color: statusPill.tone === "error" ? "#f29b9b" : TEXT_PRIMARY,
          }}
        >
          {statusPill.tone === "running" && (
            <Loader2 size={12} className="animate-spin" />
          )}
          {statusPill.tone === "done" && <CheckCircle2 size={12} />}
          {statusPill.tone === "error" && <X size={12} />}
          {statusPill.text}
        </span>
      </div>

      {/* Running / error states before we have a result */}
      {scriptRunning && !loadResult && (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <Loader2
            size={20}
            className="animate-spin"
            style={{ color: TEXT_TERTIARY }}
          />
          <p className="text-[13px]" style={{ color: TEXT_TERTIARY }}>
            Sending traffic and collecting results — live output is in the
            console, bottom right.
          </p>
        </div>
      )}

      {scriptError && !loadResult && !scriptRunning && (
        <div
          className="mt-6 rounded-xl border px-4 py-3.5 text-[13px]"
          style={{ borderColor: BORDER_STRONG, color: "#f29b9b" }}
        >
          {scriptError}
        </div>
      )}

      {/* Stat row */}
      {loadResult && (
        <div className="mt-6 flex flex-wrap gap-3">
          <BigStat
            label="Avg Latency"
            value={`${Math.round(loadResult.avgDurationMs)}ms`}
          />
          <BigStat
            label="P95"
            value={
              loadResult.p95DurationMs !== null
                ? `${Math.round(loadResult.p95DurationMs)}ms`
                : "—"
            }
          />
          <BigStat
            label="Requests"
            value={loadResult.requestsSent.toLocaleString()}
          />
        </div>
      )}

      {loadResult && <Divider />}

      {/* Root cause / analysis state */}
      {loadResult && perfLoading && (
        <div
          className="flex items-center gap-2 text-[13px]"
          style={{ color: TEXT_TERTIARY }}
        >
          <Loader2 size={14} className="animate-spin" />
          Analyzing performance…
        </div>
      )}

      {loadResult && perfError && !perfLoading && (
        <p className="text-[13px]" style={{ color: "#f29b9b" }}>
          Couldn't generate an analysis: {perfError}
        </p>
      )}

      {report && sev && (
        <>
          <div className="flex items-start gap-2.5">
            <AlertTriangle
              size={16}
              style={{ color: TEXT_PRIMARY }}
              className="mt-0.5 shrink-0"
            />
            <div>
              <div className="flex items-center gap-2">
                <span
                  className="text-[11px] font-semibold uppercase tracking-[0.06em]"
                  style={{ color: TEXT_TERTIARY }}
                >
                  {sev.label} · Root Cause
                </span>
                <span
                  className="text-[10.5px]"
                  style={{ color: TEXT_TERTIARY }}
                >
                  {report.confidence} confidence
                </span>
              </div>
              <p
                className="mt-1 text-[16px] font-semibold"
                style={{ color: TEXT_PRIMARY }}
              >
                {report.rootCause}
              </p>
            </div>
          </div>

          <div
            className="mt-4 rounded-lg border px-4 py-3"
            style={{ borderColor: BORDER_STRONG, background: SURFACE }}
          >
            <div
              className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.06em]"
              style={{ color: TEXT_TERTIARY }}
            >
              Evidence
            </div>
            <ul className="space-y-1.5">
              {report.evidence.map((line, i) => (
                <li
                  key={i}
                  className="text-[13px] leading-[1.6]"
                  style={{ color: TEXT_SECONDARY, fontFamily: MONO }}
                >
                  · {line}
                </li>
              ))}
            </ul>
          </div>

          {report.dbBreakdown && report.dbBreakdown.length > 0 && (
            <>
              <Divider />
              <DbBreakdownTable breakdown={report.dbBreakdown} />
            </>
          )}

          {telemetry && (
            <>
              <Divider />
              <div>
                <div
                  className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em]"
                  style={{ color: TEXT_TERTIARY }}
                >
                  Live Telemetry
                </div>
                <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
                  <MiniStat
                    label="Requests"
                    value={String(telemetry.requestCount)}
                  />
                  <MiniStat
                    label="Error rate"
                    value={`${telemetry.errorRatePercent}%`}
                  />
                  <MiniStat
                    label="p50"
                    value={`${telemetry.latencyMs.p50}ms`}
                  />
                  <MiniStat
                    label="p95"
                    value={`${telemetry.latencyMs.p95}ms`}
                  />
                </div>
              </div>
            </>
          )}

          <Divider />

          {/* Recommended next step */}
          {!revealed && report.diff && (
            <div>
              <div
                className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em]"
                style={{ color: TEXT_TERTIARY }}
              >
                Recommended Next Step
              </div>
              <p className="mb-3 text-[13px]" style={{ color: TEXT_SECONDARY }}>
                Generate optimization strategies based on the identified root
                cause.
              </p>
              <button
                onClick={() => setStrategiesRevealed(true)}
                className="flex items-center gap-1.5 rounded-lg bg-white px-4 py-2 text-[12.5px] font-bold text-black transition-colors hover:bg-[#e5e5e5]"
              >
                <Sparkles size={13} />
                Generate Strategies
              </button>
            </div>
          )}

          {!report.diff && (
            <p className="text-[13px]" style={{ color: TEXT_QUIET }}>
              No automatic fix available for this root cause — use the evidence
              above to investigate manually.
            </p>
          )}

          {revealed && report.diff && (
            <div>
              <div className="mb-2 flex items-center gap-1.5">
                <Wrench size={13} style={{ color: TEXT_TERTIARY }} />
                <span
                  className="text-[11px] font-semibold uppercase tracking-[0.06em]"
                  style={{ color: TEXT_TERTIARY }}
                >
                  Suggested Fix
                </span>
              </div>
              <p
                className="text-[14px] font-medium"
                style={{ color: TEXT_PRIMARY }}
              >
                {report.suggestedFix.title}
              </p>
              <p
                className="mt-1.5 text-[13px] leading-[1.6]"
                style={{ color: TEXT_SECONDARY }}
              >
                {report.suggestedFix.description}
              </p>
              <div className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-[12px] font-bold text-black">
                <TrendingDown size={13} />
                Est. {report.suggestedFix.estimatedImprovementPercent.min}–
                {report.suggestedFix.estimatedImprovementPercent.max}% faster
              </div>

              <div
                className="mt-5 overflow-hidden rounded-xl border"
                style={{ borderColor: BORDER, background: "#0d0d0d" }}
              >
                <div
                  className="border-b px-3.5 py-2.5"
                  style={{ borderColor: BORDER }}
                >
                  <span
                    className="text-[11.5px]"
                    style={{ fontFamily: MONO, color: TEXT_SECONDARY }}
                  >
                    {report.diff.filePath}
                  </span>
                </div>
                <DiffViewer unifiedDiff={report.diff.unifiedDiff} />
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                {!fixApplied && (
                  <button
                    onClick={onApplyFix}
                    disabled={applyFixLoading}
                    className="flex items-center gap-1.5 rounded-lg bg-white px-3.5 py-2 text-[12.5px] font-bold text-black transition-colors hover:bg-[#e5e5e5] disabled:opacity-40"
                  >
                    {applyFixLoading ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <PlayCircle size={13} />
                    )}
                    {applyFixLoading
                      ? "Applying fix & retesting…"
                      : "Apply Fix & Re-test"}
                  </button>
                )}

                {fixApplied && (
                  <span
                    className="flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-[12.5px] font-semibold"
                    style={{ borderColor: BORDER_STRONG, color: "#7ee2a8" }}
                  >
                    <CheckCircle2 size={13} />
                    Fix applied
                  </span>
                )}

                <button
                  onClick={onRunAgain}
                  disabled={comparisonLoading}
                  className="flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-[12.5px] font-semibold transition-colors disabled:opacity-40"
                  style={{ borderColor: BORDER_STRONG, color: TEXT_SECONDARY }}
                >
                  {comparisonLoading ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <RotateCcw size={13} />
                  )}
                  {comparisonLoading
                    ? "Running benchmark…"
                    : "Run Benchmark Again (no changes)"}
                </button>
              </div>

              {applyFixError && (
                <p
                  className="mt-2.5 text-[12.5px]"
                  style={{ color: "#f29b9b" }}
                >
                  {applyFixError}
                </p>
              )}

              {comparison && baseline && (
                <div className="mt-4">
                  <div
                    className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.06em]"
                    style={{ color: TEXT_TERTIARY }}
                  >
                    Before vs After
                  </div>
                  <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
                    <Stat
                      label="Avg"
                      before={baseline.avgDurationMs}
                      after={comparison.avgDurationMs}
                      unit="ms"
                    />
                    <Stat
                      label="P95"
                      before={baseline.p95DurationMs}
                      after={comparison.p95DurationMs}
                      unit="ms"
                    />
                    <Stat
                      label="P99"
                      before={baseline.p99DurationMs}
                      after={comparison.p99DurationMs}
                      unit="ms"
                    />
                    <Stat
                      label="Error rate"
                      before={baseline.errorRate * 100}
                      after={comparison.errorRate * 100}
                      unit="%"
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
