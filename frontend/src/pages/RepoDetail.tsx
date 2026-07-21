import { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { fetchRepoDetail } from "../store/slices/reposSlice";
import ObservabilityLauncher from "../components/ObservabilityLauncher";
import MissingEnvPanel from "../components/MissingEnvPanel";

const METHOD_COLOR: Record<string, string> = {
  GET: "text-[#5aa6ff]",
  POST: "text-[#3ecf5f]",
  PUT: "text-[#f0e63f]",
  PATCH: "text-[#f0e63f]",
  DELETE: "text-[#f27272]",
};

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
      <div className="px-10 py-10">
        <p className="text-[13px] text-[#9096a1]">Loading repository…</p>
      </div>
    );
  }

  return (
    <div className="w-full px-10 py-10">
      <button
        type="button"
        onClick={() => navigate("/workspace")}
        className="mb-8 flex items-center gap-1.5 text-[13px] font-medium text-[#9096a1] transition-colors hover:text-white"
      >
        ← Repositories
      </button>

      {/* Header */}
      <div className="mb-8 flex items-start justify-between">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-[#2a2d33] bg-[#141518] text-[22px]">
            📦
          </div>
          <div>
            <h1 className="text-[30px] font-[560] leading-[1.1] tracking-[-0.015em] text-white">
              {repo.githubFullName.split("/")[1]}
            </h1>
            <p className="mt-1 text-[13px] text-[#9096a1]">
              {repo.githubFullName}
            </p>
          </div>
        </div>
        <span
          className={`flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[12px] font-[560] ${
            launched
              ? "border-[#3ecf5f]/30 bg-[#3ecf5f]/10 text-[#3ecf5f]"
              : "border-[#2a2d33] bg-[#141518] text-[#c4c8d1]"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              launched ? "bg-[#3ecf5f]" : "bg-[#c4c8d1]"
            }`}
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
            className="rounded-xl border border-[#2a2d33] bg-[#141518] px-5 py-4"
          >
            <p className="text-[11px] font-medium uppercase tracking-wide text-[#7a808c]">
              {stat.label}
            </p>
            <p className="mt-1.5 text-[16px] font-[560] text-white">
              {stat.value}
            </p>
          </div>
        ))}
      </div>

      {/* Setup checklist */}
      <div className="mb-6 rounded-xl border border-[#2a2d33] bg-[#141518] p-6">
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          {[
            "Repository cloned",
            "Framework detected",
            "Route graph generated",
          ].map((item) => (
            <div
              key={item}
              className="flex items-center gap-2 text-[13px] font-medium text-[#dde1e8]"
            >
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[#3ecf5f]/15 text-[10px] text-[#3ecf5f]">
                ✓
              </span>
              {item}
            </div>
          ))}
        </div>
      </div>

      {launched && (
        <div className="mb-6 flex items-center justify-between rounded-xl border border-[#2a2d33] bg-[#141518] p-6">
          <div>
            <h3 className="text-[15px] font-[560] text-white">
              Service Observability
            </h3>
            <p className="mt-1 text-[13px] text-[#9096a1]">
              Monitor logs, traces, metrics, CPU, memory and endpoint activity.
            </p>
          </div>
          <Link
            to={`/workspace/repos/${repositoryId}/observability`}
            className="shrink-0 rounded-lg bg-[#5aa6ff] px-5 py-2.5 text-[13px] font-[560] text-[#08090a] transition-opacity hover:opacity-90"
          >
            Open Dashboard →
          </Link>
        </div>
      )}

      {/* Routes */}
      <div className="mb-6 rounded-xl border border-[#2a2d33] bg-[#141518]">
        <div className="border-b border-[#2a2d33] px-6 py-4">
          <span className="text-[13px] font-[560] text-white">Routes</span>
          <span className="ml-2 text-[13px] text-[#7a808c]">
            {repo.routes.length}
          </span>
        </div>
        <div className="grid grid-cols-2">
          {repo.routes.map((route) => (
            <p
              key={`${route.method}-${route.routePath}-${route.line}`}
              className="flex items-center gap-4 border-b border-r border-[#1c1e22] px-6 py-4 transition-colors last:border-b-0 hover:bg-white/[0.03] [&:nth-child(2n)]:border-r-0"
              style={{
                fontFamily: "'Berkeley Mono', ui-monospace, monospace",
              }}
            >
              <span
                className={`w-14 shrink-0 text-[12px] font-[560] ${
                  METHOD_COLOR[route.method] ?? "text-[#c4c8d1]"
                }`}
              >
                {route.method}
              </span>
              <span className="text-[13px] text-[#dde1e8]">
                {route.routePath}
              </span>
              <span className="ml-auto shrink-0 text-[11px] text-[#6b7078]">
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
