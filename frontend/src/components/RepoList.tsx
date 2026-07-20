import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { fetchRepos, connectRepository } from "../store/slices/reposSlice";

/**
 * Repo grid, meant to live inside the Workspace page shell.
 * Assumes the caller has already confirmed the user is authenticated.
 * On successful connect, navigates straight to the repo detail page —
 * no inline "connected" banner here anymore.
 */
export default function RepoList() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const { items, status, error, connectingFullName, connectError } =
    useAppSelector((s) => s.repos);

  useEffect(() => {
    dispatch(fetchRepos());
  }, [dispatch]);

  async function handleConnect(owner: string, name: string) {
    const result = await dispatch(connectRepository({ owner, repo: name }));
    if (connectRepository.fulfilled.match(result)) {
      navigate(`/workspace/repos/${result.payload.repositoryId}`);
    }
  }

  return (
    <div>
      {status === "loading" && (
        <div className="flex flex-col gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-[60px] animate-pulse rounded-xl border border-[#23252a] bg-[#0f1011]"
            />
          ))}
        </div>
      )}

      {status === "error" && (
        <p className="text-[13px] text-[#eb5757]">{error}</p>
      )}

      {status === "loaded" && items.length === 0 && (
        <div className="rounded-xl border border-dashed border-[#23252a] p-10 text-center">
          <p className="text-[14px] text-[#d0d6e0]">No repositories found</p>
          <p className="mt-1 text-[13px] text-[#62666d]">
            Make sure Axiom AI has access to the right GitHub account or
            organization.
          </p>
        </div>
      )}

      {connectError && (
        <p className="mb-4 text-[13px] text-[#eb5757]">{connectError}</p>
      )}

      {status === "loaded" && items.length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((repo) => {
            const [owner, name] = repo.fullName.split("/");
            const isConnecting = connectingFullName === repo.fullName;

            return (
              <div
                key={repo.id}
                className="flex items-center justify-between rounded-xl border border-[#23252a] bg-[#0f1011] p-4 transition-colors hover:border-[#383b3f]"
              >
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-[510] text-white">
                    {repo.fullName}
                  </p>
                  <p className="text-[12px] text-[#62666d]">
                    {repo.private ? "Private" : "Public"} · {repo.defaultBranch}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={isConnecting}
                  onClick={() => handleConnect(owner, name)}
                  className="shrink-0 rounded-md border border-[#23252a] px-3 py-[6px] text-[12px] font-[510] text-[#d0d6e0] transition-colors hover:border-[#383b3f] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isConnecting ? "Connecting…" : "Connect"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
