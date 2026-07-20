import { useEffect } from "react";
import { Navigate } from "react-router-dom";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { checkSession } from "../store/slices/authSlice";

export default function RequireAuth({ children }: { children: React.ReactNode }) {
  const dispatch = useAppDispatch();
  const { status } = useAppSelector((s) => s.auth);

  useEffect(() => {
    if (status === "idle") {
      dispatch(checkSession());
    }
  }, [status, dispatch]);

  if (status === "idle" || status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#08090a]">
        <span className="text-[13px] text-[#62666d]">Loading workspace…</span>
      </div>
    );
  }

  if (status === "unauthenticated" || status === "error") {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
