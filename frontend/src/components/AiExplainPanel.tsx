import { useState } from "react";
import { getExplanation } from "../api/explain";

interface AIExplanationPanelProps {
  repositoryId: string;
  file: string;
  line: number;
}

export default function AIExplanationPanel({
  repositoryId,
  file,
  line,
}: AIExplanationPanelProps) {
  const [status, setStatus] = useState<"idle" | "loading" | "loaded" | "error">(
    "idle",
  );
  const [explanation, setExplanation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleExplain() {
    setStatus("loading");
    setError(null);
    try {
      const result = await getExplanation(repositoryId, file, line);
      setExplanation(result.explanation);
      setStatus("loaded");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to generate explanation",
      );
      setStatus("error");
    }
  }

  return (
    <div className="rounded-xl border border-[#23252a] bg-[#0f1011]">
      <div className="flex items-center justify-between border-b border-[#23252a] px-5 py-3">
        <span
          className="flex items-center gap-1.5 text-[11px] text-[#62666d]"
          style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}
        >
          <span className="text-[#a78bfa]">✨</span> AI Explanation
        </span>
        {status === "loaded" && (
          <button
            type="button"
            onClick={handleExplain}
            className="text-[11px] text-[#62666d] transition-colors hover:text-white"
          >
            Regenerate
          </button>
        )}
      </div>

      {status === "idle" && (
        <div className="flex flex-col items-center gap-3 px-5 py-8 text-center">
          <p className="text-[13px] text-[#8a8f98]">
            Get a plain-language explanation of what this powers in the product
            — no code, just the use case and business outcome.
          </p>
          <button
            type="button"
            onClick={handleExplain}
            className="rounded-md border border-[#23252a] bg-white/[0.03] px-4 py-1.5 text-[12px] font-[510] text-[#d0d6e0] transition-colors hover:border-[#383b3f] hover:text-white"
          >
            ✨ Explain the use case
          </button>
        </div>
      )}

      {status === "loading" && (
        <div className="flex flex-col gap-2 p-5">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-[14px] animate-pulse rounded bg-white/[0.04]"
              style={{ width: `${85 - i * 12}%` }}
            />
          ))}
        </div>
      )}

      {status === "error" && (
        <div className="flex flex-col items-center gap-3 px-5 py-8 text-center">
          <p className="text-[13px] text-[#eb5757]">{error}</p>
          <button
            type="button"
            onClick={handleExplain}
            className="rounded-md border border-[#23252a] px-4 py-1.5 text-[12px] font-[510] text-[#d0d6e0] transition-colors hover:border-[#383b3f] hover:text-white"
          >
            Try again
          </button>
        </div>
      )}

      {status === "loaded" && explanation && (
        <p className="whitespace-pre-line p-5 text-[13.5px] leading-[1.7] text-[#d0d6e0]">
          {explanation}
        </p>
      )}
    </div>
  );
}
