import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getEndpointMetrics, type EndpointMetric } from "../api/observability";

const MONO = "'Berkeley Mono', ui-monospace, monospace";
const POLL_MS = 10_000;

export default function EndpointsPage() {
  const { repositoryId = "" } = useParams<{ repositoryId: string }>();
  const navigate = useNavigate();
  const [endpoints, setEndpoints] = useState<EndpointMetric[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!repositoryId) return;
    let inFlight = false;

    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        setEndpoints(await getEndpointMetrics(repositoryId));
      } catch {
        // next tick retries
      } finally {
        inFlight = false;
        setLoading(false);
      }
    };

    tick();
    const interval = setInterval(tick, POLL_MS);
    return () => clearInterval(interval);
  }, [repositoryId]);

  return (
    <div className="w-full px-10 py-10">
      <button
        type="button"
        onClick={() =>
          navigate(`/workspace/repos/${repositoryId}/observability`)
        }
        className="mb-8 flex items-center gap-1.5 text-[13px] font-medium text-[#9096a1] transition-colors hover:text-white"
      >
        ← Observability
      </button>

      <h1 className="mb-1 text-[28px] font-[560] leading-[1.1] tracking-[-0.015em] text-white">
        Endpoints
      </h1>
      <p className="mb-8 text-[13px] text-[#9096a1]">
        Request volume, error rate, and latency observed per route.
      </p>

      {loading ? (
        <p className="text-[13px] text-[#9096a1]">Loading endpoints…</p>
      ) : endpoints.length === 0 ? (
        <div className="rounded-xl border border-[#2a2d33] bg-[#141518] px-6 py-10 text-center">
          <p className="text-[13px] text-[#9096a1]">
            No endpoint traffic observed yet.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[#2a2d33] bg-[#141518]">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-[#2a2d33] bg-[#0f1011] text-[#7a808c]">
                <th className="px-6 py-3 text-left font-medium">Route</th>
                <th className="px-6 py-3 text-right font-medium">Requests</th>
                <th className="px-6 py-3 text-right font-medium">Errors</th>
                <th className="px-6 py-3 text-right font-medium">Avg</th>
                <th className="px-6 py-3 text-right font-medium">p95</th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map((e, i) => (
                <tr
                  key={`${e.method}-${e.routePath}`}
                  onClick={() =>
                    navigate(`/workspace/repos/${repositoryId}/endpoints/${i}`)
                  }
                  className="cursor-pointer border-b border-[#1c1e22] last:border-0 hover:bg-white/[0.03]"
                  style={{ fontFamily: MONO }}
                >
                  <td className="px-6 py-4">
                    <span className="text-[#5aa6ff]">{e.method}</span>{" "}
                    <span className="text-[#dde1e8]">{e.routePath}</span>
                  </td>
                  <td className="px-6 py-4 text-right text-[#dde1e8]">
                    {e.requestCount}
                  </td>
                  <td
                    className={`px-6 py-4 text-right ${e.errorCount > 0 ? "text-[#f27272]" : "text-[#7a808c]"}`}
                  >
                    {e.errorCount}
                  </td>
                  <td className="px-6 py-4 text-right text-[#dde1e8]">
                    {e.avgLatencyMs.toFixed(0)}ms
                  </td>
                  <td className="px-6 py-4 text-right text-[#dde1e8]">
                    {e.p95Ms.toFixed(0)}ms
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
