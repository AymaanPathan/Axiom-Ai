interface PipelineVizProps {
  routeCount: number;
  instrumented: boolean;
}

export default function PipelineViz({
  routeCount,
  instrumented,
}: PipelineVizProps) {
  const steps = [
    "GitHub",
    "Repository cloned",
    "Express detected",
    `${routeCount} route${routeCount === 1 ? "" : "s"} discovered`,
    "Instrumentation generated",
    "Ready for SigNoz",
  ];

  // Everything up to "route discovered" is always true once you're on this
  // page (you can't get here without it). The last two steps depend on
  // whether instrumentation has been generated yet.
  const completedCount = instrumented ? steps.length : steps.length - 2;

  return (
    <div className="rounded-xl border border-[#23252a] bg-[#0f1011] p-5">
      <span
        className="text-[11px] text-[#62666d]"
        style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}
      >
        Pipeline
      </span>
      <div className="mt-4 flex flex-col">
        {steps.map((step, idx) => {
          const done = idx < completedCount;
          const isLast = idx === steps.length - 1;
          return (
            <div key={step} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-[510] ${
                    done
                      ? "bg-[#e4f222] text-[#08090a]"
                      : "bg-white/[0.06] text-[#62666d]"
                  }`}
                >
                  {done ? "✓" : idx + 1}
                </span>
                {!isLast && (
                  <span
                    className={`w-px flex-1 ${done ? "bg-[#e4f222]/40" : "bg-[#23252a]"}`}
                    style={{ minHeight: "18px" }}
                  />
                )}
              </div>
              <span
                className={`pb-4 text-[13px] ${done ? "text-[#d0d6e0]" : "text-[#62666d]"}`}
              >
                {step}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
