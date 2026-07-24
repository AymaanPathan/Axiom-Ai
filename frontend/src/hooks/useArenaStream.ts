// hooks/useArenaStream.ts
import { useEffect, useRef, useState, useCallback } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  ArenaResult,
  ArenaStage,
  ArenaCandidateStatusEvent,
  ArenaMetricSampleEvent,
  RouteTelemetry,
} from "../api/repos";

const BACKEND_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ||
  "http://localhost:5000";

export interface CandidateLiveStats {
  sent: number;
  successCount: number;
  errorCount: number;
  avgDurationMs: number;
  lastStatus?: number;
  lastOk?: boolean;
}

export interface ArenaRequestLogEntry {
  index: number;
  status: number;
  ok: boolean;
  method: string | null;
  url: string | null;
  durationMs: number | null;
  responseBodySummary: string | null;
  timestamp: number;
}

export interface CandidateLiveState {
  strategyId: string;
  stage: ArenaStage;
  message?: string;
  error?: string;
  runId?: string;
  stageEnteredAt: number;
  metrics: { cpuPercent: number; memoryMB: number; timestamp: number }[];
  logs: string[];
  liveStats?: CandidateLiveStats;
  requestLog: ArenaRequestLogEntry[];
  telemetry?: RouteTelemetry;
  telemetryHistory: { time: number; p50: number; p95: number }[];
}

interface RunLogEvent {
  runId: string;
  stream: "stdout" | "stderr";
  chunk: string;
}

interface ArenaCandidateProgressEvent {
  strategyId: string;
  status: "running";
  sent: number;
  successCount: number;
  errorCount: number;
  avgDurationMs: number;
  lastStatus?: number;
  lastOk?: boolean;
}

interface ArenaCandidateLogEventRaw {
  strategyId: string;
  index: number;
  status: number;
  ok: boolean;
  method: string | null;
  url: string | null;
  durationMs: number | null;
  responseBodySummary: string | null;
  timestamp: number;
}

interface ArenaCandidateTelemetryEventRaw {
  strategyId: string;
  telemetry: RouteTelemetry;
}

export type PrewarmState =
  | { status: "idle" }
  | { status: "running"; message: string }
  | { status: "done"; cached: boolean };

export function useArenaStream(arenaId: string | null) {
  const [candidates, setCandidates] = useState<
    Record<string, CandidateLiveState>
  >({});
  const [prewarm, setPrewarm] = useState<PrewarmState>({ status: "idle" });
  const [result, setResult] = useState<ArenaResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const joinedRunRooms = useRef<Set<string>>(new Set());

  const upsert = useCallback(
    (strategyId: string, patch: Partial<CandidateLiveState>) => {
      setCandidates((prev) => {
        const existing: CandidateLiveState = prev[strategyId] ?? {
          strategyId,
          stage: "queued",
          stageEnteredAt: Date.now(),
          metrics: [],
          logs: [],
          requestLog: [],
          telemetryHistory: [],
        };
        return {
          ...prev,
          [strategyId]: {
            ...existing,
            ...patch,
            stageEnteredAt:
              patch.stage && patch.stage !== existing.stage
                ? Date.now()
                : existing.stageEnteredAt,
          },
        };
      });
    },
    [],
  );

  useEffect(() => {
    if (!arenaId) return;

    setCandidates({});
    setPrewarm({ status: "idle" });
    setResult(null);
    setError(null);
    joinedRunRooms.current = new Set();

    const socket: Socket = io(BACKEND_URL, {
      withCredentials: true,
      transports: ["websocket", "polling"],
    });

    socket.on("connect", () => {
      socket.emit("arena:subscribe", arenaId);
    });

    socket.on("arena:prewarm", (payload: { message?: string }) => {
      setPrewarm({
        status: "running",
        message: payload.message ?? "Installing dependencies…",
      });
    });

    socket.on("arena:prewarm:done", (payload: { cached: boolean }) => {
      setPrewarm({ status: "done", cached: payload.cached });
    });

    socket.on(
      "arena:candidate:status",
      (payload: ArenaCandidateStatusEvent) => {
        // Entering a fresh stage for a strategy we've seen before (e.g.
        // re-run) should reset per-run data, not append onto stale data.
        setCandidates((prev) => {
          const existing = prev[payload.strategyId];
          const isFreshStart = payload.stage === "copying";
          const base: CandidateLiveState = existing ?? {
            strategyId: payload.strategyId,
            stage: "queued",
            stageEnteredAt: Date.now(),
            metrics: [],
            logs: [],
            requestLog: [],
            telemetryHistory: [],
          };
          return {
            ...prev,
            [payload.strategyId]: {
              ...base,
              stage: payload.stage,
              message: payload.message,
              error: payload.error,
              runId: payload.runId,
              liveStats: undefined,
              stageEnteredAt:
                payload.stage !== base.stage ? Date.now() : base.stageEnteredAt,
              ...(isFreshStart
                ? { metrics: [], logs: [], requestLog: [], telemetryHistory: [] }
                : {}),
            },
          };
        });
        if (payload.runId && !joinedRunRooms.current.has(payload.runId)) {
          joinedRunRooms.current.add(payload.runId);
          socket.emit("run:subscribe", payload.runId);
        }
      },
    );

    socket.on(
      "arena:candidate:progress",
      (payload: ArenaCandidateProgressEvent) => {
        upsert(payload.strategyId, {
          liveStats: {
            sent: payload.sent,
            successCount: payload.successCount,
            errorCount: payload.errorCount,
            avgDurationMs: payload.avgDurationMs,
            lastStatus: payload.lastStatus,
            lastOk: payload.lastOk,
          },
        });
      },
    );

    socket.on("arena:candidate:log", (payload: ArenaCandidateLogEventRaw) => {
      setCandidates((prev) => {
        const existing = prev[payload.strategyId];
        if (!existing) return prev;
        const requestLog = [
          ...existing.requestLog,
          {
            index: payload.index,
            status: payload.status,
            ok: payload.ok,
            method: payload.method,
            url: payload.url,
            durationMs: payload.durationMs,
            responseBodySummary: payload.responseBodySummary,
            timestamp: payload.timestamp,
          },
        ].slice(-200);
        return { ...prev, [payload.strategyId]: { ...existing, requestLog } };
      });
    });

    socket.on(
      "arena:candidate:telemetry",
      (payload: ArenaCandidateTelemetryEventRaw) => {
        setCandidates((prev) => {
          const existing = prev[payload.strategyId];
          if (!existing) return prev;
          const telemetryHistory = [
            ...existing.telemetryHistory,
            {
              time: Date.now(),
              p50: payload.telemetry.latencyMs.p50,
              p95: payload.telemetry.latencyMs.p95,
            },
          ].slice(-40);
          return {
            ...prev,
            [payload.strategyId]: {
              ...existing,
              telemetry: payload.telemetry,
              telemetryHistory,
            },
          };
        });
      },
    );

    socket.on("arena:candidate:metrics", (payload: ArenaMetricSampleEvent) => {
      setCandidates((prev) => {
        const existing = prev[payload.strategyId];
        if (!existing) return prev;
        const metrics = [
          ...existing.metrics,
          {
            cpuPercent: payload.cpuPercent,
            memoryMB: payload.memoryMB,
            timestamp: payload.timestamp,
          },
        ].slice(-40);
        return { ...prev, [payload.strategyId]: { ...existing, metrics } };
      });
    });

    socket.on("run:log", (payload: RunLogEvent) => {
      setCandidates((prev) => {
        const match = Object.values(prev).find(
          (c) => c.runId === payload.runId,
        );
        if (!match) return prev;
        const logs = [...match.logs, payload.chunk].slice(-300);
        return { ...prev, [match.strategyId]: { ...match, logs } };
      });
    });

    socket.on(
      "arena:complete",
      (payload: { arenaId: string; result: ArenaResult }) => {
        setResult(payload.result);
      },
    );

    socket.on("arena:error", (payload: { error: string }) => {
      setError(payload.error);
    });

    socket.on("connect_error", (err) => {
      setError(`Couldn't reach the backend at ${BACKEND_URL}: ${err.message}`);
    });

    return () => {
      socket.emit("arena:unsubscribe", arenaId);
      for (const runId of joinedRunRooms.current) {
        socket.emit("run:unsubscribe", runId);
      }
      socket.disconnect();
    };
  }, [arenaId, upsert]);

  return { candidates, prewarm, result, error };
}