import { useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { fetchRepoDetail } from "../store/slices/reposSlice";
import PipelineViz from "../components/PipeLineViz";
import InstrumentationPanel from "../components/InstrumentalPanel";
import MissingEnvPanel from "../components/MissingEnvPanel";
import RunConsole from "../components/RunConsole";
import { useState } from "react";

const METHOD_COLOR: Record<string, string> = {
  GET: "text-[#4c9aff]",
  POST: "text-[#27a644]",
  PUT: "text-[#e4f222]",
  PATCH: "text-[#e4f222]",
  DELETE: "text-[#eb5757]",
};

export default function RepoDetail() {
  const { repositoryId } = useParams<{ repositoryId: string }>();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const [envReady, setEnvReady] = useState(false);

  const repo = useAppSelector((s) =>
    repositoryId ? s.repos.byId[repositoryId] : undefined,
  );
  const instrumentationStatus = useAppSelector((s) =>
    repositoryId
      ? s.instrumentation.byRepositoryId[repositoryId]?.status
      : undefined,
  );

  useEffect(() => {
    if (repositoryId && !repo) {
      dispatch(fetchRepoDetail(repositoryId));
    }
  }, [repositoryId, repo, dispatch]);

  if (!repositoryId) return null;

  if (!repo) {
    return (
      <div className="px-8 py-10">
        <p className="text-[13px] text-[#62666d]">Loading repository…</p>
      </div>
    );
  }

  const instrumented = instrumentationStatus === "ready";

  return (
    <div className="px-8 py-10">
      <button
        type="button"
        onClick={() => navigate("/workspace")}
        className="mb-6 text-[13px] text-[#62666d] transition-colors hover:text-white"
      >
        ← Repositories
      </button>

      <div className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-[28px] font-[510] leading-[1.13] tracking-[-0.012em] text-white">
            📦 {repo.githubFullName.split("/")[1]}
          </h1>
          <p className="mt-1 text-[13px] text-[#62666d]">
            {repo.framework === "express" ? "Express" : repo.framework} ·{" "}
            {repo.routes.length} route{repo.routes.length === 1 ? "" : "s"}
          </p>
        </div>
        <span
          className={`rounded-full border px-3 py-1 text-[12px] font-[510] ${
            instrumented
              ? "border-[#27a644]/30 bg-[#27a644]/10 text-[#27a644]"
              : "border-[#23252a] bg-white/[0.03] text-[#8a8f98]"
          }`}
        >
          {instrumented ? "🟢 Instrumented" : "🟢 Ready"}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_280px]">
        <div className="flex flex-col gap-6">
          {/* Setup checklist */}
          <div className="rounded-xl border border-[#23252a] bg-[#0f1011] p-5">
            <div className="flex flex-col gap-2">
              {[
                "Repository cloned",
                "Framework detected",
                "Route graph generated",
              ].map((item) => (
                <div
                  key={item}
                  className="flex items-center gap-2 text-[13px] text-[#d0d6e0]"
                >
                  <span className="text-[#27a644]">✓</span>
                  {item}
                </div>
              ))}
            </div>
          </div>

          {/* Routes */}
          <div className="rounded-xl border border-[#23252a] bg-[#0f1011]">
            <div className="border-b border-[#23252a] px-5 py-3">
              <span
                className="text-[11px] text-[#62666d]"
                style={{
                  fontFamily: "'Berkeley Mono', ui-monospace, monospace",
                }}
              >
                Routes
              </span>
            </div>
            <div className="flex flex-col divide-y divide-[#161718]">
              {repo.routes.map((route, index) => (
                <Link
                  key={`${route.method}-${route.routePath}-${route.line}`}
                  to={`/workspace/repos/${repositoryId}/endpoints/${index}`}
                  className="flex items-center gap-4 px-5 py-3 transition-colors hover:bg-white/[0.02]"
                  style={{
                    fontFamily: "'Berkeley Mono', ui-monospace, monospace",
                  }}
                >
                  <span
                    className={`w-14 shrink-0 text-[12px] font-[510] ${
                      METHOD_COLOR[route.method] ?? "text-[#8a8f98]"
                    }`}
                  >
                    {route.method}
                  </span>
                  <span className="text-[13px] text-[#d0d6e0]">
                    {route.routePath}
                  </span>
                  <span className="ml-auto shrink-0 text-[11px] text-[#4c4f54]">
                    {route.file}:{route.line}
                  </span>
                </Link>
              ))}
            </div>
          </div>
          <MissingEnvPanel
            repositoryId={repositoryId}
            onAllSet={() => setEnvReady(true)}
          />
          {envReady && <RunConsole repositoryId={repositoryId} />}
          <InstrumentationPanel repositoryId={repositoryId} />

          {/* Instrumentation flow */}
          <InstrumentationPanel repositoryId={repositoryId} />
        </div>

        {/* Pipeline sidebar */}
        <div>
          <PipelineViz
            routeCount={repo.routes.length}
            instrumented={instrumented}
          />
          <p className="mt-4 text-[12px] leading-[1.5] text-[#62666d]">
            Need another repo?{" "}
            <Link
              to="/workspace"
              className="text-[#d0d6e0] underline decoration-dotted hover:text-white"
            >
              Back to repositories
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
