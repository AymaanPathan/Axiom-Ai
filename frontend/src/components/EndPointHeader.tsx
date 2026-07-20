const METHOD_COLOR: Record<string, string> = {
  GET: "text-[#4c9aff]",
  POST: "text-[#27a644]",
  PUT: "text-[#e4f222]",
  PATCH: "text-[#e4f222]",
  DELETE: "text-[#eb5757]",
};

export type RunStatus =
  | "idle"
  | "starting"
  | "installing"
  | "running"
  | "exited"
  | "error";

const STATUS_META: Record<
  RunStatus,
  { label: string; dot: string; text: string }
> = {
  idle: { label: "Not started", dot: "bg-[#4c4f54]", text: "text-[#8a8f98]" },
  starting: { label: "Starting", dot: "bg-[#e4f222]", text: "text-[#e4f222]" },
  installing: {
    label: "Installing",
    dot: "bg-[#e4f222]",
    text: "text-[#e4f222]",
  },
  running: { label: "Running", dot: "bg-[#27a644]", text: "text-[#27a644]" },
  exited: { label: "Exited", dot: "bg-[#8a8f98]", text: "text-[#8a8f98]" },
  error: { label: "Error", dot: "bg-[#eb5757]", text: "text-[#eb5757]" },
};

interface EndpointHeaderProps {
  method: string;
  routePath: string;
  repoName: string;
  status: RunStatus;
}

export default function EndpointHeader({
  method,
  routePath,
  repoName,
  status,
}: EndpointHeaderProps) {
  const meta = STATUS_META[status];

  return (
    <div className="mb-8 flex items-start justify-between">
      <div>
        <div
          className="flex items-center gap-3 text-[26px] font-[510] leading-[1.13] tracking-[-0.012em] text-white"
          style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}
        >
          <span className={METHOD_COLOR[method] ?? "text-[#8a8f98]"}>
            {method}
          </span>
          <span>{routePath}</span>
        </div>
        <p className="mt-1 text-[13px] text-[#62666d]">
          Repository: <span className="text-[#d0d6e0]">{repoName}</span>
        </p>
      </div>

      <span
        className={`flex items-center gap-2 rounded-full border border-[#23252a] bg-white/[0.03] px-3 py-1 text-[12px] font-[510] ${meta.text}`}
      >
        <span className={`h-[6px] w-[6px] rounded-full ${meta.dot}`} />
        {meta.label}
      </span>
    </div>
  );
}
