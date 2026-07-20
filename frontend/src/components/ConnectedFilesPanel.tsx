import { useState } from "react";
import type { ConnectedFile } from "../api/connectedFiles";

const ROLE_LABEL: Record<ConnectedFile["role"], string> = {
  route: "Route",
  controller: "Controller",
  service: "Service",
  other: "File",
};

const ROLE_ICON: Record<ConnectedFile["role"], string> = {
  route: "🧭",
  controller: "📦",
  service: "🔧",
  other: "📄",
};

interface ConnectedFilesPanelProps {
  files: ConnectedFile[];
  status: "loading" | "loaded" | "error";
  error: string | null;
}

export default function ConnectedFilesPanel({
  files,
  status,
  error,
}: ConnectedFilesPanelProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const active = files[activeIndex];

  return (
    <div className="rounded-xl border border-[#23252a] bg-[#0f1011]">
      <div className="flex items-center justify-between border-b border-[#23252a] px-5 py-3">
        <span
          className="text-[11px] text-[#62666d]"
          style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}
        >
          Connected Files
        </span>
        {active && (
          <span
            className="text-[11px] text-[#4c4f54]"
            style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}
          >
            {active.path}
          </span>
        )}
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

      {status === "loaded" && files.length > 0 && (
        <>
          {/* Tabs — one per file in the chain: route -> controller -> service */}
          {files.length > 1 && (
            <div className="flex gap-1 border-b border-[#23252a] px-3 pt-2">
              {files.map((f, idx) => (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => setActiveIndex(idx)}
                  className={`flex items-center gap-1.5 rounded-t-md px-3 py-1.5 text-[12px] transition-colors ${
                    idx === activeIndex
                      ? "bg-[#161718] text-white"
                      : "text-[#62666d] hover:text-[#d0d6e0]"
                  }`}
                >
                  <span>{ROLE_ICON[f.role]}</span>
                  {ROLE_LABEL[f.role]}
                  {idx < files.length - 1 && (
                    <span className="ml-1.5 text-[#4c4f54]">→</span>
                  )}
                </button>
              ))}
            </div>
          )}

          {active && (
            <pre
              className="overflow-x-auto p-5 text-[12.5px] leading-[1.7] text-[#d0d6e0]"
              style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}
            >
              {active.content.split("\n").map((codeLine, idx) => {
                const lineNumber = active.startLine + idx;
                const isTarget = lineNumber === active.highlightLine;
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
        </>
      )}
    </div>
  );
}
