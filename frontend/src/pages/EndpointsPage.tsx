import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useDispatch, useSelector } from "react-redux";
import { getEndpointMetrics, type EndpointMetric } from "../api/observability";
// Adjust these two paths if your store/slice live somewhere else —
// wired against the reposSlice you shared (byId keyed by repositoryId,
// fetchRepoDetail thunk populates it).
import type { RootState, AppDispatch } from "../store/store";
import { fetchRepoDetail } from "../store/slices/reposSlice";

const MONO = "'Berkeley Mono', ui-monospace, monospace";
const SANS =
  "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const BG = "#FFFFFF";
const SURFACE = "#FAFAF8";
const SURFACE_RAISED = "#F4F2EA";
const BORDER = "#ECEAE0";
const BORDER_STRONG = "#DEDBCB";
const TEXT_PRIMARY = "#16160F";
const TEXT_SECONDARY = "#4B4A3E";
const TEXT_TERTIARY = "#8C8874";
const TEXT_QUIET = "#BAB69E";
const GOLD = "#F5C400";
const ACCENT_SOFT = "#FEF6D8";
const LIVE = "#1AA35C";
const LIVE_SOFT = "#EAF9F0";
const ERROR = "#D6432E";
const ERROR_SOFT = "#FCEEEB";

const POLL_MS = 10_000;
const NODE_W = 196;
const HUB_SIZE = 136;

const METHOD_COLORS: Record<string, string> = {
  GET: "#2F6FE4",
  POST: "#1AA35C",
  PUT: "#B8860B",
  PATCH: "#C77D18",
  DELETE: "#D6432E",
};

function methodColor(method: string) {
  return METHOD_COLORS[method.toUpperCase()] ?? TEXT_SECONDARY;
}

function polar(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function bezierPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  bend: number,
) {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len;
  const py = dx / len;
  return `M ${x1} ${y1} Q ${mx + px * bend} ${my + py * bend} ${x2} ${y2}`;
}

type NodeDatum = EndpointMetric & { key: string; index: number };
type Vec = { x: number; y: number };

export default function EndpointsPage() {
  const { repositoryId = "" } = useParams<{ repositoryId: string }>();
  const navigate = useNavigate();
  const dispatch = useDispatch<AppDispatch>();

  const repoDetail = useSelector(
    (state: RootState) => state.repos.byId[repositoryId],
  );

  useEffect(() => {
    if (repositoryId && !repoDetail) {
      dispatch(fetchRepoDetail(repositoryId));
    }
  }, [repositoryId, repoDetail, dispatch]);

  const repoFullName = repoDetail?.githubFullName || repositoryId;
  const repoName = repoFullName.includes("/")
    ? repoFullName.split("/").pop()!
    : repoFullName;

  const [endpoints, setEndpoints] = useState<EndpointMetric[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [hubOffset, setHubOffset] = useState<Vec>({ x: 0, y: 0 });
  const [nodeOffsets, setNodeOffsets] = useState<Record<string, Vec>>({});

  const dragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);

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

  const nodes: NodeDatum[] = useMemo(
    () =>
      endpoints.map((e, index) => ({
        ...e,
        index,
        key: `${e.method}-${e.routePath}`,
      })),
    [endpoints],
  );

  const matches = useCallback(
    (n: NodeDatum) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return (
        n.routePath.toLowerCase().includes(q) ||
        n.method.toLowerCase().includes(q)
      );
    },
    [query],
  );

  const radius = useMemo(() => {
    const n = Math.max(nodes.length, 1);
    return Math.min(430, 230 + n * 9);
  }, [nodes.length]);

  const canvasSize = radius * 2 + NODE_W + 280;
  const originCx = canvasSize / 2;
  const originCy = canvasSize / 2;

  const anchors = useMemo(() => {
    const n = nodes.length || 1;
    return nodes.map((node, i) => {
      const angle = -90 + (360 / n) * i;
      return { key: node.key, ...polar(originCx, originCy, radius, angle) };
    });
  }, [nodes, radius, originCx, originCy]);

  const hubCenter: Vec = {
    x: originCx + hubOffset.x,
    y: originCy + hubOffset.y,
  };

  const resetLayout = () => {
    setHubOffset({ x: 0, y: 0 });
    setNodeOffsets({});
  };

  const beginDrag = (e: React.PointerEvent, id: string, origin: Vec) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      originX: origin.x,
      originY: origin.y,
      moved: false,
    };
    setIsDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
    if (drag.id === "hub") {
      setHubOffset({ x: drag.originX + dx, y: drag.originY + dy });
    } else {
      setNodeOffsets((prev) => ({
        ...prev,
        [drag.id]: { x: drag.originX + dx, y: drag.originY + dy },
      }));
    }
  };

  const endDrag = (onClick?: () => void) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setIsDragging(false);
    if (drag && !drag.moved) onClick?.();
  };

  const methodsPresent = useMemo(
    () => Array.from(new Set(nodes.map((n) => n.method.toUpperCase()))),
    [nodes],
  );

  return (
    <div
      className="flex h-full w-full flex-col"
      style={{ background: BG, fontFamily: SANS }}
    >
      <style>{`
        @keyframes epx-pulse {
          0% { box-shadow: 0 0 0 0 rgba(245,196,0,0.35); }
          70% { box-shadow: 0 0 0 22px rgba(245,196,0,0); }
          100% { box-shadow: 0 0 0 0 rgba(245,196,0,0); }
        }
        @keyframes epx-dash {
          to { stroke-dashoffset: -40; }
        }
        .epx-node { transition: box-shadow 120ms ease, border-color 120ms ease, opacity 150ms ease; }
        .epx-node:hover { box-shadow: 0 6px 18px rgba(22,22,15,0.08); border-color: ${BORDER_STRONG}; }
      `}</style>

      {/* Toolbar */}
      <div
        className="flex flex-wrap items-center gap-3 border-b px-8 py-4"
        style={{ borderColor: BORDER, background: BG }}
      >
        <button
          type="button"
          onClick={() => navigate(`/workspace/repos/${repositoryId}`)}
          className="flex items-center gap-1.5 text-[13px] font-medium transition-colors"
          style={{ color: TEXT_TERTIARY }}
          onMouseEnter={(e) => (e.currentTarget.style.color = TEXT_PRIMARY)}
          onMouseLeave={(e) => (e.currentTarget.style.color = TEXT_TERTIARY)}
        >
          ← Repository
        </button>

        <div className="mx-1 h-4 w-px" style={{ background: BORDER_STRONG }} />

        <div className="flex flex-col">
          <h1
            className="text-[19px] font-[600] leading-tight tracking-[-0.01em]"
            style={{ color: TEXT_PRIMARY }}
          >
            Endpoints
          </h1>
          <p className="text-[12px]" style={{ color: TEXT_TERTIARY }}>
            Drag the hub or any route to rearrange — layout only, nothing's
            saved.
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {methodsPresent.map((m) => (
            <span
              key={m}
              className="flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10.5px] font-medium uppercase tracking-wide"
              style={{
                borderColor: BORDER,
                color: TEXT_SECONDARY,
                fontFamily: MONO,
              }}
            >
              <span
                className="h-[7px] w-[7px] rounded-full"
                style={{ background: methodColor(m) }}
              />
              {m}
            </span>
          ))}

          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter routes…"
            className="w-[180px] rounded-lg border px-3 py-1.5 text-[13px] outline-none transition-shadow"
            style={{
              borderColor: BORDER_STRONG,
              color: TEXT_PRIMARY,
              background: SURFACE,
            }}
            onFocus={(e) =>
              (e.currentTarget.style.boxShadow = `0 0 0 3px ${ACCENT_SOFT}`)
            }
            onBlur={(e) => (e.currentTarget.style.boxShadow = "none")}
          />

          <button
            type="button"
            onClick={resetLayout}
            className="rounded-lg border px-3 py-1.5 text-[12.5px] font-medium transition-colors"
            style={{
              borderColor: BORDER_STRONG,
              color: TEXT_SECONDARY,
              background: BG,
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = SURFACE_RAISED)
            }
            onMouseLeave={(e) => (e.currentTarget.style.background = BG)}
          >
            Reset layout
          </button>
        </div>
      </div>

      {/* Canvas */}
      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-[13px]" style={{ color: TEXT_TERTIARY }}>
            Loading endpoints…
          </p>
        </div>
      ) : nodes.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-8">
          <div
            className="rounded-2xl border px-8 py-12 text-center"
            style={{ borderColor: BORDER, background: SURFACE, maxWidth: 420 }}
          >
            <p className="text-[13px]" style={{ color: TEXT_TERTIARY }}>
              No endpoint traffic observed yet. Once requests start hitting this
              repo, they'll show up here as routes around the hub.
            </p>
          </div>
        </div>
      ) : (
        <div
          className="flex-1 overflow-auto"
          style={{
            background: SURFACE,
            backgroundImage: `radial-gradient(${BORDER_STRONG} 1px, transparent 1px)`,
            backgroundSize: "22px 22px",
            cursor: isDragging ? "grabbing" : "default",
          }}
          onPointerMove={onPointerMove}
          onPointerUp={() => endDrag()}
          onPointerLeave={() => dragRef.current && endDrag()}
        >
          <div
            className="relative"
            style={{
              width: canvasSize,
              height: canvasSize,
              margin: "0 auto",
              userSelect: isDragging ? "none" : "auto",
            }}
          >
            <svg
              width={canvasSize}
              height={canvasSize}
              className="pointer-events-none absolute left-0 top-0"
              style={{ zIndex: 0 }}
            >
              {nodes.map((node, i) => {
                const anchor = anchors[i];
                const off = nodeOffsets[node.key] ?? { x: 0, y: 0 };
                const nx = anchor.x + off.x;
                const ny = anchor.y + off.y;
                const bend =
                  (i % 2 === 0 ? 1 : -1) * Math.min(38, radius * 0.11);
                const dim = !matches(node);
                return (
                  <path
                    key={node.key}
                    d={bezierPath(hubCenter.x, hubCenter.y, nx, ny, bend)}
                    fill="none"
                    stroke={methodColor(node.method)}
                    strokeWidth={2}
                    strokeOpacity={dim ? 0.12 : 0.5}
                    strokeDasharray="5 6"
                    style={{ animation: "epx-dash 6s linear infinite" }}
                  />
                );
              })}
            </svg>

            {/* Hub */}
            <div
              onPointerDown={(e) => beginDrag(e, "hub", hubOffset)}
              onPointerUp={() => endDrag()}
              className="epx-node absolute flex flex-col items-center justify-center rounded-full border-2 text-center"
              style={{
                left: hubCenter.x,
                top: hubCenter.y,
                width: HUB_SIZE,
                height: HUB_SIZE,
                transform: "translate(-50%, -50%)",
                borderColor: GOLD,
                background: BG,
                zIndex: 2,
                cursor: isDragging ? "grabbing" : "grab",
                animation: "epx-pulse 2.8s ease-out infinite",
                touchAction: "none",
              }}
              title={repoFullName}
            >
              <span
                className="max-w-[104px] truncate text-[13px] font-[650]"
                style={{ color: TEXT_PRIMARY }}
              >
                {repoName}
              </span>
              <span
                className="mt-0.5 text-[10.5px]"
                style={{ color: TEXT_TERTIARY }}
              >
                {nodes.length} endpoint{nodes.length === 1 ? "" : "s"}
              </span>
            </div>

            {/* Route nodes */}
            {nodes.map((node, i) => {
              const anchor = anchors[i];
              const off = nodeOffsets[node.key] ?? { x: 0, y: 0 };
              const cx = anchor.x + off.x;
              const cy = anchor.y + off.y;
              const dim = !matches(node);
              return (
                <div
                  key={node.key}
                  onPointerDown={(e) => beginDrag(e, node.key, off)}
                  onPointerUp={() =>
                    endDrag(() =>
                      navigate(
                        `/workspace/repos/${repositoryId}/endpoints/${node.index}`,
                      ),
                    )
                  }
                  className="epx-node absolute rounded-2xl border px-3.5 py-3"
                  style={{
                    left: cx,
                    top: cy,
                    width: NODE_W,
                    transform: "translate(-50%, -50%)",
                    background: BG,
                    borderColor: BORDER,
                    zIndex: 1,
                    cursor: isDragging ? "grabbing" : "grab",
                    opacity: dim ? 0.3 : 1,
                    pointerEvents: dim ? "none" : "auto",
                    touchAction: "none",
                  }}
                >
                  <div
                    className="flex items-center gap-1.5"
                    style={{ fontFamily: MONO }}
                  >
                    <span
                      className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase"
                      style={{
                        color: methodColor(node.method),
                        background: `${methodColor(node.method)}14`,
                      }}
                    >
                      {node.method}
                    </span>
                    <span
                      className="truncate text-[12px]"
                      style={{ color: TEXT_PRIMARY }}
                    >
                      {node.routePath}
                    </span>
                  </div>

                  <div
                    className="mt-2 flex items-center justify-between text-[11px]"
                    style={{ fontFamily: MONO }}
                  >
                    <span style={{ color: TEXT_TERTIARY }}>
                      {node.requestCount} req
                    </span>
                    <span
                      className="flex items-center gap-1 rounded-full px-1.5 py-0.5"
                      style={{
                        color: node.errorCount > 0 ? ERROR : LIVE,
                        background:
                          node.errorCount > 0 ? ERROR_SOFT : LIVE_SOFT,
                      }}
                    >
                      {node.errorCount > 0 ? `${node.errorCount} err` : "ok"}
                    </span>
                  </div>

                  <div
                    className="mt-1.5 flex items-center justify-between text-[10.5px]"
                    style={{ color: TEXT_QUIET, fontFamily: MONO }}
                  >
                    <span>avg {node.avgLatencyMs.toFixed(0)}ms</span>
                    <span>p95 {node.p95Ms.toFixed(0)}ms</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
