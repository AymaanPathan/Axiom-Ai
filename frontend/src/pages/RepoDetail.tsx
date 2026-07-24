// src/pages/RepoDetail.tsx
import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Search,
  Check,
  Code2,
  GitBranch,
  KeyRound,
} from "lucide-react";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { fetchRepoDetail } from "../store/slices/reposSlice";
import ObservabilityLauncher from "../components/ObservabilityLauncher";
import MissingEnvPanel from "../components/MissingEnvPanel";
import { SANS, MONO, CONTENT_MAX_WIDTH } from "../theme";
import { GLASS } from "../styles/glass";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const SETUP_STEPS = [
  { label: "Repository cloned", detail: "git clone over your GitHub grant" },
  {
    label: "Framework detected",
    detail: "route conventions parsed from source",
  },
  { label: "Routes mapped", detail: "every handler indexed by file:line" },
];

function AmbientGlow() {
  return (
    <>
      <div
        className="pointer-events-none fixed -left-32 -top-32 h-[420px] w-[420px] rounded-full blur-[110px]"
        style={{
          background:
            "radial-gradient(circle, rgba(255,198,41,0.30), transparent 70%)",
        }}
      />
      <div
        className="pointer-events-none fixed -bottom-40 -right-24 h-[480px] w-[480px] rounded-full blur-[120px]"
        style={{
          background:
            "radial-gradient(circle, rgba(255,198,41,0.22), transparent 70%)",
        }}
      />
    </>
  );
}

function GlassCard({
  className = "",
  children,
  style,
}: {
  className?: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={`rounded-3xl border backdrop-blur-xl ${className}`}
      style={{
        background: GLASS.glassBg,
        borderColor: GLASS.border,
        boxShadow: GLASS.shadow,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function LivePill({ live }: { live: boolean }) {
  return (
    <span
      className="flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold backdrop-blur-md"
      style={
        live
          ? {
              background: GLASS.accentSoft,
              borderColor: "transparent",
              color: GLASS.accentText,
            }
          : {
              background: "rgba(255,255,255,0.5)",
              borderColor: GLASS.border,
              color: GLASS.textTertiary,
            }
      }
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{
          background: live ? GLASS.accent : GLASS.textQuiet,
          animation: live
            ? "repoLivePulse 1.8s ease-in-out infinite"
            : undefined,
        }}
      />
      {live ? "Live" : "Ready"}
    </span>
  );
}

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

  const mutatingCount = useMemo(
    () =>
      filteredRoutes.filter((r) => MUTATING_METHODS.has(r.method.toUpperCase()))
        .length,
    [filteredRoutes],
  );

  if (!repositoryId) return null;

  if (!repo) {
    return (
      <div
        className="relative min-h-screen px-10 py-10"
        style={{ background: GLASS.page, fontFamily: SANS }}
      >
        <AmbientGlow />
        <p
          className="relative text-[13px]"
          style={{ color: GLASS.textTertiary }}
        >
          Loading repository…
        </p>
      </div>
    );
  }

  const repoName = repo.githubFullName.split("/")[1];

  const HEADER_STATS: {
    icon: typeof Code2;
    label: string;
    value: string | number;
    color?: string;
  }[] = [
    {
      icon: Code2,
      label: "Framework",
      value: repo.framework === "express" ? "Express" : repo.framework,
    },
    { icon: GitBranch, label: "Routes", value: repo.routes.length },
    {
      icon: KeyRound,
      label: "Environment",
      value: envReady ? "Configured" : "Pending",
      color: envReady ? GLASS.live : GLASS.textTertiary,
    },
  ];

  return (
    <div
      className="relative min-h-screen w-full"
      style={{ background: GLASS.page, fontFamily: SANS }}
    >
      <style>{`
        @keyframes repoLivePulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>

      <AmbientGlow />

      <div
        className="relative mx-auto w-full px-8 py-10 lg:px-12"
        style={{ maxWidth: CONTENT_MAX_WIDTH }}
      >
        <button
          type="button"
          onClick={() => navigate("/workspace")}
          className="mb-6 flex items-center gap-1.5 text-[13px] font-medium transition-colors"
          style={{ color: GLASS.textTertiary }}
          onMouseEnter={(e) => (e.currentTarget.style.color = GLASS.text)}
          onMouseLeave={(e) =>
            (e.currentTarget.style.color = GLASS.textTertiary)
          }
        >
          <ArrowLeft size={14} /> Repositories
        </button>

        {/* Identity card */}
        <GlassCard className="mb-6 flex flex-wrap items-center gap-6 p-6">
          <div className="flex min-w-0 items-center gap-4">
            <div
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-[14px] font-bold"
              style={{
                background: `linear-gradient(135deg, ${GLASS.accent}, #FFE28A)`,
                color: GLASS.accentOn,
                fontFamily: MONO,
                boxShadow: "0 6px 18px rgba(255,198,41,0.35)",
              }}
            >
              {repoName.slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0">
              <h1
                className="truncate text-[20px] font-bold leading-[1.2] tracking-[-0.01em]"
                style={{ color: GLASS.text }}
              >
                {repoName}
              </h1>
              <p
                className="mt-0.5 truncate text-[12px]"
                style={{ color: GLASS.textTertiary, fontFamily: MONO }}
              >
                {repo.githubFullName}
              </p>
            </div>
          </div>

          <LivePill live={launched} />

          <div
            className="flex flex-1 flex-wrap items-center justify-end gap-3"
            style={{ minWidth: 260 }}
          >
            {HEADER_STATS.map((stat) => (
              <div
                key={stat.label}
                className="flex items-center gap-2.5 rounded-2xl px-3.5 py-2"
                style={{ background: "rgba(20,20,10,0.03)" }}
              >
                <span
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
                  style={{ background: GLASS.accentSoft }}
                >
                  <stat.icon size={13} style={{ color: GLASS.accentText }} />
                </span>
                <div>
                  <p
                    className="text-[9.5px] font-semibold uppercase tracking-[0.08em]"
                    style={{ color: GLASS.textQuiet }}
                  >
                    {stat.label}
                  </p>
                  <p
                    className="text-[13px] font-bold"
                    style={{ color: stat.color ?? GLASS.text }}
                  >
                    {stat.value}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </GlassCard>

        {/* Body: routes (main) + setup rail (aside) */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
          <div className="flex flex-col gap-6">
            {/* Setup pipeline — a real 3-step sequence, so it earns numbering */}
            <GlassCard className="p-6">
              <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-0">
                {SETUP_STEPS.map((step, idx) => (
                  <div
                    key={step.label}
                    className="flex flex-1 items-start gap-3"
                  >
                    <div className="flex flex-col items-center">
                      <span
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
                        style={{
                          background: `linear-gradient(135deg, ${GLASS.accent}, #FFE28A)`,
                          color: GLASS.accentOn,
                          boxShadow: "0 4px 12px rgba(255,198,41,0.35)",
                        }}
                      >
                        <Check size={13} />
                      </span>
                      {idx < SETUP_STEPS.length - 1 && (
                        <span
                          className="mt-1.5 hidden h-px w-full sm:block"
                          style={{
                            background: `linear-gradient(90deg, ${GLASS.accentSoft}, transparent)`,
                          }}
                        />
                      )}
                    </div>
                    <div className="min-w-0 pb-2">
                      <p
                        className="text-[10.5px] font-bold"
                        style={{ color: GLASS.accentText, fontFamily: MONO }}
                      >
                        {String(idx + 1).padStart(2, "0")}
                      </p>
                      <p
                        className="text-[13px] font-semibold"
                        style={{ color: GLASS.text }}
                      >
                        {step.label}
                      </p>
                      <p
                        className="mt-0.5 text-[11.5px]"
                        style={{ color: GLASS.textTertiary }}
                      >
                        {step.detail}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </GlassCard>

            {/* Routes */}
            <GlassCard className="overflow-hidden">
              <div
                className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4"
                style={{ borderColor: GLASS.border }}
              >
                <div className="flex items-center gap-2.5">
                  <span
                    className="text-[14px] font-bold"
                    style={{ color: GLASS.text }}
                  >
                    Routes
                  </span>
                  <span
                    className="flex items-center gap-1.5 text-[11.5px] font-semibold"
                    style={{ fontFamily: MONO }}
                  >
                    <span style={{ color: GLASS.accentText }}>
                      {mutatingCount} mutating
                    </span>
                    <span style={{ color: GLASS.textQuiet }}>·</span>
                    <span style={{ color: GLASS.textQuiet }}>
                      {filteredRoutes.length - mutatingCount} safe
                    </span>
                  </span>
                </div>

                <div
                  className="flex w-60 items-center gap-2 rounded-full border px-4 py-2 transition-colors"
                  style={{
                    borderColor: GLASS.border,
                    background: "rgba(20,20,10,0.03)",
                  }}
                  onFocus={undefined}
                >
                  <Search size={13} style={{ color: GLASS.textQuiet }} />
                  <input
                    type="text"
                    value={routeFilter}
                    onChange={(e) => setRouteFilter(e.target.value)}
                    placeholder="Filter by path or method"
                    className="w-full bg-transparent text-[12.5px] outline-none"
                    style={{ color: GLASS.text, fontFamily: MONO }}
                  />
                </div>
              </div>

              {filteredRoutes.length === 0 ? (
                <p
                  className="px-5 py-8 text-center text-[13px]"
                  style={{ color: GLASS.textQuiet }}
                >
                  No routes match "{routeFilter}".
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
                        className="flex items-center gap-4 border-b px-6 py-3.5 transition-colors last:border-b-0"
                        style={{ borderColor: GLASS.border }}
                        onMouseEnter={(e) =>
                          (e.currentTarget.style.background =
                            "rgba(255,198,41,0.05)")
                        }
                        onMouseLeave={(e) =>
                          (e.currentTarget.style.background = "transparent")
                        }
                      >
                        <span
                          className="w-16 shrink-0 rounded-full py-1 text-center text-[11px] font-bold"
                          style={
                            mutating
                              ? {
                                  background: GLASS.accent,
                                  color: GLASS.accentOn,
                                }
                              : {
                                  border: `1px solid ${GLASS.borderStrong}`,
                                  color: GLASS.textSecondary,
                                }
                          }
                        >
                          {route.method}
                        </span>

                        <div className="min-w-0 flex-1">
                          <p
                            className="truncate text-[13px] font-medium"
                            style={{ color: GLASS.text, fontFamily: MONO }}
                          >
                            {route.routePath}
                          </p>
                          <p
                            className="mt-0.5 truncate text-[11px]"
                            style={{ color: GLASS.textQuiet, fontFamily: MONO }}
                          >
                            {route.file}:{route.line}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </GlassCard>
          </div>

          {/* Control rail */}
          <div className="flex flex-col gap-6">
            {launched && (
              <GlassCard className="p-6">
                <div className="mb-3 flex items-center gap-2">
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{
                      background: GLASS.accent,
                      animation: "repoLivePulse 1.8s ease-in-out infinite",
                    }}
                  />
                  <span
                    className="text-[13px] font-bold"
                    style={{ color: GLASS.text }}
                  >
                    Service observability
                  </span>
                </div>
                <p
                  className="mb-4 text-[12.5px]"
                  style={{ color: GLASS.textTertiary }}
                >
                  Logs, traces, metrics, CPU, memory and endpoint activity,
                  live.
                </p>
                <button
                  type="button"
                  onClick={() =>
                    navigate(`/workspace/repos/${repositoryId}/observability`)
                  }
                  className="w-full rounded-xl px-4 py-2.5 text-[13px] font-bold transition-all hover:brightness-105"
                  style={{
                    background: GLASS.accent,
                    color: GLASS.accentOn,
                    boxShadow: "0 8px 20px rgba(255,198,41,0.35)",
                  }}
                >
                  Open dashboard →
                </button>
              </GlassCard>
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
