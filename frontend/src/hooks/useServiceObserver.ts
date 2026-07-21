import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { MetricSnapshot } from "../api/observability";

export interface ServiceLogLine {
  stream: "stdout" | "stderr";
  chunk: string;
  timestamp: number;
}

export interface RunStatusEvent {
  runId: string;
  status: "starting" | "installing" | "running" | "exited" | "error";
  exitCode?: number;
}

interface UseServiceObserverResult {
  connected: boolean;
  logs: ServiceLogLine[];
  latestMetric: MetricSnapshot | null;
  metricHistory: MetricSnapshot[];
  clearLogs: () => void;
  seedMetricHistory: (points: MetricSnapshot[]) => void;
  // Boot tracking for a specific run
  bootLogs: ServiceLogLine[];
  runStatus: RunStatusEvent | null;
  trackRun: (runId: string) => void;
}

const MAX_LOG_LINES = 2000;
const MAX_METRIC_POINTS = 180; // ~15 min at 5s push interval
const MAX_BOOT_LOG_LINES = 500;

export function useServiceObserver(
  repositoryId: string | null,
): UseServiceObserverResult {
  const [connected, setConnected] = useState(false);
  const [logs, setLogs] = useState<ServiceLogLine[]>([]);
  const [metricHistory, setMetricHistory] = useState<MetricSnapshot[]>([]);
  const [bootLogs, setBootLogs] = useState<ServiceLogLine[]>([]);
  const [runStatus, setRunStatus] = useState<RunStatusEvent | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const seededRef = useRef(false);
  const trackedRunIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!repositoryId) return;
    seededRef.current = false;

    const socket = io(import.meta.env.VITE_API_URL, { withCredentials: true });
    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));

    socket.emit("service:subscribe", repositoryId);

    socket.on(
      "service:log",
      (payload: {
        repositoryId: string;
        stream: "stdout" | "stderr";
        chunk: string;
        timestamp: number;
      }) => {
        if (payload.repositoryId !== repositoryId) return;
        setLogs((prev) => {
          const next = [
            ...prev,
            {
              stream: payload.stream,
              chunk: payload.chunk,
              timestamp: payload.timestamp,
            },
          ];
          return next.length > MAX_LOG_LINES
            ? next.slice(next.length - MAX_LOG_LINES)
            : next;
        });
      },
    );

    socket.on(
      "service:metrics",
      (payload: MetricSnapshot & { repositoryId: string }) => {
        if (payload.repositoryId !== repositoryId) return;
        setMetricHistory((prev) => {
          const next = [...prev, payload];
          return next.length > MAX_METRIC_POINTS
            ? next.slice(next.length - MAX_METRIC_POINTS)
            : next;
        });
      },
    );

    // Boot-time events — scoped to whatever runId trackRun() was last
    // called with. Fired by the server's `emitBoth` in docker-run.service.ts
    // as the container moves through starting -> installing -> running.
    socket.on("run:status", (payload: RunStatusEvent) => {
      if (payload.runId !== trackedRunIdRef.current) return;
      setRunStatus(payload);
    });

    socket.on(
      "run:log",
      (payload: {
        runId: string;
        stream: "stdout" | "stderr";
        chunk: string;
      }) => {
        if (payload.runId !== trackedRunIdRef.current) return;
        setBootLogs((prev) => {
          const next = [
            ...prev,
            {
              stream: payload.stream,
              chunk: payload.chunk,
              timestamp: Date.now(),
            },
          ];
          return next.length > MAX_BOOT_LOG_LINES
            ? next.slice(next.length - MAX_BOOT_LOG_LINES)
            : next;
        });
      },
    );

    return () => {
      socket.emit("service:unsubscribe", repositoryId);
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [repositoryId]);

  return {
    connected,
    logs,
    latestMetric: metricHistory.length
      ? metricHistory[metricHistory.length - 1]
      : null,
    metricHistory,
    clearLogs: () => setLogs([]),
    seedMetricHistory: (points: MetricSnapshot[]) => {
      if (seededRef.current) return;
      seededRef.current = true;
      setMetricHistory((prev) =>
        prev.length ? prev : points.slice(-MAX_METRIC_POINTS),
      );
    },
    bootLogs,
    runStatus,
    // Call this right after startRun() resolves with a new runId, so the
    // socket listeners above start attributing events to this run and the
    // modal has a clean log slate.
    trackRun: (runId: string) => {
      trackedRunIdRef.current = runId;
      setBootLogs([]);
      setRunStatus(null);
    },
  };
}
