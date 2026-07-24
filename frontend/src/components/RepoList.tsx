import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  GitBranch,
  Lock,
  Globe2,
  Loader2,
  ArrowRight,
  FolderGit2,
} from "lucide-react";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { fetchRepos, connectRepository } from "../store/slices/reposSlice";
import {
  MONO,
  BG,
  SURFACE,
  SURFACE_RAISED,
  BORDER,
  BORDER_STRONG,
  TEXT_PRIMARY,
  TEXT_TERTIARY,
  TEXT_QUIET,
  ACCENT,
  ACCENT_HOVER,
  ACCENT_SOFT,
  ACCENT_TEXT,
  ERROR,
  ERROR_SOFT,
} from "../theme";

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
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="h-[76px] animate-pulse rounded-xl border"
              style={{ borderColor: BORDER, background: SURFACE }}
            />
          ))}
        </div>
      )}

      {status === "error" && (
        <div
          className="flex items-center gap-2 rounded-xl border px-4 py-3 text-[13px] font-medium"
          style={{ borderColor: ERROR, background: ERROR_SOFT, color: ERROR }}
        >
          {error}
        </div>
      )}

      {status === "loaded" && items.length === 0 && (
        <div
          className="flex flex-col items-center gap-3 rounded-2xl border border-dashed p-12 text-center"
          style={{ borderColor: BORDER_STRONG, background: SURFACE }}
        >
          <FolderGit2 size={22} style={{ color: TEXT_QUIET }} />
          <p
            className="text-[14.5px] font-semibold"
            style={{ color: TEXT_PRIMARY }}
          >
            No repositories found
          </p>
          <p className="max-w-sm text-[13px]" style={{ color: TEXT_TERTIARY }}>
            Make sure Axiom AI has access to the right GitHub account or
            organization.
          </p>
        </div>
      )}

      {connectError && (
        <div
          className="mb-4 flex items-center gap-2 rounded-xl border px-4 py-3 text-[13px] font-medium"
          style={{ borderColor: ERROR, background: ERROR_SOFT, color: ERROR }}
        >
          {connectError}
        </div>
      )}

      {status === "loaded" && items.length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((repo) => {
            const [owner, name] = repo.fullName.split("/");
            const isConnecting = connectingFullName === repo.fullName;

            return (
              <div
                key={repo.id}
                className="group flex items-center gap-3.5 rounded-xl border p-4 transition-all"
                style={{ borderColor: BORDER, background: BG }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = BORDER_STRONG;
                  e.currentTarget.style.boxShadow =
                    "0 8px 20px -12px rgba(20,20,10,0.18)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = BORDER;
                  e.currentTarget.style.boxShadow = "none";
                }}
              >
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                  style={{ background: SURFACE_RAISED }}
                >
                  <GitBranch size={15} style={{ color: TEXT_TERTIARY }} />
                </div>

                <div className="min-w-0 flex-1">
                  <p
                    className="truncate text-[13.5px] font-semibold"
                    style={{ color: TEXT_PRIMARY, fontFamily: MONO }}
                  >
                    {repo.fullName}
                  </p>
                  <div
                    className="mt-1 flex items-center gap-1.5 text-[11.5px]"
                    style={{ color: TEXT_QUIET }}
                  >
                    {repo.private ? <Lock size={11} /> : <Globe2 size={11} />}
                    <span>{repo.private ? "Private" : "Public"}</span>
                    <span>·</span>
                    <span style={{ fontFamily: MONO }}>
                      {repo.defaultBranch}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={isConnecting}
                  onClick={() => handleConnect(owner, name)}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-[7px] text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                  style={{
                    background: isConnecting ? ACCENT_SOFT : ACCENT,
                    color: isConnecting ? ACCENT_TEXT : "#1a1400",
                  }}
                  onMouseEnter={(e) => {
                    if (!isConnecting)
                      e.currentTarget.style.background = ACCENT_HOVER;
                  }}
                  onMouseLeave={(e) => {
                    if (!isConnecting)
                      e.currentTarget.style.background = ACCENT;
                  }}
                >
                  {isConnecting ? (
                    <>
                      <Loader2 size={12} className="animate-spin" /> Connecting
                    </>
                  ) : (
                    <>
                      Connect <ArrowRight size={12} />
                    </>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
