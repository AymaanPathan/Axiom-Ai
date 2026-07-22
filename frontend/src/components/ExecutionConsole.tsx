import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import type {
  ExecutionLogEntry,
  TrafficProgress,
} from "../hooks/useTrafficStream";

const MONO = "'Berkeley Mono', ui-monospace, monospace";
const SANS = "'Inter', ui-sans-serif, system-ui, sans-serif";

const BORDER = "#1e1e1e";
const BORDER_STRONG = "#2e2e2e";
const TEXT_PRIMARY = "#f5f5f5";
const TEXT_SECONDARY = "#b3b3b3";
const TEXT_TERTIARY = "#6e6e6e";
const TEXT_QUIET = "#454545";

// Two fixed widths — narrow default, wide "expanded" mode — rather than a
// free drag handle. This is the same mental model as the Codex/Copilot
// sidebar in VS Code: one button snaps the panel between a slim rail and a
// full working width.
const WIDTH_NARROW = 400;
const WIDTH_WIDE = 720;
const AUTOSCROLL_THRESHOLD_PX = 40;

interface ExecutionConsoleProps {
  entries: ExecutionLogEntry[];
  progress: TrafficProgress | null;
  expanded: boolean;
  onToggleExpand: () => void;
  onClear: () => void;
  onClose: () => void;
}

export default function ExecutionConsole({
  entries,
  progress,
  expanded,
  onToggleExpand,
  onClear,
  onClose,
}: ExecutionConsoleProps) {
  const [autoScroll, setAutoScroll] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);

  const isRunning =
    progress?.status === "starting" || progress?.status === "running";

  // --- autoscroll, unless the user has scrolled up to read history ---
  useEffect(() => {
    if (!autoScroll) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, autoScroll]);

  const handleBodyScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAutoScroll(distanceFromBottom < AUTOSCROLL_THRESHOLD_PX);
  };

  const jumpToLatest = () => {
    setAutoScroll(true);
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const successCount =
    progress?.successCount ??
    entries.filter((e) => e.kind === "request" && e.ok).length;
  const errorCount =
    progress?.errorCount ??
    entries.filter((e) => e.kind === "request" && !e.ok).length;
  const scriptErrorCount = entries.filter(
    (e) => e.kind === "script_error",
  ).length;

  // Groups failing HTTP requests by status + summary message, so 40
  // identical validation errors show up as "1 distinct cause, 40x" instead
  // of 40 lines you have to scroll through and compare by eye.
  const errorGroups = useMemo(() => {
    const groups = new Map<
      string,
      { status: number; message: string; count: number }
    >();
    for (const entry of entries) {
      if (entry.kind !== "request" || entry.ok) continue;
      const message = entry.responseBodySummary || "no detail";
      const key = `${entry.status}::${message}`;
      const existing = groups.get(key);
      if (existing) existing.count++;
      else groups.set(key, { status: entry.status, message, count: 1 });
    }
    return Array.from(groups.values()).sort((a, b) => b.count - a.count);
  }, [entries]);

  return (
    <div
      className="fixed inset-y-0 right-0 z-40 flex flex-col border-l"
      style={{
        width: expanded ? WIDTH_WIDE : WIDTH_NARROW,
        borderColor: BORDER,
        background: "#0a0a0a",
        transition: "width 160ms ease",
      }}
    >
      {/* Header */}
      <div
        className="flex shrink-0 items-center justify-between border-b px-4 py-3.5"
        style={{ borderColor: BORDER, fontFamily: SANS }}
      >
        <div
          className="flex items-center gap-2.5 text-[13px] font-semibold"
          style={{ color: TEXT_PRIMARY }}
        >
          <Terminal size={14} style={{ color: TEXT_TERTIARY }} />
          Execution Console
          {isRunning && (
            <span
              className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-[0.06em]"
              style={{ borderColor: BORDER_STRONG, color: TEXT_PRIMARY }}
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
              running
            </span>
          )}
          {progress?.status === "done" && !isRunning && (
            <span
              className="rounded-full border px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-[0.06em]"
              style={{ borderColor: BORDER_STRONG, color: TEXT_SECONDARY }}
            >
              done
            </span>
          )}
        </div>

        <div
          className="flex items-center gap-1"
          style={{ color: TEXT_TERTIARY }}
        >
          <button
            onClick={onClear}
            disabled={entries.length === 0}
            className="flex items-center gap-1 rounded-lg p-1.5 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-30"
            title="Clear console"
          >
            <Trash2 size={13} />
          </button>
          <button
            onClick={onToggleExpand}
            className="flex items-center gap-1 rounded-lg p-1.5 transition-colors hover:bg-white/5 hover:text-white"
            title={expanded ? "Collapse panel" : "Expand panel"}
          >
            {expanded ? (
              <ChevronsRight size={14} />
            ) : (
              <ChevronsLeft size={14} />
            )}
          </button>
          <button
            onClick={onClose}
            className="flex items-center gap-1 rounded-lg p-1.5 transition-colors hover:bg-white/5 hover:text-white"
            title="Close console"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Run summary strip */}
      {entries.length > 0 && (
        <div
          className="flex shrink-0 items-center gap-4 border-b px-4 py-2.5 text-[12px]"
          style={{ borderColor: BORDER, color: TEXT_TERTIARY }}
        >
          <span style={{ fontFamily: MONO }} className="font-medium">
            <span style={{ color: TEXT_PRIMARY }}>{successCount} ok</span>
            {errorCount > 0 && (
              <>
                <span style={{ color: BORDER_STRONG }}> · </span>
                <span style={{ color: TEXT_PRIMARY, fontWeight: 700 }}>
                  {errorCount} err
                </span>
              </>
            )}
            {scriptErrorCount > 0 && (
              <>
                <span style={{ color: BORDER_STRONG }}> · </span>
                <span style={{ color: TEXT_SECONDARY }}>
                  {scriptErrorCount} script err
                </span>
              </>
            )}
          </span>
        </div>
      )}

      {/* Error breakdown strip — distinct failure causes at a glance */}
      {errorGroups.length > 0 && (
        <div
          className="flex shrink-0 flex-col gap-2 border-b px-4 py-2.5"
          style={{ borderColor: BORDER, fontFamily: MONO, fontSize: 11.5 }}
        >
          {errorGroups.slice(0, expanded ? 10 : 4).map((g, i) => (
            <span
              key={i}
              className="flex items-center gap-1.5 rounded-md border px-2 py-1"
              style={{ borderColor: BORDER_STRONG }}
              title={g.message}
            >
              <span
                className="shrink-0 font-bold"
                style={{ color: TEXT_PRIMARY }}
              >
                {g.status || "ERR"}
              </span>
              <span className="truncate" style={{ color: TEXT_SECONDARY }}>
                {g.message}
              </span>
              <span
                className="ml-auto shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-bold"
                style={{ borderColor: BORDER_STRONG, color: TEXT_PRIMARY }}
              >
                ×{g.count}
              </span>
            </span>
          ))}
          {errorGroups.length > (expanded ? 10 : 4) && (
            <span style={{ color: TEXT_QUIET }}>
              +{errorGroups.length - (expanded ? 10 : 4)} more distinct errors
            </span>
          )}
        </div>
      )}

      {/* Body */}
      <div
        ref={bodyRef}
        onScroll={handleBodyScroll}
        className="relative flex-1 overflow-y-auto px-4 py-3.5"
        style={{ fontFamily: MONO, fontSize: 12.5, lineHeight: 1.85 }}
      >
        {entries.length === 0 ? (
          <p style={{ color: TEXT_QUIET }}>
            {isRunning
              ? "Waiting for output…"
              : "No output yet — run a load test to see execution logs here."}
          </p>
        ) : (
          entries.map((entry) => (
            <LogLine key={entry.id} entry={entry} expanded={expanded} />
          ))
        )}

        {!autoScroll && entries.length > 0 && (
          <button
            onClick={jumpToLatest}
            className="sticky bottom-1 left-full ml-auto flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-medium shadow-lg transition-colors"
            style={{
              borderColor: BORDER_STRONG,
              color: TEXT_PRIMARY,
              background: "#111111",
              fontFamily: SANS,
            }}
          >
            <ChevronDown size={12} />
            Jump to latest
          </button>
        )}
      </div>
    </div>
  );
}

function LogLine({
  entry,
  expanded,
}: {
  entry: ExecutionLogEntry;
  expanded: boolean;
}) {
  const [open, setOpen] = useState(false);

  const timeLabel = new Date(entry.timestamp).toLocaleTimeString([], {
    hour12: false,
    minute: "2-digit",
    second: "2-digit",
  });

  if (entry.kind === "request") {
    const hasDetail =
      !entry.ok && Boolean(entry.responseBody || entry.requestBody);

    return (
      <div className="py-1">
        <div
          className={`flex flex-wrap items-start gap-x-2.5 gap-y-0.5 ${hasDetail ? "cursor-pointer" : ""}`}
          onClick={() => hasDetail && setOpen((o) => !o)}
        >
          <span className="shrink-0" style={{ color: TEXT_QUIET }}>
            {timeLabel}
          </span>
          <span className="shrink-0" style={{ color: TEXT_TERTIARY }}>
            #{entry.index}
          </span>
          <span
            className="shrink-0 font-semibold"
            style={{ color: entry.ok ? TEXT_SECONDARY : TEXT_PRIMARY }}
          >
            {entry.status || "ERR"}
          </span>
          {entry.method && entry.url && (
            <span
              className={expanded ? "shrink-0" : "min-w-0 truncate"}
              style={{ color: TEXT_TERTIARY }}
            >
              {entry.method} {entry.url}
            </span>
          )}
          {hasDetail && (
            <span className="ml-auto shrink-0" style={{ color: TEXT_TERTIARY }}>
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </span>
          )}
          {!entry.ok && entry.responseBodySummary && (
            <span
              className="w-full truncate pl-[3.6rem]"
              style={{ color: TEXT_SECONDARY }}
            >
              {entry.responseBodySummary}
            </span>
          )}
        </div>

        {open && hasDetail && (
          <div
            className="mt-1.5 mb-1 space-y-2 rounded-lg border p-3"
            style={{ borderColor: BORDER, background: "#0d0d0d" }}
          >
            {entry.requestBody && (
              <div>
                <div
                  className="mb-1 text-[10.5px] font-bold uppercase tracking-[0.06em]"
                  style={{ color: TEXT_TERTIARY }}
                >
                  Request payload
                </div>
                <pre
                  className="whitespace-pre-wrap break-all"
                  style={{ color: TEXT_SECONDARY }}
                >
                  {entry.requestBody}
                </pre>
              </div>
            )}
            {entry.responseBody && (
              <div>
                <div
                  className="mb-1 text-[10.5px] font-bold uppercase tracking-[0.06em]"
                  style={{ color: TEXT_TERTIARY }}
                >
                  Failure detail
                </div>
                <pre
                  className="whitespace-pre-wrap break-all"
                  style={{ color: TEXT_PRIMARY }}
                >
                  {entry.responseBody}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  if (entry.kind === "script_error") {
    return (
      <div className="py-1">
        <div
          className="flex items-start gap-2.5 cursor-pointer"
          onClick={() => setOpen((o) => !o)}
        >
          <span className="shrink-0" style={{ color: TEXT_QUIET }}>
            {timeLabel}
          </span>
          <AlertTriangle
            size={13}
            className="mt-0.5 shrink-0"
            style={{ color: TEXT_SECONDARY }}
          />
          <span
            className="shrink-0 font-semibold"
            style={{ color: TEXT_SECONDARY }}
          >
            script error
          </span>
          <span className="min-w-0 truncate" style={{ color: TEXT_TERTIARY }}>
            {entry.message}
          </span>
          {entry.stack && (
            <span className="ml-auto shrink-0" style={{ color: TEXT_TERTIARY }}>
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </span>
          )}
        </div>
        {open && entry.stack && (
          <div
            className="mt-1.5 mb-1 rounded-lg border p-3"
            style={{ borderColor: BORDER, background: "#0d0d0d" }}
          >
            <div
              className="mb-1 text-[10.5px] font-bold uppercase tracking-[0.06em]"
              style={{ color: TEXT_TERTIARY }}
            >
              Stack trace — this is a bug in the generated script, not an HTTP
              error
            </div>
            <pre
              className="whitespace-pre-wrap break-all"
              style={{ color: TEXT_SECONDARY }}
            >
              {entry.stack}
            </pre>
          </div>
        )}
      </div>
    );
  }

  const isErr = entry.stream === "stderr";
  return (
    <div className="flex items-start gap-2.5 py-1">
      <span className="shrink-0" style={{ color: TEXT_QUIET }}>
        {timeLabel}
      </span>
      <span
        className="shrink-0 font-semibold"
        style={{ color: isErr ? TEXT_PRIMARY : TEXT_TERTIARY }}
      >
        {isErr ? "stderr" : "stdout"}
      </span>
      <span
        className="min-w-0 whitespace-pre-wrap break-all"
        style={{ color: isErr ? TEXT_PRIMARY : TEXT_SECONDARY }}
      >
        {entry.message}
      </span>
    </div>
  );
}
