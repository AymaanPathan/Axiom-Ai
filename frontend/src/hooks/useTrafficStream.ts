import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

export interface TrafficLogEntry {
  index: number;
  total: number;
  method: string;
  routePath: string;
  status: number;
  ok: boolean;
  responseBody: string | null;
  timestamp: number;
}

export interface TrafficProgress {
  status: "starting" | "running" | "done";
  total: number;
  sent: number;
  successCount?: number;
  errorCount?: number;
}

export function useTrafficStream(repositoryId: string | null) {
  const socketRef = useRef<Socket | null>(null);
  const [logs, setLogs] = useState<TrafficLogEntry[]>([]);
  const [progress, setProgress] = useState<TrafficProgress | null>(null);

  useEffect(() => {
    if (!repositoryId) return;

    // Matches useServiceObserver's connection exactly — same server,
    // same room-join mechanism (server puts this socket into
    // `repo:${repositoryId}` on "service:subscribe", and that's the same
    // room trafficGenerator.service.ts emits traffic:log/traffic:progress
    // into), so both hooks now ride the same subscription pattern.
    const socket = io(import.meta.env.VITE_API_URL, { withCredentials: true });
    socketRef.current = socket;

    socket.emit("service:subscribe", repositoryId);

    socket.on("traffic:log", (entry: TrafficLogEntry) =>
      setLogs((prev) => [...prev, entry]),
    );
    socket.on("traffic:progress", (p: TrafficProgress) => setProgress(p));

    return () => {
      socket.emit("service:unsubscribe", repositoryId);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [repositoryId]);

  const reset = () => {
    setLogs([]);
    setProgress(null);
  };

  return { logs, progress, reset };
}
