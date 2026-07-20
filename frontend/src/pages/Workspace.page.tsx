import { Outlet, useMatch } from "react-router-dom";
import WorkspaceSidebar from "../components/WorkspaceSidebar";
import { useAppSelector } from "../store/hooks";

/**
 * Axiom AI — Workspace shell
 * Persistent sidebar + topbar; the actual page (repo list, repo detail,
 * eventually benchmarks/settings) renders through <Outlet/>. Only ever
 * rendered inside <RequireAuth>, so a valid session can be assumed here.
 */
export default function Workspace() {
  const detailMatch = useMatch("/workspace/repos/:repositoryId");
  const repo = useAppSelector((s) =>
    detailMatch ? s.repos.byId[detailMatch.params.repositoryId!] : undefined,
  );
  const breadcrumb = detailMatch
    ? `Workspace / Repositories / ${repo?.githubFullName.split("/")[1] ?? "…"}`
    : "Workspace / Repositories";

  return (
    <div
      className="flex min-h-screen bg-[#08090a] text-[#d0d6e0] antialiased"
      style={{
        fontFamily:
          "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        fontFeatureSettings: '"cv01" on, "ss03" on, "zero" on',
      }}
    >
      <WorkspaceSidebar />

      <main className="flex-1 overflow-y-auto">
        <div className="sticky top-0 z-10 border-b border-[#161718] bg-[#08090a]/90 px-8 py-4 backdrop-blur-md">
          <span
            className="text-[12px] text-[#62666d]"
            style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}
          >
            {breadcrumb}
          </span>
        </div>

        <Outlet />
      </main>
    </div>
  );
}
