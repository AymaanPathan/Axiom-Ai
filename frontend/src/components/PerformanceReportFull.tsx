import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Loader2,
  Sparkles,
  RotateCcw,
  Database,
} from "lucide-react";
import type {
  PerformanceReport,
  LoadScriptResult,
  RouteTelemetry,
  OptimizationStrategy,
} from "../api/repos";
import { generateStrategies } from "../api/repos";
import OptimizationArena from "./OptimizationArena";
import {
  SANS,
  MONO,
  SURFACE,
  BORDER,
  BORDER_STRONG,
  TEXT_PRIMARY,
  TEXT_SECONDARY,
  TEXT_TERTIARY,
  ERROR,
} from "../theme";

const SEVERITY_META = {
  critical: { label: "Critical" },
  warning: { label: "Warning" },
  info: { label: "Info" },
};

interface PerformanceReportFullProps {
  repositoryId: string;
  routeIndex: number;
  routeLabel: string;
  script: string;
  authToken?: string;

  loadResult: LoadScriptResult | null;
  report: PerformanceReport | null;
  perfLoading: boolean;
  perfError: string | null;
  telemetry: RouteTelemetry | null;
  baseline: LoadScriptResult | null;
  comparison: LoadScriptResult | null;
  comparisonLoading: boolean;
  onRunAgain: () => void;
}

function Divider() {
  return <div className="my-6 border-t" style={{ borderColor: BORDER }} />;
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
  repositoryId,
  routeIndex,
  routeLabel,
  script,
  authToken,
  loadResult,
  report,
  perfLoading,
  perfError,
  telemetry,
  baseline,
  comparison,
  comparisonLoading,
  onRunAgain,
}: PerformanceReportFullProps) {
  const [strategiesLoading, setStrategiesLoading] = useState(false);
  const [strategiesError, setStrategiesError] = useState<string | null>(null);
  const [strategies, setStrategies] = useState<OptimizationStrategy[] | null>(
    null,
  );

  // A fresh benchmark run shouldn't carry over the previous run's
  // generated strategies.
 useEffect(() => {
   setStrategies(null);
   setStrategiesError(null);
   setStrategiesLoading(false);
 }, [loadResult?.windowStart, loadResult?.windowEnd]);


  async function handleGenerateStrategies() {
    if (!loadResult) return;
    setStrategiesLoading(true);
    setStrategiesError(null);
    try {
      const result = await generateStrategies(
        repositoryId,
        routeIndex,
        loadResult,
        telemetry,
      );
      setStrategies(result.strategies);
    } catch (err) {
      setStrategiesError(
        err instanceof Error ? err.message : "Failed to generate strategies",
      );
    } finally {
      setStrategiesLoading(false);
    }
  }

  if (perfLoading) {
    return (
      <div
        className="flex items-center gap-2 text-[13px]"
        style={{ color: TEXT_TERTIARY, fontFamily: SANS }}
      >
        <Loader2 size={14} className="animate-spin" />
        Analyzing performance…
      </div>
    );
  }

  if (perfError) {
    return (
      <p className="text-[13px]" style={{ color: ERROR, fontFamily: SANS }}>
        Couldn't generate an analysis: {perfError}
      </p>
    );
  }

  if (!report) return null;

  const sev = SEVERITY_META[report.severity];

  return (
    <div style={{ fontFamily: SANS }}>
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
            <span className="text-[10.5px]" style={{ color: TEXT_TERTIARY }}>
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

      <Divider />

      {/* Recommended next step — fans out to N strategies benchmarked
          head-to-head in a leaderboard, rather than one canned diff. */}
      {!strategies && !strategiesLoading && (
        <div>
          <div
            className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em]"
            style={{ color: TEXT_TERTIARY }}
          >
            Recommended Next Step
          </div>
          <p className="mb-3 text-[13px]" style={{ color: TEXT_SECONDARY }}>
            There are multiple ways to address this. Generate distinct
            optimization strategies and benchmark them head-to-head.
          </p>
          <button
            onClick={handleGenerateStrategies}
            className="flex items-center gap-1.5 rounded-lg bg-white px-4 py-2 text-[12.5px] font-bold text-black transition-colors hover:bg-[#e5e5e5]"
          >
            <Sparkles size={13} />
            Generate Strategies
          </button>
          {strategiesError && (
            <p className="mt-2.5 text-[12.5px]" style={{ color: ERROR }}>
              {strategiesError}
            </p>
          )}
        </div>
      )}

      {strategiesLoading && (
        <div
          className="flex items-center gap-2 text-[13px]"
          style={{ color: TEXT_TERTIARY }}
        >
          <Loader2 size={14} className="animate-spin" />
          Thinking through possible fixes…
        </div>
      )}

      {strategies && strategies.length > 0 && (
        <OptimizationArena
          repositoryId={repositoryId}
          routeIndex={routeIndex}
          routeLabel={routeLabel}
          strategies={strategies}
          script={script}
          authToken={authToken}
        />
      )}

      {comparison && baseline && (
        <div className="mt-5">
          <div
            className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.06em]"
            style={{ color: TEXT_TERTIARY }}
          >
            Before vs After (last applied fix)
          </div>
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            <MiniStat
              label="Avg"
              value={`${Math.round(comparison.avgDurationMs)}ms`}
            />
            <MiniStat
              label="P95"
              value={
                comparison.p95DurationMs !== null
                  ? `${Math.round(comparison.p95DurationMs)}ms`
                  : "—"
              }
            />
            <MiniStat
              label="Error rate"
              value={`${Math.round(comparison.errorRate * 1000) / 10}%`}
            />
            <MiniStat
              label="Requests"
              value={comparison.requestsSent.toLocaleString()}
            />
          </div>
          <button
            onClick={onRunAgain}
            disabled={comparisonLoading}
            className="mt-3 flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-[12.5px] font-semibold transition-colors disabled:opacity-40"
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
      )}
    </div>
  );
}
