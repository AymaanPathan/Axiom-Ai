import { Outlet } from "react-router-dom";
import { BG, SANS, TEXT_SECONDARY } from "../theme";

/**
 * Axiom AI — Workspace shell
 * Persistent sidebar + topbar; the actual page (repo list, repo detail,
 * eventually benchmarks/settings) renders through <Outlet/>. Only ever
 * rendered inside <RequireAuth>, so a valid session can be assumed here.
 */
export default function Workspace() {
  return (
    <div
      className="flex min-h-screen antialiased"
      style={{ background: BG, color: TEXT_SECONDARY, fontFamily: SANS }}
    >
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
