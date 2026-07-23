import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Loader2,
  Minus,
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

const DEFAULT_WIDTH = 380;
const DEFAULT_HEIGHT = 320;
const MIN_WIDTH = 300;
const MIN_HEIGHT = 180;
const MAX_WIDTH = 860;
const MAX_HEIGHT = 720;
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
  const [panelOpen, setPanelOpen] = useState(false);
  const [dims, setDims] = useState({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  const [autoScroll, setAutoScroll] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    startW: number;
    startH: number;
  } | null>(null);
  const prevStatusRef = useRef<string | null>(null);

  const isRunning =
    progress?.status === "starting" || progress?.status === "running";

  // Auto-open the console the moment a run actually starts, so you don't
  // have to remember to click it — but once minimized, it stays out of
  // the way for the rest of that run.
  useEffect(() => {
    const prev = prevStatusRef.current;
    if (
      progress?.status === "starting" &&
      prev !== "starting" &&
      prev !== "running"
    ) {
      setPanelOpen(true);
    }
    prevStatusRef.current = progress?.status ?? null;
  }, [progress?.status]);

  useEffect(() => {
    if (!autoScroll || !panelOpen) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, autoScroll, panelOpen]);

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

  // --- resize: drag the top-left corner handle. The panel is pinned to
  // the bottom-right of the viewport, so dragging left/up grows it. ---
  const handleResizeMove = (e: MouseEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const nextWidth = drag.startW + (drag.startX - e.clientX);
    const nextHeight = drag.startH + (drag.startY - e.clientY);
    setDims({
      width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, nextWidth)),
      height: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, nextHeight)),
    });
  };

  const handleResizeEnd = () => {
    dragRef.current = null;
    window.removeEventListener("mousemove", handleResizeMove);
    window.removeEventListener("mouseup", handleResizeEnd);
  };

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startW: dims.width,
      startH: dims.height,
    };
    window.addEventListener("mousemove", handleResizeMove);
    window.addEventListener("mouseup", handleResizeEnd);
  };

  useEffect(() => {
    return () => {
      window.removeEventListener("mousemove", handleResizeMove);
      window.removeEventListener("mouseup", handleResizeEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const successCount =
    progress?.successCount ??
    entries.filter((e) => e.kind === "request" && e.ok).length;
  const errorCount =
    progress?.errorCount ??
    entries.filter((e) => e.kind === "request" && !e.ok).length;
  const scriptErrorCount = entries.filter(
    (e) => e.kind === "script_error",
  ).length;

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

  // --- collapsed: small pill, bottom right ---
  if (!panelOpen) {
    return (
      <button
        onClick={() => setPanelOpen(true)}
        className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full border px-4 py-2.5 text-[12.5px] font-semibold shadow-lg transition-colors hover:border-[#454545]"
        style={{
          borderColor: BORDER_STRONG,
          background: "#111111",
          color: TEXT_PRIMARY,
          fontFamily: SANS,
        }}
      >
        {isRunning ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <Terminal size={13} style={{ color: TEXT_TERTIARY }} />
        )}
        Console
        {entries.length > 0 && (
          <span
            className="rounded-full px-1.5 py-0.5 text-[10.5px] font-bold"
            style={{
              background: errorCount > 0 ? "#f29b9b" : BORDER_STRONG,
              color: errorCount > 0 ? "#1a0808" : TEXT_SECONDARY,
            }}
          >
            {entries.length}
          </span>
        )}
      </button>
    );
  }

  // --- expanded: resizable floating panel, bottom right ---
  return (
    <div
      className="fixed bottom-5 right-5 z-40 flex flex-col overflow-hidden rounded-xl border shadow-2xl"
      style={{
        width: dims.width,
        height: dims.height,
        borderColor: BORDER_STRONG,
        background: "#0a0a0a",
      }}
    >
      <div
        onMouseDown={handleResizeStart}
        className="absolute left-0 top-0 z-10 h-4 w-4 cursor-nwse-resize"
        title="Drag to resize"
      >
        <div
          className="absolute left-1 top-1 h-2 w-2 rounded-sm"
          style={{ background: BORDER_STRONG }}
        />
      </div>

      <div
        className="flex shrink-0 items-center justify-between border-b py-2.5 pl-5 pr-3.5"
        style={{ borderColor: BORDER, fontFamily: SANS }}
      >
        <div
          className="flex items-center gap-2 text-[12.5px] font-semibold"
          style={{ color: TEXT_PRIMARY }}
        >
          <Terminal size={13} style={{ color: TEXT_TERTIARY }} />
          Console
          {isRunning && (
            <span
              className="flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em]"
              style={{ borderColor: BORDER_STRONG, color: TEXT_PRIMARY }}
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
              live
            </span>
          )}
        </div>
        <div className="flex items-center gap-1" style={{ color: TEXT_TERTIARY }}>
          <button
            onClick={onClear}
            disabled={entries.length === 0}
            className="flex items-center gap-1 rounded-lg p-1.5 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-30"
            title="Clear console"
          >
            <Trash2 size={12} />
          </button>
          <button
            onClick={() => setPanelOpen(false)}
            className="flex items-center gap-1 rounded-lg p-1.5 transition-colors hover:bg-white/5 hover:text-white"
            title="Minimize"
          >
            <Minus size={13} />
          </button>
        </div>
      </div>

      {entries.length > 0 && (
        <div
          className="flex shrink-0 items-center gap-3 border-b px-3.5 py-2 text-[11.5px]"
          style={{ borderColor: BORDER, color: TEXT_TERTIARY, fontFamily: MONO }}
        >
          <span style={{ color: TEXT_PRIMARY }}>{successCount} ok</span>
          {errorCount > 0 && (
            <span style={{ color: TEXT_PRIMARY, fontWeight: 700 }}>
              {errorCount} err
            </span>
          )}
          {scriptErrorCount > 0 && (
            <span style={{ color: TEXT_SECONDARY }}>
              {scriptErrorCount} script err
            </span>
          )}
        </div>
      )}

      {errorGroups.length > 0 && (
        <div
          className="flex shrink-0 flex-col gap-1.5 border-b px-3.5 py-2"
          style={{ borderColor: BORDER, fontFamily: MONO, fontSize: 11 }}
        >
          {errorGroups.slice(0, 3).map((g, i) => (
            <span
              key={i}
              className="flex items-center gap-1.5 rounded-md border px-2 py-1"
              style={{ borderColor: BORDER_STRONG }}
              title={g.message}
            >
              <span className="shrink-0 font-bold" style={{ color: TEXT_PRIMARY }}>
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
          {errorGroups.length > 3 && (
            <span style={{ color: TEXT_QUIET }}>
              +{errorGroups.length - 3} more distinct errors
            </span>
          )}
        </div>
      )}

      <div
        ref={bodyRef}
        onScroll={handleBodyScroll}
        className="relative flex-1 overflow-y-auto px-3.5 py-3"
        style={{ fontFamily: MONO, fontSize: 12, lineHeight: 1.75 }}
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
            className="sticky bottom-1 left-full ml-auto flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] font-medium shadow-lg transition-colors"
            style={{
              borderColor: BORDER_STRONG,
              color: TEXT_PRIMARY,
              background: "#111111",
              fontFamily: SANS,
            }}
          >
            <ChevronDown size={11} />
            Jump to latest
          </button>
        )}
      </div>
    </div>
  );
}

function LogLine({ entry }: { entry: ExecutionLogEntry }) {
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
          className={`flex flex-wrap items-start gap-x-2 gap-y-0.5 ${hasDetail ? "cursor-pointer" : ""}`}
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
            <span className="min-w-0 truncate" style={{ color: TEXT_TERTIARY }}>
              {entry.method} {entry.url}
            </span>
          )}
          {hasDetail && (
            <span className="ml-auto shrink-0" style={{ color: TEXT_TERTIARY }}>
              {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            </span>
          )}
          {!entry.ok && entry.responseBodySummary && (
            <span className="w-full truncate pl-[3rem]" style={{ color: TEXT_SECONDARY }}>
              {entry.responseBodySummary}
            </span>
          )}
        </div>

        {open && hasDetail && (
          <div
            className="mt-1.5 mb-1 space-y-2 rounded-lg border p-2.5"
            style={{ borderColor: BORDER, background: "#0d0d0d" }}
          >
            {entry.requestBody && (
              <div>
                <div
                  className="mb-1 text-[10px] font-bold uppercase tracking-[0.06em]"
                  style={{ color: TEXT_TERTIARY }}
                >
                  Request payload
                </div>
                <pre className="whitespace-pre-wrap break-all" style={{ color: TEXT_SECONDARY }}>
                  {entry.requestBody}
                </pre>
              </div>
            )}
            {entry.responseBody && (
              <div>
                <div
                  className="mb-1 text-[10px] font-bold uppercase tracking-[0.06em]"
                  style={{ color: TEXT_TERTIARY }}
                >
                  Failure detail
                </div>
                <pre className="whitespace-pre-wrap break-all" style={{ color: TEXT_PRIMARY }}>
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
          className="flex items-start gap-2 cursor-pointer"
          onClick={() => setOpen((o) => !o)}
        >
          <span className="shrink-0" style={{ color: TEXT_QUIET }}>
            {timeLabel}
          </span>
          <AlertTriangle size={12} className="mt-0.5 shrink-0" style={{ color: TEXT_SECONDARY }} />
          <span className="shrink-0 font-semibold" style={{ color: TEXT_SECONDARY }}>
            script error
          </span>
          <span className="min-w-0 truncate" style={{ color: TEXT_TERTIARY }}>
            {entry.message}
          </span>
          {entry.stack && (
            <span className="ml-auto shrink-0" style={{ color: TEXT_TERTIARY }}>
              {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            </span>
          )}
        </div>
        {open && entry.stack && (
          <div
            className="mt-1.5 mb-1 rounded-lg border p-2.5"
            style={{ borderColor: BORDER, background: "#0d0d0d" }}
          >
            <div
              className="mb-1 text-[10px] font-bold uppercase tracking-[0.06em]"
              style={{ color: TEXT_TERTIARY }}
            >
              Stack trace — bug in the generated script, not an HTTP error
            </div>
            <pre className="whitespace-pre-wrap break-all" style={{ color: TEXT_SECONDARY }}>
              {entry.stack}
            </pre>
          </div>
        )}
      </div>
    );
  }

  const isErr = entry.stream === "stderr";
  return (
    <div className="flex items-start gap-2 py-1">
      <span className="shrink-0" style={{ color: TEXT_QUIET }}>
        {timeLabel}
      </span>
      <span className="shrink-0 font-semibold" style={{ color: isErr ? TEXT_PRIMARY : TEXT_TERTIARY }}>
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