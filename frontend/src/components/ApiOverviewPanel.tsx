const METHOD_COLOR: Record<string, string> = {
  GET: "text-[#4c9aff]",
  POST: "text-[#27a644]",
  PUT: "text-[#e4f222]",
  PATCH: "text-[#e4f222]",
  DELETE: "text-[#eb5757]",
};

interface ApiOverviewPanelProps {
  purpose?: string;
  method: string;
  routePath: string;
  controller?: string;
  file: string;
  line: number;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-[0.04em] text-[#62666d]">
        {label}
      </p>
      <p
        className="mt-1 text-[13px] text-[#d0d6e0]"
        style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}
      >
        {value}
      </p>
    </div>
  );
}

export default function ApiOverviewPanel({
  purpose,
  method,
  routePath,
  controller,
  file,
  line,
}: ApiOverviewPanelProps) {
  return (
    <div className="rounded-xl border border-[#23252a] bg-[#0f1011] p-5">
      <span
        className="text-[11px] text-[#62666d]"
        style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}
      >
        Overview
      </span>

      <p className="mt-3 text-[14px] leading-[1.6] text-[#d0d6e0]">
        {purpose ?? (
          <span className="text-[#62666d]">
            No description detected yet for this route — purpose detection from
            handler bodies is planned for a future version of the parser.
          </span>
        )}
      </p>

      <div className="mt-5 grid grid-cols-2 gap-y-4 gap-x-6 border-t border-[#161718] pt-4 sm:grid-cols-4">
        <Field label="Method" value={method} />
        <div>
          <p className="text-[11px] uppercase tracking-[0.04em] text-[#62666d]">
            Route
          </p>
          <p
            className={`mt-1 text-[13px] ${METHOD_COLOR[method] ? "text-[#d0d6e0]" : "text-[#d0d6e0]"}`}
            style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}
          >
            {routePath}
          </p>
        </div>
        <Field label="Controller" value={controller ?? "—"} />
        <Field label="Location" value={`${file}:${line}`} />
      </div>
    </div>
  );
}
