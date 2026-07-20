import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { fetchRepoDetail } from "../store/slices/reposSlice";
import { getConnectedFiles, type ConnectedFile } from "../api/connectedFiles";
import EndpointHeader, { type RunStatus } from "../components/EndPointHeader";
import ApiOverviewPanel from "../components/ApiOverviewPanel";
import ConnectedServicesPanel, {
  type ConnectedService,
} from "../components/ConnectedServicesPanel";
import RequestSchemaPanel from "../components/RequestSchemaPanel";
import ConnectedFilesPanel from "../components/ConnectedFilesPanel";
import AIExplanationPanel from "../components/AiExplainPanel";

/**
 * Axiom AI — API Workspace
 * Detail view for a single discovered route. Everything under "Connected
 * Files" and the body fields in "Request Schema" comes from a single
 * /repos/:id/connected-files call: it walks from the route's registration
 * line into its controller (and one hop further, e.g. a service/model) via
 * relative imports, and pulls req.body usage out of the controller.
 *
 * `connectedServices` (the "what does this talk to at runtime" chain/cards)
 * still isn't backed by real detection — that's a different, heavier
 * problem (tracing actual calls, not just static imports) — so that panel
 * still renders an honest empty state.
 */
export default function ApiWorkspace() {
  const { repositoryId, routeIndex } = useParams<{
    repositoryId: string;
    routeIndex: string;
  }>();
  const dispatch = useAppDispatch();

  const repo = useAppSelector((s) =>
    repositoryId ? s.repos.byId[repositoryId] : undefined,
  );

  useEffect(() => {
    if (repositoryId && !repo) {
      dispatch(fetchRepoDetail(repositoryId));
    }
  }, [repositoryId, repo, dispatch]);

  const route = useMemo(() => {
    if (!repo || routeIndex === undefined) return undefined;
    return repo.routes[Number(routeIndex)];
  }, [repo, routeIndex]);

  const [files, setFiles] = useState<ConnectedFile[]>([]);
  const [bodyFields, setBodyFields] = useState<string[]>([]);
  const [filesStatus, setFilesStatus] = useState<
    "loading" | "loaded" | "error"
  >("loading");
  const [filesError, setFilesError] = useState<string | null>(null);

  useEffect(() => {
    if (!repositoryId || !route) return;
    let cancelled = false;
    setFilesStatus("loading");

    getConnectedFiles(repositoryId, route.file, route.line)
      .then((result) => {
        if (cancelled) return;
        setFiles(result.files);
        setBodyFields(result.requestBodyFields);
        setFilesStatus("loaded");
      })
      .catch((err) => {
        if (cancelled) return;
        setFilesError(
          err instanceof Error ? err.message : "Failed to load connected files",
        );
        setFilesStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [repositoryId, route]);

  // Derive a controller label for the overview panel from whatever file
  // the resolver tagged as "controller", if any.
  const controllerFile = files.find((f) => f.role === "controller")?.path;

  // TODO: wire to the real run status for this repo (e.g. via the runs
  // socket/store) once a route can be tied to a specific run's lifecycle.
  const status: RunStatus = "idle";

  // TODO: replace once real downstream-service detection exists (tracing
  // actual calls at runtime, not just static imports).
  const connectedServices: ConnectedService[] | undefined = undefined;

  if (!repositoryId || routeIndex === undefined) return null;

  if (!repo) {
    return (
      <div className="px-8 py-10">
        <p className="text-[13px] text-[#62666d]">Loading endpoint…</p>
      </div>
    );
  }

  if (!route) {
    return (
      <div className="px-8 py-10">
        <p className="text-[13px] text-[#eb5757]">
          This route couldn't be found on {repo.githubFullName}.
        </p>
        <Link
          to={`/workspace/repos/${repositoryId}`}
          className="mt-3 inline-block text-[13px] text-[#d0d6e0] underline decoration-dotted hover:text-white"
        >
          ← Back to {repo.githubFullName.split("/")[1]}
        </Link>
      </div>
    );
  }

  return (
    <div className="px-8 py-10">
      <Link
        to={`/workspace/repos/${repositoryId}`}
        className="mb-6 inline-block text-[13px] text-[#62666d] transition-colors hover:text-white"
      >
        ← {repo.githubFullName.split("/")[1]}
      </Link>

      <EndpointHeader
        method={route.method}
        routePath={route.routePath}
        repoName={repo.githubFullName}
        status={status}
      />

      <div className="flex flex-col gap-6">
        <AIExplanationPanel
          repositoryId={repositoryId}
          file={route.file}
          line={route.line}
        />

        <ApiOverviewPanel
          method={route.method}
          routePath={route.routePath}
          file={route.file}
          line={route.line}
          controller={controllerFile}
        />

        <ConnectedServicesPanel
          entryLabel={`${route.method} ${route.routePath}`}
          services={connectedServices}
        />

        <RequestSchemaPanel bodyFields={bodyFields} />

        <ConnectedFilesPanel
          files={files}
          status={filesStatus}
          error={filesError}
        />
      </div>
    </div>
  );
}
