import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { io, type Socket } from "socket.io-client";
import { startRun, getRun } from "../api/repos";

interface ObservabilityLauncherProps {
  repositoryId: string;
  envReady: boolean;
  onLaunched: () => void;
}

type Phase =
  | "idle"
  | "installing"
  | "starting"
  | "verifying"
  | "done"
  | "error";

// ---------------------------------------------------------------------------
// Design tokens — same palette as ApiWorkspace, monochrome only.
// ---------------------------------------------------------------------------
const SANS = "'Inter', ui-sans-serif, system-ui, sans-serif";
const MONO = "'Berkeley Mono', ui-monospace, monospace";

const BG = "#0a0a0a";
const SURFACE = "#111111";
const BORDER = "#1e1e1e";
const BORDER_STRONG = "#2e2e2e";
const TEXT_PRIMARY = "#f5f5f5";
const TEXT_SECONDARY = "#b3b3b3";
const TEXT_TERTIARY = "#6e6e6e";
const TEXT_QUIET = "#4a4a4a";

const STEPS: { phase: Phase; label: string }[] = [
  { phase: "installing", label: "Installing dependencies" },
  { phase: "starting", label: "Starting service" },
  { phase: "verifying", label: "Verifying health" },
];

const PHASE_INDEX: Record<Phase, number> = {
  idle: -1,
  installing: 0,
  starting: 1,
  verifying: 2,
  done: 3,
  error: -1,
};

// Fallback poll cadence. Covers the case where the socket connects/subscribes
// a beat after the server already emitted a transition (fast-booting apps),
// or the socket connection just never comes up.
const POLL_INTERVAL_MS = 1500;

// Installs can legitimately take a while (npm install on a cold cache).
// Past this point in the "installing" phase we show a reassuring note so
// a long wait doesn't read as "stuck".
const SLOW_INSTALL_HINT_SECONDS = 20;

const DEFAULT_ERROR_MESSAGE =
  "The service failed to start. Check the run logs or your environment variables and try again.";

export default function ObservabilityLauncher({
  repositoryId,
  envReady,
  onLaunched,
}: ObservabilityLauncherProps) {
  const navigate = useNavigate();

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const socketRef = useRef<Socket | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const launchingRef = useRef(false);
  // Guards against the socket and the poll both trying to fire the
  // "running" -> "done" transition (or the error transition) a second time.
  const finishedRef = useRef(false);

  useEffect(() => {
    if (phase === "idle" || phase === "done" || phase === "error") return;
    if (startedAtRef.current === null) startedAtRef.current = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAtRef.current!) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [phase]);

  const cleanupSocket = () => {
    socketRef.current?.disconnect();
    socketRef.current = null;
  };

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      cleanupSocket();
      stopPolling();
    };
  }, []);

  // Single place that turns a backend run status into a UI phase. Fed by
  // both the socket push and the polling fallback — whichever gets there
  // first wins, the other is a no-op thanks to finishedRef. `message` is
  // the real backend error reason, when the backend has one — falls back
  // to a generic message rather than assuming it's always an env var issue.
  const handleStatus = (status: string, message?: string) => {
    if (finishedRef.current) return;

    if (status === "installing") {
      setPhase("installing");
      return;
    }
    if (status === "starting") {
      setPhase("starting");
      return;
    }
    if (status === "running") {
      finishedRef.current = true;
      setPhase("verifying");
      setTimeout(() => {
        setPhase("done");
        onLaunched();
        cleanupSocket();
        stopPolling();
        navigate(`/workspace/repos/${repositoryId}/observability`);
      }, 900);
      return;
    }
    if (status === "error" || status === "exited") {
      finishedRef.current = true;
      cleanupSocket();
      stopPolling();
      setPhase("error");
      setError(message?.trim() || DEFAULT_ERROR_MESSAGE);
    }
  };

  const handleLaunch = async () => {
    if (launchingRef.current) return;
    launchingRef.current = true;
    finishedRef.current = false;
    cleanupSocket();
    stopPolling();
    startedAtRef.current = Date.now();
    setElapsed(0);
    setError(null);
    setPhase("installing");

    try {
      const run = await startRun(repositoryId);
      handleStatus(run.status);

      const socket = io(import.meta.env.VITE_API_URL, {
        withCredentials: true,
      });
      socketRef.current = socket;
      socket.emit("run:subscribe", run.runId);

      socket.on(
        "run:status",
        (payload: { runId: string; status: string; message?: string }) => {
          if (payload.runId !== run.runId) return;
          handleStatus(payload.status, payload.message);
        },
      );

      // REST fallback — this is what actually fixes the "backend already
      // started but the UI shows an error / hangs forever" bug. It doesn't
      // depend on the socket connecting at all.
      pollRef.current = setInterval(async () => {
        try {
          const latest = await getRun(repositoryId, run.runId);
          handleStatus(latest.status, latest.errorMessage);
        } catch {
          // transient network hiccup — next tick retries
        }
      }, POLL_INTERVAL_MS);
    } catch {
      finishedRef.current = true;
      setPhase("error");
      setError("Failed to start the service.");
    }
  };

  const handleRetry = () => {
    launchingRef.current = false;
    void handleLaunch();
  };

  const currentIndex = PHASE_INDEX[phase];
  const isOverlayPhase =
    phase === "installing" ||
    phase === "starting" ||
    phase === "verifying" ||
    phase === "done";

  return (
    <>
      <style>{`
        @keyframes obsFadeUp {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes obsPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.45; }
        }
        @keyframes obsHintFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>

      {phase === "idle" && (
        <div
          className="rounded-2xl border p-6 transition-colors"
          style={{ borderColor: BORDER, background: SURFACE, fontFamily: SANS }}
        >
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3
                className="text-[14px] font-semibold"
                style={{ color: TEXT_PRIMARY }}
              >
                Start Observability
              </h3>
              <p
                className="mt-1 text-[12.5px]"
                style={{ color: TEXT_TERTIARY }}
              >
                {envReady
                  ? "Boots the service with tracing already attached — then opens the dashboard automatically."
                  : "Add the environment variables above to continue."}
              </p>
            </div>
            <button
              type="button"
              onClick={handleLaunch}
              disabled={!envReady}
              className="shrink-0 rounded-lg bg-white px-4 py-2 text-[13px] font-semibold text-black transition-opacity hover:bg-[#e5e5e5] disabled:cursor-not-allowed disabled:opacity-25"
            >
              Start Observability →
            </button>
          </div>
        </div>
      )}

      {/* Full-page takeover while the run is in flight — just the phase as
          a large changing headline, an elapsed timer, and a slim progress
          indicator. Nothing else on screen. */}
      {isOverlayPhase && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-8"
          style={{ background: BG, fontFamily: SANS }}
        >
          <span
            className="text-[11px] font-semibold uppercase tracking-[0.24em]"
            style={{ color: TEXT_TERTIARY, fontFamily: MONO }}
          >
            Observability · {elapsed}s
          </span>

          <h1
            key={phase}
            className="px-6 text-center text-[32px] font-semibold tracking-tight sm:text-[46px]"
            style={{ color: TEXT_PRIMARY, animation: "obsFadeUp 0.4s ease" }}
          >
            {phase === "done" ? "Ready" : STEPS[currentIndex]?.label}
          </h1>

          <div className="flex items-center gap-2">
            {STEPS.map((step, idx) => {
              const done = idx < currentIndex || phase === "done";
              const current = idx === currentIndex && phase !== "done";
              return (
                <span
                  key={step.phase}
                  className="h-1.5 rounded-full transition-all duration-300"
                  style={{
                    width: current ? 28 : 8,
                    background: done || current ? TEXT_PRIMARY : BORDER_STRONG,
                    animation: current
                      ? "obsPulse 1.6s ease-in-out infinite"
                      : undefined,
                  }}
                />
              );
            })}
          </div>

          {phase === "installing" && elapsed >= SLOW_INSTALL_HINT_SECONDS && (
            <p
              className="max-w-[360px] text-center text-[12.5px]"
              style={{
                color: TEXT_QUIET,
                animation: "obsHintFadeIn 0.5s ease",
              }}
            >
              Still installing dependencies — first-time installs on a cold
              cache can take a couple of minutes.
            </p>
          )}

          {phase === "done" && (
            <p className="text-[12.5px]" style={{ color: TEXT_QUIET }}>
              Redirecting to the dashboard…
            </p>
          )}
        </div>
      )}

      {phase === "error" && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 px-6"
          style={{ background: BG, fontFamily: SANS }}
        >
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: TEXT_PRIMARY }}
          />
          <h1
            className="text-center text-[28px] font-semibold tracking-tight sm:text-[38px]"
            style={{ color: TEXT_PRIMARY }}
          >
            Launch failed
          </h1>
          <p
            className="max-w-[420px] text-center text-[13.5px]"
            style={{ color: TEXT_SECONDARY }}
          >
            {error}
          </p>
          <button
            type="button"
            onClick={handleRetry}
            className="mt-2 rounded-lg border px-5 py-2.5 text-[13px] font-semibold transition-colors hover:border-[#454545]"
            style={{ borderColor: BORDER_STRONG, color: TEXT_PRIMARY }}
          >
            Retry
          </button>
        </div>
      )}
    </>
  );
}
