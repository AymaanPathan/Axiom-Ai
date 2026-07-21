import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { MetricSnapshot } from "../api/observability";

export interface ServiceLogLine {
  stream: "stdout" | "stderr";
  chunk: string;
  timestamp: number;
}

interface UseServiceObserverResult {
  connected: boolean;
  logs: ServiceLogLine[];
  latestMetric: MetricSnapshot | null;
  metricHistory: MetricSnapshot[];
  clearLogs: () => void;
  seedMetricHistory: (points: MetricSnapshot[]) => void;
}

const MAX_LOG_LINES = 2000;
const MAX_METRIC_POINTS = 180; // ~15 min at 5s push interval

export function useServiceObserver(
  repositoryId: string | null,
): UseServiceObserverResult {
  const [connected, setConnected] = useState(false);
  const [logs, setLogs] = useState<ServiceLogLine[]>([]);
  const [metricHistory, setMetricHistory] = useState<MetricSnapshot[]>([]);
  const socketRef = useRef<Socket | null>(null);
  const seededRef = useRef(false);

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
    // Called once after the REST backfill resolves, so charts aren't empty
    // for the first ~15 min while waiting on live socket pushes.
    seedMetricHistory: (points: MetricSnapshot[]) => {
      if (seededRef.current) return;
      seededRef.current = true;
      setMetricHistory((prev) =>
        prev.length ? prev : points.slice(-MAX_METRIC_POINTS),
      );
    },
  };
}
