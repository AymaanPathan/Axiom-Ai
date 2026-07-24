import RepoList from "../components/RepoList";
import { TEXT_PRIMARY, TEXT_TERTIARY } from "../theme";

export default function RepositoriesPage() {
  return (
    <div className="px-8 py-10">
      <div className="mb-8 flex flex-col gap-2">
        <h1
          className="text-[32px] font-semibold leading-[1.13] tracking-[-0.012em]"
          style={{ color: TEXT_PRIMARY }}
        >
          Pick a backend to analyze
        </h1>
        <p
          className="max-w-[520px] text-[15px]"
          style={{ color: TEXT_TERTIARY }}
        >
          Axiom AI clones the repo, detects the framework, and parses every
          route it finds.
        </p>
      </div>

      <RepoList />
    </div>
  );
}
