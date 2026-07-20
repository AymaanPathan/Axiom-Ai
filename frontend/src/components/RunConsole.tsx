import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { startRun } from "../api/repos";

interface RunConsoleProps {
  repositoryId: string;
}

interface LogLine {
  stream: "stdout" | "stderr";
  chunk: string;
}

const STATUS_LABEL: Record<string, string> = {
  starting: "🟡 Starting",
  installing: "🟡 Installing dependencies",
  running: "🟢 Running",
  exited: "⚪ Exited",
  error: "🔴 Error",
};

export default function RunConsole({ repositoryId }: RunConsoleProps) {
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("idle");
  const [port, setPort] = useState<number | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const socketRef = useRef<Socket | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const handleStart = async () => {
    setLogs([]);
    setPort(null);
    const run = await startRun(repositoryId);
    setRunId(run.runId);
    setStatus(run.status);
    setPort(run.port ?? null);
  };

  useEffect(() => {
    if (!runId) return;

    const socket = io(import.meta.env.VITE_API_URL, { withCredentials: true });
    socketRef.current = socket;

    socket.emit("run:subscribe", runId);
    socket.on(
      "run:log",
      (payload: {
        runId: string;
        stream: "stdout" | "stderr";
        chunk: string;
      }) => {
        if (payload.runId !== runId) return;
        setLogs((prev) => [
          ...prev,
          { stream: payload.stream, chunk: payload.chunk },
        ]);
      },
    );
    socket.on("run:status", (payload: { runId: string; status: string }) => {
      if (payload.runId !== runId) return;
      setStatus(payload.status);
    });

    return () => {
      socket.emit("run:unsubscribe", runId);
      socket.disconnect();
    };
  }, [runId]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <div className="rounded-xl border border-[#23252a] bg-[#0f1011]">
      <div className="flex items-center justify-between border-b border-[#23252a] px-5 py-3">
        <div className="flex items-center gap-3">
          <span
            className="text-[11px] text-[#62666d]"
            style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}
          >
            {runId ? (STATUS_LABEL[status] ?? status) : "Not started"}
          </span>
          {status === "running" && port && (
            <a
              href={`http://localhost:${port}`}
              target="_blank"
              rel="noreferrer"
              className="text-[12px] text-[#4c9aff] underline decoration-dotted hover:text-[#6cb0ff]"
              style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}
            >
              Open http://localhost:{port} ↗
            </a>
          )}
        </div>
        <button
          type="button"
          onClick={handleStart}
          disabled={
            status === "starting" ||
            status === "installing" ||
            status === "running"
          }
          className="rounded-md bg-[#27a644] px-3 py-1 text-[12px] font-[510] text-white disabled:opacity-40"
        >
          Run
        </button>
      </div>

      <div
        className="max-h-[320px] overflow-y-auto px-5 py-3 text-[12px] leading-[1.6]"
        style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}
      >
        {logs.length === 0 && (
          <p className="text-[#4c4f54]">
            Logs will stream here once the run starts.
          </p>
        )}
        {logs.map((line, i) => (
          <pre
            key={i}
            className={`whitespace-pre-wrap ${line.stream === "stderr" ? "text-[#eb5757]" : "text-[#d0d6e0]"}`}
          >
            {line.chunk}
          </pre>
        ))}
        <div ref={logEndRef} />
      </div>
    </div>
  );
}
