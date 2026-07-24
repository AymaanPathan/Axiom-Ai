// src/pages/RepoDetail.tsx
import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { fetchRepoDetail } from "../store/slices/reposSlice";
import ObservabilityLauncher from "../components/ObservabilityLauncher";
import MissingEnvPanel from "../components/MissingEnvPanel";
import {
  SANS,
  MONO,
  BG,
  SURFACE,
  SURFACE_RAISED,
  BORDER,
  BORDER_STRONG,
  TEXT_PRIMARY,
  TEXT_SECONDARY,
  TEXT_TERTIARY,
  TEXT_QUIET,
  ACCENT,
  ACCENT_SOFT,
  ACCENT_TEXT,
  LIVE,
  CONTENT_MAX_WIDTH,
} from "../theme";

// Mutating verbs change state on the server — they get the signal color.
// Safe verbs (GET/HEAD/OPTIONS) stay quiet.
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const SETUP_STEPS = [
  "Repository cloned",
  "Framework detected",
  "Routes mapped",
];

export default function RepoDetail() {
  const { repositoryId } = useParams<{ repositoryId: string }>();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const [envReady, setEnvReady] = useState(false);
  const [launched, setLaunched] = useState(false);
  const [routeFilter, setRouteFilter] = useState("");

  const repo = useAppSelector((s) =>
    repositoryId ? s.repos.byId[repositoryId] : undefined,
  );

  useEffect(() => {
    if (repositoryId && !repo) {
      dispatch(fetchRepoDetail(repositoryId));
    }
  }, [repositoryId, repo, dispatch]);

  const filteredRoutes = useMemo(() => {
    if (!repo) return [];
    const q = routeFilter.trim().toLowerCase();
    if (!q) return repo.routes;
    return repo.routes.filter(
      (r) =>
        r.routePath.toLowerCase().includes(q) ||
        r.method.toLowerCase().includes(q),
    );
  }, [repo, routeFilter]);

  if (!repositoryId) return null;

  if (!repo) {
    return (
      <div
        className="min-h-screen px-10 py-10"
        style={{ background: BG, fontFamily: SANS }}
      >
        <p className="text-[13px]" style={{ color: TEXT_TERTIARY }}>
          Loading repository…
        </p>
      </div>
    );
  }

  const repoName = repo.githubFullName.split("/")[1];

  const stats: { label: string; value: string | number; color?: string }[] = [
    {
      label: "Framework",
      value: repo.framework === "express" ? "Express" : repo.framework,
    },
    { label: "Routes", value: repo.routes.length },
    {
      label: "Environment",
      value: envReady ? "Configured" : "Pending",
      color: envReady ? LIVE : TEXT_TERTIARY,
    },
    {
      label: "Observability",
      value: launched ? "Live" : "Not started",
      color: launched ? ACCENT_TEXT : TEXT_TERTIARY,
    },
  ];

  return (
    <div
      className="min-h-screen w-full"
      style={{ background: BG, fontFamily: SANS }}
    >
      <style>{`
        @keyframes repoLivePulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>

      <div
        className="mx-auto w-full px-8 py-10 lg:px-12"
        style={{ maxWidth: CONTENT_MAX_WIDTH }}
      >
        <button
          type="button"
          onClick={() => navigate("/workspace")}
          className="mb-6 flex items-center gap-1.5 text-[13px] font-medium transition-colors"
          style={{ color: TEXT_TERTIARY }}
          onMouseEnter={(e) => (e.currentTarget.style.color = TEXT_PRIMARY)}
          onMouseLeave={(e) => (e.currentTarget.style.color = TEXT_TERTIARY)}
        >
          ← Repositories
        </button>

        {/* Identity row */}
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <div
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border text-[15px] font-semibold"
              style={{
                borderColor: BORDER_STRONG,
                background: SURFACE_RAISED,
                color: TEXT_PRIMARY,
                fontFamily: MONO,
              }}
            >
              {repoName.slice(0, 2).toUpperCase()}
            </div>
            <div>
              <h1
                className="text-[24px] font-semibold leading-[1.15] tracking-[-0.01em]"
                style={{ color: TEXT_PRIMARY }}
              >
                {repoName}
              </h1>
              <p
                className="mt-0.5 text-[12.5px]"
                style={{ color: TEXT_TERTIARY, fontFamily: MONO }}
              >
                {repo.githubFullName}
              </p>
            </div>
          </div>

          <span
            className="flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-semibold"
            style={
              launched
                ? { background: ACCENT_SOFT, color: ACCENT_TEXT }
                : { border: `1px solid ${BORDER}`, color: TEXT_TERTIARY }
            }
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{
                background: launched ? ACCENT : TEXT_QUIET,
                animation: launched
                  ? "repoLivePulse 1.8s ease-in-out infinite"
                  : undefined,
              }}
            />
            {launched ? "Live" : "Ready"}
          </span>
        </div>

        {/* Stat strip */}
        <div
          className="mb-8 flex flex-wrap items-stretch rounded-xl border"
          style={{ borderColor: BORDER, background: SURFACE }}
        >
          {stats.map((stat, idx) => (
            <div
              key={stat.label}
              className="min-w-[140px] flex-1 px-6 py-4"
              style={{
                borderRight:
                  idx < stats.length - 1 ? `1px solid ${BORDER}` : undefined,
              }}
            >
              <p
                className="text-[11px] font-medium uppercase tracking-wide"
                style={{ color: TEXT_QUIET }}
              >
                {stat.label}
              </p>
              <p
                className="mt-1.5 text-[15px] font-semibold"
                style={{ color: stat.color ?? TEXT_PRIMARY }}
              >
                {stat.value}
              </p>
            </div>
          ))}
        </div>

        {/* Body: routes (main) + setup rail (aside) */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
          <div className="flex flex-col gap-6">
            {/* Setup checklist */}
            <div
              className="rounded-xl border p-5"
              style={{ borderColor: BORDER, background: SURFACE }}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-3">
                {SETUP_STEPS.map((step, idx) => (
                  <div key={step} className="flex items-center gap-2">
                    <div
                      className="flex items-center gap-2 text-[13px] font-medium"
                      style={{ color: TEXT_SECONDARY }}
                    >
                      <span
                        className="flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold"
                        style={{ background: TEXT_PRIMARY, color: BG }}
                      >
                        ✓
                      </span>
                      {step}
                    </div>
                    {idx < SETUP_STEPS.length - 1 && (
                      <span
                        className="mx-1 h-px w-6"
                        style={{ background: BORDER_STRONG }}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Routes */}
            <div
              className="rounded-xl border"
              style={{ borderColor: BORDER, background: SURFACE }}
            >
              <div
                className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4"
                style={{ borderColor: BORDER }}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="text-[13px] font-semibold"
                    style={{ color: TEXT_PRIMARY }}
                  >
                    Routes
                  </span>
                  <span
                    className="text-[13px]"
                    style={{ color: TEXT_TERTIARY }}
                  >
                    {repo.routes.length}
                  </span>
                </div>
                <input
                  type="text"
                  value={routeFilter}
                  onChange={(e) => setRouteFilter(e.target.value)}
                  placeholder="Filter by path or method"
                  className="w-56 rounded-lg border px-3 py-1.5 text-[12.5px] outline-none transition-colors"
                  style={{
                    borderColor: BORDER,
                    background: BG,
                    color: TEXT_PRIMARY,
                    fontFamily: MONO,
                  }}
                  onFocus={(e) => (e.currentTarget.style.borderColor = ACCENT)}
                  onBlur={(e) => (e.currentTarget.style.borderColor = BORDER)}
                />
              </div>

              {filteredRoutes.length === 0 ? (
                <p
                  className="px-5 py-8 text-center text-[13px]"
                  style={{ color: TEXT_QUIET }}
                >
                  No routes match “{routeFilter}”.
                </p>
              ) : (
                <div>
                  {filteredRoutes.map((route) => {
                    const mutating = MUTATING_METHODS.has(
                      route.method.toUpperCase(),
                    );
                    return (
                      <div
                        key={`${route.method}-${route.routePath}-${route.line}`}
                        className="flex items-center gap-4 border-b px-5 py-3 transition-colors last:border-b-0"
                        style={{ borderColor: BORDER }}
                        onMouseEnter={(e) =>
                          (e.currentTarget.style.background = SURFACE_RAISED)
                        }
                        onMouseLeave={(e) =>
                          (e.currentTarget.style.background = "transparent")
                        }
                      >
                        <span
                          className="w-16 shrink-0 rounded-md px-2 py-0.5 text-center text-[11px] font-bold"
                          style={
                            mutating
                              ? { background: ACCENT_SOFT, color: ACCENT_TEXT }
                              : {
                                  border: `1px solid ${BORDER_STRONG}`,
                                  color: TEXT_SECONDARY,
                                }
                          }
                        >
                          {route.method}
                        </span>
                        <span
                          className="text-[13px]"
                          style={{ color: TEXT_PRIMARY, fontFamily: MONO }}
                        >
                          {route.routePath}
                        </span>
                        <span
                          className="ml-auto shrink-0 text-[11px]"
                          style={{ color: TEXT_QUIET, fontFamily: MONO }}
                        >
                          {route.file}:{route.line}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Control rail */}
          <div className="flex flex-col gap-6">
            {launched && (
              <div
                className="rounded-xl border p-5"
                style={{ borderColor: BORDER, background: SURFACE }}
              >
                <div className="mb-3 flex items-center gap-2">
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{
                      background: ACCENT,
                      animation: "repoLivePulse 1.8s ease-in-out infinite",
                    }}
                  />
                  <span
                    className="text-[13px] font-semibold"
                    style={{ color: TEXT_PRIMARY }}
                  >
                    Service observability
                  </span>
                </div>
                <p
                  className="mb-4 text-[12.5px]"
                  style={{ color: TEXT_TERTIARY }}
                >
                  Logs, traces, metrics, CPU, memory and endpoint activity,
                  live.
                </p>
                <button
                  type="button"
                  onClick={() =>
                    navigate(`/workspace/repos/${repositoryId}/observability`)
                  }
                  className="w-full rounded-lg px-4 py-2.5 text-[13px] font-semibold transition-opacity hover:opacity-90"
                  style={{ background: ACCENT, color: TEXT_PRIMARY }}
                >
                  Open dashboard →
                </button>
              </div>
            )}

            <MissingEnvPanel
              repositoryId={repositoryId}
              onAllSet={() => setEnvReady(true)}
            />

            <ObservabilityLauncher
              repositoryId={repositoryId}
              envReady={envReady}
              onLaunched={() => setLaunched(true)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
