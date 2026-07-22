import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  GripHorizontal,
  Terminal,
  Trash2,
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

const MIN_HEIGHT = 160;
const MAX_HEIGHT_VH = 0.75;
const DEFAULT_HEIGHT = 280;
const COLLAPSED_HEIGHT = 48;
const AUTOSCROLL_THRESHOLD_PX = 40;

interface ExecutionConsoleProps {
  entries: ExecutionLogEntry[];
  progress: TrafficProgress | null;
  onClear: () => void;
}

export default function ExecutionConsole({
  entries,
  progress,
  onClear,
}: ExecutionConsoleProps) {
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [collapsed, setCollapsed] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const dragState = useRef<{ startY: number; startHeight: number } | null>(
    null,
  );
  const bodyRef = useRef<HTMLDivElement>(null);

  const isRunning =
    progress?.status === "starting" || progress?.status === "running";

  // --- drag-to-resize ---
  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!dragState.current) return;
      const delta = dragState.current.startY - e.clientY;
      const maxHeight = window.innerHeight * MAX_HEIGHT_VH;
      const next = Math.min(
        maxHeight,
        Math.max(MIN_HEIGHT, dragState.current.startHeight + delta),
      );
      setHeight(next);
    };
    const handleUp = () => {
      dragState.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, []);

  const startDrag = (e: React.MouseEvent) => {
    if (collapsed) return;
    dragState.current = { startY: e.clientY, startHeight: height };
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
  };

  // --- autoscroll, unless the user has scrolled up to read history ---
  useEffect(() => {
    if (!autoScroll || collapsed) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, autoScroll, collapsed]);

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
      className="fixed inset-x-0 bottom-0 z-40 flex flex-col border-t"
      style={{
        height: collapsed ? COLLAPSED_HEIGHT : height,
        borderColor: BORDER,
        background: "#0a0a0a",
      }}
    >
      {/* Resize handle */}
      {!collapsed && (
        <div
          onMouseDown={startDrag}
          className="group flex h-3 shrink-0 cursor-ns-resize items-center justify-center transition-colors hover:bg-white/5"
        >
          <GripHorizontal
            size={13}
            style={{ color: TEXT_QUIET }}
            className="group-hover:text-white"
          />
        </div>
      )}

      {/* Header */}
      <div
        className="mx-auto flex w-full max-w-[980px] shrink-0 items-center justify-between border-b px-6 py-3"
        style={{ borderColor: BORDER, fontFamily: SANS }}
      >
        <button
          onClick={() => setCollapsed((c) => !c)}
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
        </button>

        <div
          className="flex items-center gap-4 text-[12px]"
          style={{ color: TEXT_TERTIARY }}
        >
          {entries.length > 0 && (
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
          )}
          <button
            onClick={onClear}
            disabled={entries.length === 0}
            className="flex items-center gap-1 rounded-lg p-1.5 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-30"
            title="Clear console"
          >
            <Trash2 size={13} />
          </button>
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="flex items-center gap-1 rounded-lg p-1.5 transition-colors hover:bg-white/5 hover:text-white"
            title={collapsed ? "Expand" : "Collapse"}
          >
            {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>

      {/* Error breakdown strip — distinct failure causes at a glance */}
      {!collapsed && errorGroups.length > 0 && (
        <div
          className="mx-auto flex w-full max-w-[980px] shrink-0 flex-wrap items-center gap-2 border-b px-6 py-2.5"
          style={{ borderColor: BORDER, fontFamily: MONO, fontSize: 11.5 }}
        >
          {errorGroups.slice(0, 6).map((g, i) => (
            <span
              key={i}
              className="flex items-center gap-1.5 rounded-md border px-2 py-1"
              style={{ borderColor: BORDER_STRONG }}
              title={g.message}
            >
              <span className="font-bold" style={{ color: TEXT_PRIMARY }}>
                {g.status || "ERR"}
              </span>
              <span
                className="max-w-[280px] truncate"
                style={{ color: TEXT_SECONDARY }}
              >
                {g.message}
              </span>
              <span
                className="rounded border px-1.5 py-0.5 text-[10px] font-bold"
                style={{ borderColor: BORDER_STRONG, color: TEXT_PRIMARY }}
              >
                ×{g.count}
              </span>
            </span>
          ))}
          {errorGroups.length > 6 && (
            <span style={{ color: TEXT_QUIET }}>
              +{errorGroups.length - 6} more distinct errors
            </span>
          )}
        </div>
      )}

      {/* Body */}
      {!collapsed && (
        <div
          ref={bodyRef}
          onScroll={handleBodyScroll}
          className="relative mx-auto w-full max-w-[980px] flex-1 overflow-y-auto px-6 py-3.5"
          style={{ fontFamily: MONO, fontSize: 12.5, lineHeight: 1.85 }}
        >
          {entries.length === 0 ? (
            <p style={{ color: TEXT_QUIET }}>
              {isRunning
                ? "Waiting for output…"
                : "No output yet — run a load test to see execution logs here."}
            </p>
          ) : (
            entries.map((entry) => <LogLine key={entry.id} entry={entry} />)
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
      )}
    </div>
  );
}

function LogLine({ entry }: { entry: ExecutionLogEntry }) {
  const [expanded, setExpanded] = useState(false);

  const timeLabel = new Date(entry.timestamp).toLocaleTimeString([], {
    hour12: false,
    minute: "2-digit",
    second: "2-digit",
  });

  if (entry.kind === "request") {
    const hasDetail =
      !entry.ok && Boolean(entry.responseBody || entry.requestBody);

    return (
      <div className="py-0.5">
        <div
          className={`flex items-start gap-3 ${hasDetail ? "cursor-pointer" : ""}`}
          onClick={() => hasDetail && setExpanded((e) => !e)}
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
              className="shrink-0 truncate"
              style={{ color: TEXT_TERTIARY }}
            >
              {entry.method} {entry.url}
            </span>
          )}
          {!entry.ok && entry.responseBodySummary && (
            <span className="truncate" style={{ color: TEXT_SECONDARY }}>
              — {entry.responseBodySummary}
            </span>
          )}
          {hasDetail && (
            <span className="ml-auto shrink-0" style={{ color: TEXT_TERTIARY }}>
              {expanded ? (
                <ChevronDown size={12} />
              ) : (
                <ChevronRight size={12} />
              )}
            </span>
          )}
        </div>

        {expanded && hasDetail && (
          <div
            className="ml-[3.1rem] mt-1.5 mb-1 space-y-2 rounded-lg border p-3"
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
      <div className="py-0.5">
        <div
          className="flex items-start gap-3 cursor-pointer"
          onClick={() => setExpanded((e) => !e)}
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
          <span className="truncate" style={{ color: TEXT_TERTIARY }}>
            — {entry.message}
          </span>
          {entry.stack && (
            <span className="ml-auto shrink-0" style={{ color: TEXT_TERTIARY }}>
              {expanded ? (
                <ChevronDown size={12} />
              ) : (
                <ChevronRight size={12} />
              )}
            </span>
          )}
        </div>
        {expanded && entry.stack && (
          <div
            className="ml-[3.1rem] mt-1.5 mb-1 rounded-lg border p-3"
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
    <div className="flex items-start gap-3 py-0.5">
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
        className="whitespace-pre-wrap break-all"
        style={{ color: isErr ? TEXT_PRIMARY : TEXT_SECONDARY }}
      >
        {entry.message}
      </span>
    </div>
  );
}
