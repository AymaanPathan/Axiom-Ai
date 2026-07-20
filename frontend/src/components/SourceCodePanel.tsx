import { useEffect, useState } from "react";
import { getSourceSnippet, type SourceSnippet } from "../api/source";

interface SourceCodePanelProps {
  repositoryId: string;
  file: string;
  line: number;
}

export default function SourceCodePanel({
  repositoryId,
  file,
  line,
}: SourceCodePanelProps) {
  const [snippet, setSnippet] = useState<SourceSnippet | null>(null);
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");

    getSourceSnippet(repositoryId, file, line)
      .then((result) => {
        if (cancelled) return;
        setSnippet(result);
        setStatus("loaded");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load source");
        setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [repositoryId, file, line]);

  return (
    <div className="rounded-xl border border-[#23252a] bg-[#0f1011]">
      <div className="flex items-center justify-between border-b border-[#23252a] px-5 py-3">
        <span
          className="text-[11px] text-[#62666d]"
          style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}
        >
          Source
        </span>
        <span
          className="text-[11px] text-[#4c4f54]"
          style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}
        >
          {file}
        </span>
      </div>

      {status === "loading" && (
        <div className="flex flex-col gap-2 p-5">
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-[14px] animate-pulse rounded bg-white/[0.04]"
              style={{ width: `${70 - i * 8}%` }}
            />
          ))}
        </div>
      )}

      {status === "error" && (
        <p className="p-5 text-[13px] text-[#eb5757]">{error}</p>
      )}

      {status === "loaded" && snippet && (
        <pre
          className="overflow-x-auto p-5 text-[12.5px] leading-[1.7] text-[#d0d6e0]"
          style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}
        >
          {snippet.content.split("\n").map((codeLine, idx) => {
            const lineNumber = snippet.startLine + idx;
            const isTarget = lineNumber === snippet.targetLine;
            return (
              <div
                key={lineNumber}
                className={`flex gap-4 ${isTarget ? "bg-[#27a644]/10" : ""}`}
              >
                <span className="w-8 shrink-0 select-none text-right text-[#4c4f54]">
                  {lineNumber}
                </span>
                <span className={isTarget ? "text-white" : undefined}>
                  {codeLine || " "}
                </span>
              </div>
            );
          })}
        </pre>
      )}
    </div>
  );
}
