import { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { fetchRepoDetail } from "../store/slices/reposSlice";
import ObservabilityLauncher from "../components/ObservabilityLauncher";
import MissingEnvPanel from "../components/MissingEnvPanel";

// ---------------------------------------------------------------------------
// Design tokens — same palette as ApiWorkspace / ObservabilityLauncher,
// monochrome only.
// ---------------------------------------------------------------------------
const SANS = "'Inter', ui-sans-serif, system-ui, sans-serif";
const MONO = "'Berkeley Mono', ui-monospace, monospace";

const BG = "#0a0a0a";
const SURFACE = "#111111";
const BORDER = "#1e1e1e";
const BORDER_STRONG = "#2e2e2e";
const TEXT_PRIMARY = "#f5f5f5";
const TEXT_SECONDARY = "#b3b3b3";
const TEXT_TERTIARY = "#6e6e6e";
const TEXT_QUIET = "#4a4a4a";

export default function RepoDetail() {
  const { repositoryId } = useParams<{ repositoryId: string }>();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const [envReady, setEnvReady] = useState(false);
  const [launched, setLaunched] = useState(false);

  const repo = useAppSelector((s) =>
    repositoryId ? s.repos.byId[repositoryId] : undefined,
  );

  useEffect(() => {
    if (repositoryId && !repo) {
      dispatch(fetchRepoDetail(repositoryId));
    }
  }, [repositoryId, repo, dispatch]);

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

  return (
    <div
      className="w-full min-h-screen px-10 py-10"
      style={{ background: BG, fontFamily: SANS }}
    >
      <button
        type="button"
        onClick={() => navigate("/workspace")}
        className="mb-8 flex items-center gap-1.5 text-[13px] font-medium transition-colors"
        style={{ color: TEXT_TERTIARY }}
        onMouseEnter={(e) => (e.currentTarget.style.color = TEXT_PRIMARY)}
        onMouseLeave={(e) => (e.currentTarget.style.color = TEXT_TERTIARY)}
      >
        ← Repositories
      </button>

      {/* Header */}
      <div className="mb-8 flex items-start justify-between">
        <div className="flex items-center gap-4">
          <div
            className="flex h-12 w-12 items-center justify-center rounded-xl border text-[22px]"
            style={{ borderColor: BORDER, background: SURFACE }}
          >
            📦
          </div>
          <div>
            <h1
              className="text-[30px] font-[560] leading-[1.1] tracking-[-0.015em]"
              style={{ color: TEXT_PRIMARY }}
            >
              {repo.githubFullName.split("/")[1]}
            </h1>
            <p className="mt-1 text-[13px]" style={{ color: TEXT_TERTIARY }}>
              {repo.githubFullName}
            </p>
          </div>
        </div>
        <span
          className="flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[12px] font-[560]"
          style={{
            borderColor: launched ? BORDER_STRONG : BORDER,
            background: SURFACE,
            color: launched ? TEXT_PRIMARY : TEXT_TERTIARY,
          }}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: launched ? TEXT_PRIMARY : TEXT_QUIET }}
          />
          {launched ? "Live" : "Ready"}
        </span>
      </div>

      {/* Stat bar */}
      <div className="mb-6 grid grid-cols-4 gap-4">
        {[
          {
            label: "Framework",
            value: repo.framework === "express" ? "Express" : repo.framework,
          },
          { label: "Routes", value: repo.routes.length },
          { label: "Env Status", value: envReady ? "Configured" : "Pending" },
          {
            label: "Observability",
            value: launched ? "Live" : "Not started",
          },
        ].map((stat) => (
          <div
            key={stat.label}
            className="rounded-xl border px-5 py-4"
            style={{ borderColor: BORDER, background: SURFACE }}
          >
            <p
              className="text-[11px] font-medium uppercase tracking-wide"
              style={{ color: TEXT_TERTIARY }}
            >
              {stat.label}
            </p>
            <p
              className="mt-1.5 text-[16px] font-[560]"
              style={{ color: TEXT_PRIMARY }}
            >
              {stat.value}
            </p>
          </div>
        ))}
      </div>

      {/* Setup checklist */}
      <div
        className="mb-6 rounded-xl border p-6"
        style={{ borderColor: BORDER, background: SURFACE }}
      >
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          {[
            "Repository cloned",
            "Framework detected",
            "Route graph generated",
          ].map((item) => (
            <div
              key={item}
              className="flex items-center gap-2 text-[13px] font-medium"
              style={{ color: TEXT_SECONDARY }}
            >
              <span
                className="flex h-4 w-4 items-center justify-center rounded-full text-[10px]"
                style={{ background: BORDER_STRONG, color: TEXT_PRIMARY }}
              >
                ✓
              </span>
              {item}
            </div>
          ))}
        </div>
      </div>

      {launched && (
        <div
          className="mb-6 flex items-center justify-between rounded-xl border p-6"
          style={{ borderColor: BORDER, background: SURFACE }}
        >
          <div>
            <h3
              className="text-[15px] font-[560]"
              style={{ color: TEXT_PRIMARY }}
            >
              Service Observability
            </h3>
            <p className="mt-1 text-[13px]" style={{ color: TEXT_TERTIARY }}>
              Monitor logs, traces, metrics, CPU, memory and endpoint activity.
            </p>
          </div>
          <Link
            to={`/workspace/repos/${repositoryId}/observability`}
            className="shrink-0 rounded-lg bg-white px-5 py-2.5 text-[13px] font-[560] text-black transition-opacity hover:bg-[#e5e5e5]"
          >
            Open Dashboard →
          </Link>
        </div>
      )}

      {/* Routes */}
      <div
        className="mb-6 rounded-xl border"
        style={{ borderColor: BORDER, background: SURFACE }}
      >
        <div className="border-b px-6 py-4" style={{ borderColor: BORDER }}>
          <span
            className="text-[13px] font-[560]"
            style={{ color: TEXT_PRIMARY }}
          >
            Routes
          </span>
          <span className="ml-2 text-[13px]" style={{ color: TEXT_TERTIARY }}>
            {repo.routes.length}
          </span>
        </div>
        <div className="grid grid-cols-2">
          {repo.routes.map((route) => (
            <p
              key={`${route.method}-${route.routePath}-${route.line}`}
              className="flex items-center gap-4 border-b border-r px-6 py-4 transition-colors last:border-b-0 [&:nth-child(2n)]:border-r-0"
              style={{
                fontFamily: MONO,
                borderColor: BORDER,
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "rgba(255,255,255,0.03)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
            >
              <span
                className="w-14 shrink-0 text-[12px] font-[560]"
                style={{ color: TEXT_PRIMARY }}
              >
                {route.method}
              </span>
              <span className="text-[13px]" style={{ color: TEXT_SECONDARY }}>
                {route.routePath}
              </span>
              <span
                className="ml-auto shrink-0 text-[11px]"
                style={{ color: TEXT_QUIET }}
              >
                {route.file}:{route.line}
              </span>
            </p>
          ))}
        </div>
      </div>

      <div className="mb-6">
        <MissingEnvPanel
          repositoryId={repositoryId}
          onAllSet={() => setEnvReady(true)}
        />
      </div>

      <ObservabilityLauncher
        repositoryId={repositoryId}
        envReady={envReady}
        onLaunched={() => setLaunched(true)}
      />
    </div>
  );
}
