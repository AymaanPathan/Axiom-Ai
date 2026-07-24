import { Highlight, themes, type Language } from "prism-react-renderer";
import { GitBranch, Server, Database, FileCode2, X } from "lucide-react";
import type { ConnectedFile, ConnectedFilesResult } from "../api/repos";
import {
  MONO,
  SANS,
  BG,
  BORDER,
  BORDER_STRONG,
  TEXT_PRIMARY,
  TEXT_SECONDARY,
  TEXT_TERTIARY,
  TEXT_QUIET,
} from "../theme";

const ROLE_META: Record<
  ConnectedFile["role"],
  { label: string; icon: typeof GitBranch }
> = {
  route: { label: "Route", icon: GitBranch },
  controller: { label: "Controller", icon: Server },
  service: { label: "Service", icon: Database },
  other: { label: "File", icon: FileCode2 },
};

function languageFor(filePath: string): Language {
  const ext = filePath.split(".").pop();
  if (ext === "ts" || ext === "tsx") return "tsx";
  if (ext === "js" || ext === "jsx") return "jsx";
  return "jsx";
}

function CodeBlock({
  code,
  filePath,
  startLine = 1,
  highlightLine,
}: {
  code: string;
  filePath: string;
  startLine?: number;
  highlightLine?: number;
}) {
  return (
    <Highlight
      code={code}
      language={languageFor(filePath)}
      theme={themes.vsDark}
    >
      {({ className, tokens, getLineProps, getTokenProps }) => (
        <pre
          className={className}
          style={{
            margin: 0,
            padding: "14px 0",
            background: "transparent",
            fontFamily: MONO,
            fontSize: 13,
            lineHeight: 1.75,
            overflow: "auto",
            height: "100%",
          }}
        >
          {tokens.map((line, i) => {
            const lineNumber = startLine + i;
            const isTarget = highlightLine === lineNumber;
            return (
              <div
                key={i}
                {...getLineProps({ line })}
                style={{
                  display: "flex",
                  background: isTarget ? "#ffffff14" : "transparent",
                  borderLeft: isTarget
                    ? "2px solid #ffffff"
                    : "2px solid transparent",
                }}
              >
                <span
                  style={{
                    width: 48,
                    flexShrink: 0,
                    textAlign: "right",
                    paddingRight: 16,
                    color: TEXT_QUIET,
                    userSelect: "none",
                  }}
                >
                  {lineNumber}
                </span>
                <span style={{ flex: 1, whiteSpace: "pre", paddingRight: 20 }}>
                  {line.map((token, key) => (
                    <span key={key} {...getTokenProps({ token })} />
                  ))}
                </span>
              </div>
            );
          })}
        </pre>
      )}
    </Highlight>
  );
}

interface SourceOverlayProps {
  open: boolean;
  onClose: () => void;
  connected: ConnectedFilesResult | null;
  activeFile: ConnectedFile | null;
  onSelectFile: (file: ConnectedFile) => void;
}

export default function SourceOverlay({
  open,
  onClose,
  connected,
  activeFile,
  onSelectFile,
}: SourceOverlayProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      style={{ fontFamily: SANS }}
    >
      <div
        className="absolute inset-0"
        style={{ background: "#000000b3" }}
        onClick={onClose}
      />
      <div
        className="relative flex h-full w-full max-w-4xl flex-col overflow-hidden border-l shadow-2xl"
        style={{ borderColor: BORDER_STRONG, background: BG }}
      >
        <div
          className="flex shrink-0 items-center justify-between border-b px-6 py-4"
          style={{ borderColor: BORDER }}
        >
          <div>
            <div
              className="text-[11px] font-semibold uppercase tracking-[0.08em]"
              style={{ color: TEXT_TERTIARY }}
            >
              Call chain source
            </div>
            <p
              className="mt-0.5 text-[12.5px]"
              style={{ color: TEXT_SECONDARY }}
            >
              Files involved in handling this route, in execution order.
            </p>
          </div>
          <button
            onClick={onClose}
            className="flex items-center gap-1 rounded-lg p-2 transition-colors hover:bg-white/5 hover:text-white"
            style={{ color: TEXT_TERTIARY }}
          >
            <X size={16} />
          </button>
        </div>

        {connected && connected.files.length > 0 && (
          <nav
            className="flex shrink-0 flex-wrap items-center gap-2 border-b px-6 py-3"
            style={{ borderColor: BORDER }}
          >
            {connected.files.map((f) => {
              const meta = ROLE_META[f.role];
              const Icon = meta.icon;
              const isActive = activeFile?.path === f.path;
              return (
                <button
                  key={f.path}
                  onClick={() => onSelectFile(f)}
                  className={
                    isActive
                      ? "flex items-center gap-2 rounded-lg bg-white px-3 py-1.5 text-[12.5px] font-semibold text-black"
                      : "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12.5px] transition-colors"
                  }
                  style={
                    isActive
                      ? undefined
                      : { borderColor: BORDER_STRONG, color: TEXT_SECONDARY }
                  }
                >
                  <Icon size={13} />
                  {meta.label}
                  <span
                    className="max-w-[150px] truncate text-[11.5px] opacity-80"
                    style={{ fontFamily: MONO }}
                  >
                    {f.path.split("/").pop()}
                  </span>
                </button>
              );
            })}
          </nav>
        )}

        <div className="min-h-0 flex-1 overflow-auto px-4">
          {activeFile ? (
            <CodeBlock
              code={activeFile.content}
              filePath={activeFile.path}
              startLine={activeFile.startLine}
              highlightLine={activeFile.highlightLine}
            />
          ) : (
            <p
              className="px-4 py-8 text-[13px]"
              style={{ color: TEXT_TERTIARY }}
            >
              {connected === null
                ? "Loading source…"
                : "No source available for this file."}
            </p>
          )}
        </div>

        {connected && (
          <div
            className="shrink-0 border-t px-6 py-4"
            style={{ borderColor: BORDER }}
          >
            <div
              className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.06em]"
              style={{ color: TEXT_TERTIARY }}
            >
              Request body fields
            </div>
            {connected.requestBodyFields.length ? (
              <div className="flex flex-wrap gap-2">
                {connected.requestBodyFields.map((f) => (
                  <span
                    key={f}
                    className="rounded-lg border px-2.5 py-1 text-[12px]"
                    style={{
                      borderColor: BORDER_STRONG,
                      color: TEXT_PRIMARY,
                      fontFamily: MONO,
                    }}
                  >
                    {f}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-[12px]" style={{ color: TEXT_TERTIARY }}>
                No req.body usage found — this handler likely doesn't read a
                request body.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
