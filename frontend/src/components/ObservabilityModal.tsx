// src/components/ObservabilityModal.tsx
import { useEffect, useRef, useState } from "react";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import {
  checkObservabilityStatus,
  fetchRouteMetrics,
  startObservability,
} from "../store/slices/observabilitySlice";

const BOOT_STEPS = [
  "Installing dependencies",
  "Loading OpenTelemetry",
  "Connecting to SigNoz",
];

export default function ObservabilityModal({
  repositoryId,
  serviceName,
  onClose,
}: {
  repositoryId: string;
  serviceName: string;
  onClose: () => void;
}) {
  const dispatch = useAppDispatch();
  const state = useAppSelector((s) => s.observability[repositoryId]);
  const status = state?.status ?? "starting";
  const [bootDone, setBootDone] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    dispatch(startObservability({ repositoryId }));
    const t = setInterval(
      () => setBootDone((n) => Math.min(n + 1, BOOT_STEPS.length)),
      500,
    );
    return () => clearInterval(t);
  }, [dispatch, repositoryId]);

  useEffect(() => {
    if (bootDone < BOOT_STEPS.length) return;
    pollRef.current = setInterval(
      () => dispatch(checkObservabilityStatus({ repositoryId, serviceName })),
      2000,
    );
    return () => clearInterval(pollRef.current);
  }, [bootDone, dispatch, repositoryId, serviceName]);

  useEffect(() => {
    if (status !== "live") return;
    clearInterval(pollRef.current);
    dispatch(fetchRouteMetrics({ repositoryId, serviceName }));
    const t = setInterval(
      () => dispatch(fetchRouteMetrics({ repositoryId, serviceName })),
      3000,
    );
    return () => clearInterval(t);
  }, [status, dispatch, repositoryId, serviceName]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[520px] rounded-xl border border-[#23252a] bg-[#0f1011] p-6">
        <div className="flex items-center justify-between">
          <span className="text-[14px] font-[510] text-white">
            Observability
          </span>
          <button
            onClick={onClose}
            className="text-[13px] text-[#8a8f98] hover:text-white"
          >
            Close
          </button>
        </div>

        {bootDone < BOOT_STEPS.length && (
          <div className="mt-5 flex flex-col gap-2.5">
            {BOOT_STEPS.map((step, idx) => (
              <div key={step} className="flex items-center gap-2.5">
                {idx < bootDone ? (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[#27a644]/15 text-[10px] text-[#27a644]">
                    ✓
                  </span>
                ) : idx === bootDone ? (
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#23252a] border-t-[#e4f222]" />
                ) : (
                  <span className="h-4 w-4 rounded-full border border-[#23252a]" />
                )}
                <span className="text-[13px] text-[#d0d6e0]">{step}</span>
              </div>
            ))}
          </div>
        )}

        {bootDone >= BOOT_STEPS.length && status !== "live" && (
          <div className="mt-6 flex flex-col items-center gap-3 py-8">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#23252a] border-t-[#e4f222]" />
            <span className="text-[13px] text-[#8a8f98]">
              Waiting for requests…
            </span>
            <span className="text-[11px] text-[#62666d]">
              Hit any route on your Express app to see it here.
            </span>
          </div>
        )}

        {status === "live" && (
          <div className="mt-6 flex flex-col gap-2">
            {(state?.routes ?? []).map((r) => (
              <div
                key={r.route}
                className="flex items-center justify-between rounded-md border border-[#23252a] px-3 py-2"
              >
                <span className="flex items-center gap-2 text-[13px] text-[#d0d6e0]">
                  {r.errors > 0 ? "🔴" : r.p99 > 800 ? "🟡" : "🟢"} {r.route}
                </span>
                <span className="text-[12px] text-[#8a8f98]">
                  {r.p99}ms · {r.requests} reqs
                  {r.errors ? ` · ${r.errors} errors` : ""}
                </span>
              </div>
            ))}
            {(state?.routes ?? []).length === 0 && (
              <span className="text-[13px] text-[#8a8f98]">
                No routes recorded yet.
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
