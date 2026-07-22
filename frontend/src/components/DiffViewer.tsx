const ADD_BG = "#0f2415";
const ADD_FG = "#7ee2a8";
const DEL_BG = "#2a1414";
const DEL_FG = "#f29b9b";
const HUNK_FG = "#6e6e6e";
const CTX_FG = "#b3b3b3";
const MONO = "'Berkeley Mono', ui-monospace, monospace";

export default function DiffViewer({ unifiedDiff }: { unifiedDiff: string }) {
  const lines = unifiedDiff.split("\n");

  return (
    <pre
      style={{
        margin: 0,
        padding: "10px 0",
        fontFamily: MONO,
        fontSize: 12.5,
        lineHeight: 1.7,
        overflow: "auto",
      }}
    >
      {lines.map((line, i) => {
        let bg = "transparent";
        let color = CTX_FG;
        if (line.startsWith("+++") || line.startsWith("---")) {
          color = HUNK_FG;
        } else if (line.startsWith("@@")) {
          color = HUNK_FG;
        } else if (line.startsWith("+")) {
          bg = ADD_BG;
          color = ADD_FG;
        } else if (line.startsWith("-")) {
          bg = DEL_BG;
          color = DEL_FG;
        }
        return (
          <div
            key={i}
            style={{
              background: bg,
              color,
              padding: "0 16px",
              whiteSpace: "pre",
            }}
          >
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}
