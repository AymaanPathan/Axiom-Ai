interface RequestSchemaPanelProps {
  headers?: string[];
  bodyFields?: string[];
}

export default function RequestSchemaPanel({
  headers,
  bodyFields,
}: RequestSchemaPanelProps) {
  const hasHeaders = headers && headers.length > 0;
  const hasBodyFields = bodyFields && bodyFields.length > 0;

  return (
    <div className="rounded-xl border border-[#23252a] bg-[#0f1011]">
      <div className="border-b border-[#23252a] px-5 py-3">
        <span
          className="text-[11px] text-[#62666d]"
          style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}
        >
          Request Schema
        </span>
      </div>

      <div className="grid grid-cols-1 divide-y divide-[#161718] sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        <div className="p-5">
          <p className="text-[11px] uppercase tracking-[0.04em] text-[#62666d]">
            Headers
          </p>
          {hasHeaders ? (
            <ul
              className="mt-3 flex flex-col gap-2 text-[13px] text-[#d0d6e0]"
              style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}
            >
              {headers.map((header) => (
                <li key={header}>{header}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-[13px] text-[#62666d]">
              No required headers detected beyond standard auth.
            </p>
          )}
        </div>

        <div className="p-5">
          <p className="text-[11px] uppercase tracking-[0.04em] text-[#62666d]">
            Body
          </p>
          {hasBodyFields ? (
            <ul
              className="mt-3 flex flex-col gap-2 text-[13px] text-[#d0d6e0]"
              style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}
            >
              {bodyFields.map((field) => (
                <li key={field} className="flex items-center gap-2">
                  <span className="text-[#4c9aff]">{field}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-[13px] text-[#62666d]">
              No req.body usage found in the controller — this handler likely
              doesn't read a request body (e.g. a GET/list route).
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
  