import { Outlet } from "react-router-dom";

/**
 * Axiom AI — Workspace shell
 * Persistent sidebar + topbar; the actual page (repo list, repo detail,
 * eventually benchmarks/settings) renders through <Outlet/>. Only ever
 * rendered inside <RequireAuth>, so a valid session can be assumed here.
 */
export default function Workspace() {


  return (
    <div
      className="flex min-h-screen bg-[#08090a] text-[#d0d6e0] antialiased"
      style={{
        fontFamily:
          "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        fontFeatureSettings: '"cv01" on, "ss03" on, "zero" on',
      }}
    >

      <main className="flex-1 overflow-y-auto">


        <Outlet />
      </main>
    </div>
  );
}
