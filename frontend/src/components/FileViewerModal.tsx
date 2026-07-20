import { useState } from "react";
import Editor from "@monaco-editor/react";
import type { GeneratedFile } from "../api/instrumentation";

interface FileViewerModalProps {
  files: GeneratedFile[];
  onClose: () => void;
}

const MONACO_LANGUAGE: Record<GeneratedFile["language"], string> = {
  javascript: "javascript",
  ini: "ini",
  markdown: "markdown",
};

export default function FileViewerModal({
  files,
  onClose,
}: FileViewerModalProps) {
  const [activeId, setActiveId] = useState(files[0]?.id);
  const activeFile = files.find((f) => f.id === activeId) ?? files[0];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex h-[80vh] w-full max-w-[900px] flex-col overflow-hidden rounded-xl border border-[#23252a] bg-[#0f1011] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#23252a] px-4 py-3">
          <span className="text-[13px] font-[510] text-white">
            Generated files
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-[13px] text-[#62666d] transition-colors hover:text-white"
          >
            Close ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-[#23252a] bg-white/[0.015]">
          {files.map((file) => (
            <button
              key={file.id}
              type="button"
              onClick={() => setActiveId(file.id)}
              className={`border-r border-[#23252a] px-4 py-2.5 text-[12px] transition-colors ${
                activeFile?.id === file.id
                  ? "bg-[#0f1011] text-white"
                  : "text-[#62666d] hover:text-[#d0d6e0]"
              }`}
              style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}
            >
              {file.name}
            </button>
          ))}
        </div>

        {/* Editor */}
        <div className="min-h-0 flex-1">
          {activeFile && (
            <Editor
              key={activeFile.id}
              value={activeFile.content}
              language={MONACO_LANGUAGE[activeFile.language]}
              theme="vs-dark"
              options={{
                readOnly: true,
                minimap: { enabled: false },
                fontSize: 13,
                fontFamily: "'Berkeley Mono', ui-monospace, monospace",
                scrollBeyondLastLine: false,
                padding: { top: 16 },
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
