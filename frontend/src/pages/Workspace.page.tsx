import { Outlet } from "react-router-dom";
import { BG, SANS, TEXT_SECONDARY } from "../theme";


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
