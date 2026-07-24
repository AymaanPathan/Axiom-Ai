// hooks/useServiceMetrics.ts
import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

export interface ServiceMetricSnapshot {
  timestamp: number;
  cpuPercent: number;
  memoryMB: number;
  requestRate: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

const MAX_POINTS = 60; // ~5 min at the backend's 5s push interval

// Mirrors useTrafficStream's connection pattern exactly — same socket
// server, same service:subscribe/unsubscribe room join. The backend's
// metrics-observer.service.ts pushes "service:metrics" into
// `repo:${repositoryId}` on its own 5s interval for as long as a
// container is running for this repo, independent of any load test.
export function useServiceMetrics(repositoryId: string | null) {
  const socketRef = useRef<Socket | null>(null);
  const [history, setHistory] = useState<ServiceMetricSnapshot[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!repositoryId) return;

    const socket = io(import.meta.env.VITE_API_URL, { withCredentials: true });
    socketRef.current = socket;

    socket.emit("service:subscribe", repositoryId);

    socket.on(
      "service:metrics",
      (payload: ServiceMetricSnapshot & { repositoryId: string }) => {
        if (payload.repositoryId !== repositoryId) return;
        setConnected(true);
        setHistory((prev) =>
          [
            ...prev,
            {
              timestamp: payload.timestamp,
              cpuPercent: payload.cpuPercent,
              memoryMB: payload.memoryMB,
              requestRate: payload.requestRate,
              errorRate: payload.errorRate,
              p50Ms: payload.p50Ms,
              p95Ms: payload.p95Ms,
              p99Ms: payload.p99Ms,
            },
          ].slice(-MAX_POINTS),
        );
      },
    );

    return () => {
      socket.emit("service:unsubscribe", repositoryId);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [repositoryId]);

  const reset = () => {
    setHistory([]);
    setConnected(false);
  };

  return {
    history,
    latest: history[history.length - 1] ?? null,
    connected,
    reset,
  };
}
