import { NavLink, useMatch } from "react-router-dom";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { signOut } from "../store/slices/authSlice";

const NAV_ITEMS = [
  { label: "Repositories", to: "/workspace", end: true },
  { label: "Benchmarks", to: "/workspace/benchmarks", disabled: true },
  { label: "Settings", to: "/workspace/settings", disabled: true },
];

export default function WorkspaceSidebar() {
  const dispatch = useAppDispatch();
  const user = useAppSelector((s) => s.auth.user);

  const repoMatch = useMatch("/workspace/repos/:repositoryId/*");
  const repositoryId = repoMatch?.params.repositoryId;

  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col border-r border-[#161718] bg-[#08090a]">
      <div className="flex items-center gap-2 px-5 py-5">
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
          <path
            d="M10 0L20 10L10 20L0 10L10 0Z"
            stroke="#ffffff"
            strokeWidth="1.2"
            fill="none"
          />
        </svg>
        <span className="text-[15px] font-[510] tracking-[-0.011em] text-white">
          Axiom AI
        </span>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 px-3">
        {NAV_ITEMS.map((item) =>
          item.disabled ? (
            <span
              key={item.label}
              className="flex cursor-not-allowed items-center rounded-md px-3 py-[9px] text-[13px] text-[#4c4f54]"
              title="Coming soon"
            >
              {item.label}
            </span>
          ) : (
            <NavLink
              key={item.label}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex items-center rounded-md px-3 py-[9px] text-[13px] transition-colors ${
                  isActive
                    ? "bg-white/[0.06] text-white"
                    : "text-[#8a8f98] hover:bg-white/[0.03] hover:text-white"
                }`
              }
            >
              {item.label}
            </NavLink>
          ),
        )}

        {repositoryId && (
          <>
            <div className="mx-3 my-2 border-t border-[#161718]" />
            <span className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-[#4c4f54]">
              Current Repo
            </span>
            <NavLink
              to={`/workspace/repos/${repositoryId}/observability`}
              className={({ isActive }) =>
                `flex items-center rounded-md px-3 py-[9px] text-[13px] transition-colors ${
                  isActive
                    ? "bg-white/[0.06] text-white"
                    : "text-[#8a8f98] hover:bg-white/[0.03] hover:text-white"
                }`
              }
            >
              Observability
            </NavLink>
            <NavLink
              to={`/workspace/repos/${repositoryId}/endpoints`}
              className={({ isActive }) =>
                `flex items-center rounded-md px-3 py-[9px] text-[13px] transition-colors ${
                  isActive
                    ? "bg-white/[0.06] text-white"
                    : "text-[#8a8f98] hover:bg-white/[0.03] hover:text-white"
                }`
              }
            >
              Endpoints
            </NavLink>
          </>
        )}
      </nav>

      {user && (
        <div className="flex items-center gap-2 border-t border-[#161718] px-4 py-4">
          <img
            src={user.avatarUrl}
            alt={user.username}
            className="h-7 w-7 rounded-full border border-[#23252a]"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] text-[#d0d6e0]">
              {user.username}
            </p>
          </div>
          <button
            type="button"
            onClick={() => dispatch(signOut())}
            className="rounded-md px-2 py-1 text-[11px] text-[#62666d] transition-colors hover:text-white"
            title="Disconnect GitHub"
          >
            Sign out
          </button>
        </div>
      )}
    </aside>
  );
}
