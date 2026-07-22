import {
  AlertTriangle,
  TrendingDown,
  Wrench,
  RotateCcw,
  Loader2,
} from "lucide-react";
import type { PerformanceReport, LoadScriptResult } from "../api/repos";
import DiffViewer from "./DiffViewer";

const SURFACE = "#111111";
const BORDER = "#1e1e1e";
const BORDER_STRONG = "#2e2e2e";
const TEXT_PRIMARY = "#f5f5f5";
const TEXT_SECONDARY = "#b3b3b3";
const TEXT_TERTIARY = "#6e6e6e";
const MONO = "'Berkeley Mono', ui-monospace, monospace";

const SEVERITY_META = {
  critical: { color: "#f29b9b", label: "Critical" },
  warning: { color: "#e2c67e", label: "Warning" },
  info: { color: "#7ea8e2", label: "Info" },
};

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

export default function PerformanceReportPanel({
  report,
  loading,
  error,
  baseline,
  comparison,
  comparisonLoading,
  onRunAgain,
}: {
  report: PerformanceReport | null;
  loading: boolean;
  error: string | null;
  baseline: LoadScriptResult | null;
  comparison: LoadScriptResult | null;
  comparisonLoading: boolean;
  onRunAgain: () => void;
}) {
  if (loading) {
    return (
      <div
        className="flex items-center gap-2 py-6 text-[13px]"
        style={{ color: TEXT_TERTIARY }}
      >
        <Loader2 size={14} className="animate-spin" />
        Analyzing performance…
      </div>
    );
  }

  if (error) {
    return (
      <p className="py-4 text-[13px]" style={{ color: "#f29b9b" }}>
        Couldn't generate an analysis: {error}
      </p>
    );
  }

  if (!report) return null;

  const sev = SEVERITY_META[report.severity];

  return (
    <div className="mt-8 border-t pt-6" style={{ borderColor: BORDER }}>
      {/* Root cause */}
      <div className="mb-5 flex items-start gap-2.5">
        <AlertTriangle
          size={16}
          style={{ color: sev.color }}
          className="mt-0.5 shrink-0"
        />
        <div>
          <div className="flex items-center gap-2">
            <span
              className="text-[11px] font-semibold uppercase tracking-[0.06em]"
              style={{ color: sev.color }}
            >
              {sev.label} · Root Cause
            </span>
            <span className="text-[10.5px]" style={{ color: TEXT_TERTIARY }}>
              {report.confidence} confidence
            </span>
          </div>
          <p
            className="mt-1 text-[14.5px] font-medium"
            style={{ color: TEXT_PRIMARY }}
          >
            {report.rootCause}
          </p>
        </div>
      </div>

      {/* Evidence */}
      <div
        className="mb-6 rounded-lg border px-4 py-3"
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

      {/* Suggested fix */}
      <div className="mb-6">
        <div className="mb-2 flex items-center gap-1.5">
          <Wrench size={13} style={{ color: TEXT_TERTIARY }} />
          <span
            className="text-[11px] font-semibold uppercase tracking-[0.06em]"
            style={{ color: TEXT_TERTIARY }}
          >
            Suggested Fix
          </span>
        </div>
        <p className="text-[14px] font-medium" style={{ color: TEXT_PRIMARY }}>
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
      </div>

      {/* Diff */}
      {report.diff && (
        <div
          className="mb-6 overflow-hidden rounded-xl border"
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
      )}

      {/* Run again + before/after */}
      <div className="flex items-center gap-3">
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
          {comparisonLoading ? "Running benchmark…" : "Run Benchmark Again"}
        </button>
      </div>

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
  );
}
