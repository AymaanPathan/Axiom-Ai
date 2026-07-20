import { useEffect } from "react";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { runInstrumentation } from "../store/slices/instrumentalSlice";

interface InstrumentationPanelProps {
  repositoryId: string;
  serviceName?: string; // OTel service.name — defaults below if not passed in
}

const PREPARING_CHECKLIST = [
  "Framework detected",
  "Express supported",
  "Auto instrumentation available",
];

export default function InstrumentationPanel({
  repositoryId,
}: InstrumentationPanelProps) {

  const dispatch = useAppDispatch();
  const state = useAppSelector(
    (s) => s.instrumentation.byRepositoryId[repositoryId],
  );
  const status = state?.status ?? "idle";

  // Kick off instrumentation as soon as the panel mounts for this repo.
  // Guard on "idle" so we don't re-dispatch on every render or re-fire
  // after an error (retry button handles that case explicitly below).
  useEffect(() => {
    if (status === "idle") {
      dispatch(runInstrumentation(repositoryId));
    }
  }, [status, repositoryId, dispatch]);

  if (status === "idle") {
    // Brief gap between mount and the pending action landing in the store.
    return (
      <div className="rounded-xl border border-[#23252a] bg-[#0f1011] p-6">
        <span className="text-[13px] text-[#62666d]">Preparing…</span>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="rounded-xl border border-[#eb5757]/25 bg-[#eb5757]/[0.04] p-6">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-[#eb5757]" />
          <span className="text-[14px] font-[510] text-white">
            Instrumentation Failed
          </span>
        </div>
        <p className="mt-1 text-[13px] text-[#8a8f98]">
          {state?.error ?? "Something went wrong generating instrumentation."}
        </p>
        <button
          type="button"
          onClick={() => dispatch(runInstrumentation(repositoryId))}
          className="mt-4 rounded-md border border-[#23252a] px-4 py-[9px] text-[13px] font-[510] text-[#d0d6e0] transition-colors hover:border-[#383b3f] hover:text-white"
        >
          Retry
        </button>
      </div>
    );
  }

  if (status === "preparing") {
    return (
      <div className="rounded-xl border border-[#23252a] bg-[#0f1011] p-6">
        <div className="flex items-center gap-2">
          <span className="text-[15px]">🩺</span>
          <span className="text-[14px] font-[510] text-white">
            Preparing Observability
          </span>
        </div>
        <div className="mt-4 flex flex-col gap-2.5">
          {PREPARING_CHECKLIST.map((item, idx) => (
            <div key={item} className="flex items-center gap-2.5">
              <span
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#27a644]/15 text-[10px] text-[#27a644]"
                style={{ animationDelay: `${idx * 150}ms` }}
              >
                ✓
              </span>
              <span className="text-[13px] text-[#d0d6e0]">{item}</span>
            </div>
          ))}
          <div className="mt-1 flex items-center gap-2.5">
            <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[#23252a] border-t-[#e4f222]" />
            <span className="text-[13px] text-[#8a8f98]">Generating…</span>
          </div>
        </div>
      </div>
    );
  }

  // status === "ready" — state and state.result are guaranteed present here,
  // since the "ready" case is only ever set alongside a result in the slice.
  if (!state?.result) {
    // Defensive fallback — should be unreachable, but avoids a crash if the
    // slice shape ever drifts (e.g. a "ready" action without a result).
    return null;
  }


}
