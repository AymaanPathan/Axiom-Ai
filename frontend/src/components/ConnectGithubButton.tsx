import { useEffect } from "react";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { checkSession, signOut } from "../store/slices/authSlice";
import { getGithubConnectUrl } from "../api/auth";

export default function ConnectGithubButton() {
  const dispatch = useAppDispatch();
  const { status, user } = useAppSelector((s) => s.auth);

  useEffect(() => {
    dispatch(checkSession());
  }, [dispatch]);

  if (status === "idle" || status === "loading") {
    return (
      <span className="rounded-full border border-[#23252a] bg-white/[0.03] px-4 py-2 text-[13px] text-[#62666d]">
        Checking GitHub…
      </span>
    );
  }

  if (status === "authenticated" && user) {
    return (
      <div className="flex items-center gap-2">
        <img
          src={user.avatarUrl}
          alt={user.username}
          className="h-6 w-6 rounded-full border border-[#23252a]"
        />
        <span className="hidden text-[13px] text-[#d0d6e0] sm:inline">
          {user.username}
        </span>
        <button
          type="button"
          onClick={() => dispatch(signOut())}
          className="rounded-full border border-[#23252a] px-3 py-[6px] text-[12px] text-[#8a8f98] transition-colors hover:border-[#383b3f] hover:text-white"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <a
      href={getGithubConnectUrl()}
      className="flex items-center gap-2 rounded-full bg-[#e4f222] px-4 py-2 text-[13px] font-[510] tracking-[-0.011em] text-[#08090a] transition-opacity hover:opacity-90"
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 16 16"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
      </svg>
      Connect GitHub
    </a>
  );
}
