import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { io, type Socket } from "socket.io-client";
import { startRun } from "../api/repos";

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
  const startedAtRef = useRef<number | null>(null);
  const launchingRef = useRef(false);

  useEffect(() => {
    if (phase === "idle" || phase === "done" || phase === "error") return;
    if (startedAtRef.current === null) startedAtRef.current = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAtRef.current!) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [phase]);

  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();
    };
  }, []);

  const handleLaunch = async () => {
    if (launchingRef.current) return;
    launchingRef.current = true;
    startedAtRef.current = Date.now();
    setElapsed(0);
    setError(null);
    setPhase("installing");

    try {
      const run = await startRun(repositoryId);

      const socket = io(import.meta.env.VITE_API_URL, {
        withCredentials: true,
      });
      socketRef.current = socket;
      socket.emit("run:subscribe", run.runId);

      socket.on("run:status", (payload: { runId: string; status: string }) => {
        if (payload.runId !== run.runId) return;

        if (payload.status === "installing") setPhase("installing");
        if (payload.status === "starting") setPhase("starting");

       if (payload.status === "running") {
         setPhase("verifying");
         setTimeout(() => {
           setPhase("done");
           onLaunched();
           socket.emit("run:unsubscribe", run.runId);
           socket.disconnect();
           navigate(`/workspace/repos/${repositoryId}/observability`);
         }, 900);
       }

        if (payload.status === "error") {
          setPhase("error");
          setError(
            "The service failed to start. Check your environment variables and try again.",
          );
        }
      });

      if (run.status === "starting") setPhase("starting");
    } catch {
      setPhase("error");
      setError("Failed to start the service.");
    }
  };

  const handleRetry = () => {
    launchingRef.current = false;
    void handleLaunch();
  };

  const currentIndex = PHASE_INDEX[phase];

  if (phase === "idle") {
    return (
      <div className="rounded-xl border border-[#2a2d33] bg-[#141518] p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium text-white">
              Start Observability
            </h3>
            <p className="mt-1 text-xs text-[#9096a1]">
              {envReady
                ? "Boots the service with tracing already attached — then opens the dashboard automatically."
                : "Add the environment variables above to continue."}
            </p>
          </div>
          <button
            type="button"
            onClick={handleLaunch}
            disabled={!envReady}
            className="shrink-0 rounded-lg bg-[#f0e63f] px-4 py-2 text-sm font-[560] text-[#08090a] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
          >
            Start Observability →
          </button>
        </div>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="rounded-xl border border-[#f27272]/25 bg-[#f27272]/[0.04] p-6">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-[#f27272]" />
          <span className="text-[14px] font-[560] text-white">
            Launch Failed
          </span>
        </div>
        <p className="mt-1 text-[13px] text-[#9096a1]">{error}</p>
        <button
          type="button"
          onClick={handleRetry}
          className="mt-4 rounded-md border border-[#2a2d33] px-4 py-[9px] text-[13px] font-[560] text-[#dde1e8] transition-colors hover:border-[#3a3d44] hover:text-white"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[#2a2d33] bg-[#141518] p-6">
      <div className="flex items-center gap-2">
        <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[#2a2d33] border-t-[#f0e63f]" />
        <span className="text-[14px] font-[560] text-white">
          Starting Observability
        </span>
        <span
          className="ml-auto text-[11px] text-[#9096a1]"
          style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}
        >
          {elapsed}s
        </span>
      </div>

      <div className="mt-4 flex flex-col gap-2.5">
        {STEPS.map((step, idx) => {
          const done = idx < currentIndex || phase === "done";
          const current = idx === currentIndex && phase !== "done";
          return (
            <div key={step.phase} className="flex items-center gap-2.5">
              {done ? (
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#3ecf5f]/15 text-[10px] text-[#3ecf5f]">
                  ✓
                </span>
              ) : current ? (
                <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[#2a2d33] border-t-[#f0e63f]" />
              ) : (
                <span className="h-4 w-4 shrink-0 rounded-full border border-[#2a2d33]" />
              )}
              <span
                className={`text-[13px] ${done || current ? "text-[#dde1e8]" : "text-[#9096a1]"}`}
              >
                {step.label}
              </span>
            </div>
          );
        })}
      </div>

      {phase === "done" && (
        <p className="mt-4 text-[12px] text-[#9096a1]">
          Redirecting to the dashboard…
        </p>
      )}
    </div>
  );
}
