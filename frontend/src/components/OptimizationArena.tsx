// components/OptimizationArena.tsx
import { useState } from "react";
import { Play, Trophy, Cpu, MemoryStick, XCircle } from "lucide-react";
import type { OptimizationStrategy, ArenaResult } from "../api/repos";
import ArenaLive from "./ArenaLive";
import {
  MONO,
  SURFACE,
  SURFACE_RAISED,
  BORDER_STRONG,
  TEXT_PRIMARY,
  TEXT_SECONDARY,
  TEXT_TERTIARY,
  ERROR,
  GOLD,
} from "../theme";

interface Props {
  repositoryId: string;
  routeIndex: number;
  routeLabel: string; 
  strategies: OptimizationStrategy[];
  script: string;
  authToken?: string;
}

const RANK_ICON_COLOR = [GOLD, "#c9cad0", "#c98a4d"];

export default function OptimizationArena({
  repositoryId,
  routeIndex,
  routeLabel,
  strategies,
  script,
  authToken,
}: Props) {
  const [arenaOpen, setArenaOpen] = useState(false);
  const [result, setResult] = useState<ArenaResult | null>(null);

  return (
    <div>
      <div className="grid gap-3 md:grid-cols-3">
        {strategies.map((s) => (
          <div
            key={s.id}
            className="rounded-xl border p-4"
            style={{ borderColor: BORDER_STRONG, background: SURFACE }}
          >
            <div className="flex items-center justify-between">
              <span
                className="text-[11px] font-bold uppercase tracking-[0.06em]"
                style={{ color: TEXT_TERTIARY }}
              >
                Strategy {s.id}
              </span>
              <span
                className="rounded border px-1.5 py-0.5 text-[10px]"
                style={{ borderColor: BORDER_STRONG, color: TEXT_SECONDARY }}
              >
                {s.confidence} confidence
              </span>
            </div>
            <p
              className="mt-1.5 text-[14px] font-semibold"
              style={{ color: TEXT_PRIMARY }}
            >
              {s.title}
            </p>
            <p
              className="mt-1 text-[12.5px] leading-[1.55]"
              style={{ color: TEXT_SECONDARY }}
            >
              {s.description}
            </p>
            <div
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11.5px] font-bold"
              style={{ background: "#fff", color: "#0a0a0a" }}
            >
              +{s.estimatedImprovementPercent.min}–
              {s.estimatedImprovementPercent.max}% estimated
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={() => setArenaOpen(true)}
        className="mt-4 flex items-center gap-1.5 rounded-lg bg-white px-4 py-2 text-[12.5px] font-bold text-black transition-colors hover:bg-[#e5e5e5]"
      >
        <Play size={13} />
        {result ? "Run again" : "Run all strategies head-to-head"}
      </button>

      {/* Compact summary of the last run, once the takeover has been
          closed — the takeover itself is where the live/verbose view
          lives; this is just "what happened last time" at a glance. */}
      {result && !arenaOpen && (
        <div className="mt-4 flex flex-col gap-2">
          {[...result.candidates]
            .sort((a, b) => {
              if (a.status === "failed" && b.status !== "failed") return 1;
              if (b.status === "failed" && a.status !== "failed") return -1;
              return (b.score ?? -Infinity) - (a.score ?? -Infinity);
            })
            .map((c, i) => {
              const isWinner = c.strategyId === result.winnerStrategyId;
              const failed = c.status === "failed";
              return (
                <div
                  key={c.strategyId}
                  className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border px-4 py-3"
                  style={{
                    borderColor: isWinner ? GOLD : BORDER_STRONG,
                    background: isWinner ? "#1c1a12" : SURFACE_RAISED,
                  }}
                >
                  <div className="flex min-w-[170px] items-center gap-3">
                    <span
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold"
                      style={{
                        borderColor: BORDER_STRONG,
                        color: i < 3 ? RANK_ICON_COLOR[i] : TEXT_TERTIARY,
                      }}
                    >
                      {failed ? (
                        <XCircle size={14} style={{ color: ERROR }} />
                      ) : (
                        i + 1
                      )}
                    </span>
                    <div className="min-w-0">
                      <div
                        className="truncate text-[13px] font-semibold"
                        style={{ color: TEXT_PRIMARY, fontFamily: MONO }}
                      >
                        {c.title}
                      </div>
                      <div
                        className="text-[10.5px]"
                        style={{ color: TEXT_TERTIARY }}
                      >
                        Strategy {c.strategyId}
                      </div>
                    </div>
                    {isWinner && (
                      <span
                        className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em]"
                        style={{ background: GOLD, color: "#1a1400" }}
                      >
                        <Trophy size={11} /> Best
                      </span>
                    )}
                  </div>
                  {failed ? (
                    <span className="text-[12px]" style={{ color: ERROR }}>
                      Failed: {c.error}
                    </span>
                  ) : (
                    <div
                      className="flex flex-wrap items-center gap-4 text-[12.5px]"
                      style={{ fontFamily: MONO }}
                    >
                      <span style={{ color: TEXT_SECONDARY }}>
                        avg{" "}
                        {c.runResult
                          ? `${Math.round(c.runResult.avgDurationMs)}ms`
                          : "—"}
                      </span>
                      {c.cpuPercent != null && (
                        <span
                          className="flex items-center gap-1"
                          style={{ color: TEXT_SECONDARY }}
                        >
                          <Cpu size={11} /> {c.cpuPercent}%
                        </span>
                      )}
                      {c.memoryMB != null && (
                        <span
                          className="flex items-center gap-1"
                          style={{ color: TEXT_SECONDARY }}
                        >
                          <MemoryStick size={11} /> {Math.round(c.memoryMB)}MB
                        </span>
                      )}
                      <span
                        className="rounded-lg border px-2.5 py-1 font-bold"
                        style={{
                          borderColor: isWinner ? GOLD : BORDER_STRONG,
                          color: isWinner ? GOLD : TEXT_PRIMARY,
                        }}
                      >
                        score {c.score ?? "—"}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      )}

      {arenaOpen && (
        <ArenaLive
          repositoryId={repositoryId}
          routeIndex={routeIndex}
          routeLabel={routeLabel}
          strategies={strategies}
          script={script}
          authToken={authToken}
          onComplete={setResult}
          onClose={() => setArenaOpen(false)}
        />
      )}
    </div>
  );
}
