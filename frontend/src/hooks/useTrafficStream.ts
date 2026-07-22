// hooks/useTrafficStream.ts
import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

export interface TrafficProgress {
  status: "starting" | "running" | "done";
  total: number; // -1 means "unknown / duration-based", not count-based
  sent: number;
  successCount?: number;
  errorCount?: number;
}

// A single line in the execution console — a sampled per-request result
// (from RESULT: lines), raw script/process output (stdout/stderr), or a
// structured script-level exception (from SCRIPT_ERROR: lines — a bug in
// the generated script itself, not an HTTP failure). Unioned + given a
// monotonic client-side id so all three kinds render in one true
// chronological feed instead of disconnected lists.
export type ExecutionLogEntry =
  | {
      id: number;
      kind: "request";
      index: number;
      status: number;
      ok: boolean;
      method: string | null;
      url: string | null;
      requestBody: string | null;
      responseBodySummary: string | null;
      responseBody: string | null;
      timestamp: number;
    }
  | {
      id: number;
      kind: "console";
      stream: "stdout" | "stderr";
      message: string;
      timestamp: number;
    }
  | {
      id: number;
      kind: "script_error";
      message: string;
      stack: string | null;
      timestamp: number;
    };

interface RawTrafficLogEntry {
  index: number;
  status: number;
  ok: boolean;
  method: string | null;
  url: string | null;
  requestBody: string | null;
  responseBodySummary: string | null;
  responseBody: string | null;
  timestamp: number;
}

interface RawConsoleEntry {
  stream: "stdout" | "stderr";
  message: string;
  timestamp: number;
}

interface RawScriptErrorEntry {
  message: string;
  stack: string | null;
  timestamp: number;
}

export function useTrafficStream(repositoryId: string | null) {
  const socketRef = useRef<Socket | null>(null);
  const nextId = useRef(0);
  const [entries, setEntries] = useState<ExecutionLogEntry[]>([]);
  const [progress, setProgress] = useState<TrafficProgress | null>(null);

  useEffect(() => {
    if (!repositoryId) return;

    // Matches useServiceObserver's connection exactly — same server,
    // same room-join mechanism (server puts this socket into
    // `repo:${repositoryId}` on "service:subscribe", and that's the same
    // room loadScriptRunner.service.ts emits traffic:* events into), so
    // both hooks ride the same subscription pattern.
    const socket = io(import.meta.env.VITE_API_URL, { withCredentials: true });
    socketRef.current = socket;

    socket.emit("service:subscribe", repositoryId);

    socket.on("traffic:log", (entry: RawTrafficLogEntry) =>
      setEntries((prev) => [
        ...prev,
        { id: nextId.current++, kind: "request", ...entry },
      ]),
    );

    socket.on("traffic:console", (entry: RawConsoleEntry) =>
      setEntries((prev) => [
        ...prev,
        { id: nextId.current++, kind: "console", ...entry },
      ]),
    );

    socket.on("traffic:script-error", (entry: RawScriptErrorEntry) =>
      setEntries((prev) => [
        ...prev,
        { id: nextId.current++, kind: "script_error", ...entry },
      ]),
    );

    socket.on("traffic:progress", (p: TrafficProgress) => setProgress(p));

    return () => {
      socket.emit("service:unsubscribe", repositoryId);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [repositoryId]);

  // Called right before a new run starts so the console only ever shows
  // logs from the test that's currently (or most recently) executing.
  const reset = () => {
    setEntries([]);
    setProgress(null);
  };

  return { entries, progress, reset };
}
