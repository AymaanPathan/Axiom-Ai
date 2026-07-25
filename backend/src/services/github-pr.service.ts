import { getOctokit } from "../github/github.service.js";
import { locateSnippet } from "../services/codePatch.service.js";

export interface PrFileChange {
  filePath: string;
  changeType: "modify" | "create";
  originalCode?: string; // required for "modify"
  newCode: string;
}

export interface CreatePrParams {
  accessToken: string;
  owner: string;
  repo: string;
  baseBranch: string;
  branchName: string;
  commitMessage: string;
  prTitle: string;
  prBody: string;
  changes: PrFileChange[];
}

export interface CreatePrResult {
  prUrl: string;
  prNumber: number;
  branchName: string;
}

export class PrCreationError extends Error {
  constructor(
    message: string,
    public filePath?: string,
  ) {
    super(message);
  }
}

// Fetches + decodes a file's current content directly from GitHub at `ref`.
async function fetchCurrentFileContent(
  octokit: ReturnType<typeof getOctokit>,
  owner: string,
  repo: string,
  filePath: string,
  ref: string,
): Promise<string> {
  const { data } = await octokit.rest.repos.getContent({
    owner,
    repo,
    path: filePath,
    ref,
  });
  if (
    Array.isArray(data) ||
    data.type !== "file" ||
    data.content === undefined
  ) {
    throw new PrCreationError(
      `"${filePath}" isn't a readable single file on ${ref}`,
      filePath,
    );
  }
  return Buffer.from(data.content, "base64").toString("utf8");
}

// Re-derives the full patched file by re-locating the strategy's
// originalCode snippet against the file's CURRENT content on GitHub —
// not the possibly-stale copy the strategy was generated against. Same
// exact-then-fuzzy match + uniqueness check as the local apply flow.
function applySnippetToContent(
  currentContent: string,
  originalCode: string,
  newCode: string,
  filePath: string,
): string {
  const matched = locateSnippet(currentContent, originalCode);
  if (matched === null) {
    throw new PrCreationError(
      `Couldn't locate the expected code block in "${filePath}" — it may have changed on GitHub since this strategy was generated.`,
      filePath,
    );
  }
  if (currentContent.split(matched).length - 1 > 1) {
    throw new PrCreationError(
      `The code block in "${filePath}" now matches more than one place — refusing to guess which one to replace.`,
      filePath,
    );
  }
  return currentContent.replace(matched, newCode);
}

// One commit (blobs -> tree -> commit) for every file change, pushed to a
// new branch off baseBranch, then a PR opened against it.
export async function createStrategyPullRequest(
  params: CreatePrParams,
): Promise<CreatePrResult> {
  const octokit = getOctokit(params.accessToken);
  const { owner, repo, baseBranch } = params;

  const { data: refData } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${baseBranch}`,
  });
  const baseSha = refData.object.sha;
  const { data: baseCommit } = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: baseSha,
  });

  const treeItems = await Promise.all(
    params.changes.map(async (change) => {
      let content: string;
      if (change.changeType === "create") {
        content = change.newCode;
      } else {
        if (!change.originalCode) {
          throw new PrCreationError(
            `"${change.filePath}" is a modify change with no originalCode.`,
            change.filePath,
          );
        }
        const current = await fetchCurrentFileContent(
          octokit,
          owner,
          repo,
          change.filePath,
          baseBranch,
        );
        content = applySnippetToContent(
          current,
          change.originalCode,
          change.newCode,
          change.filePath,
        );
      }

      const { data: blob } = await octokit.rest.git.createBlob({
        owner,
        repo,
        content: Buffer.from(content, "utf8").toString("base64"),
        encoding: "base64",
      });

      return {
        path: change.filePath,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blob.sha,
      };
    }),
  );

  const { data: newTree } = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseCommit.tree.sha,
    tree: treeItems,
  });

  const { data: newCommit } = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: params.commitMessage,
    tree: newTree.sha,
    parents: [baseSha],
  });

  // Branch name collision (e.g. same strategy PR'd twice) — retry once with a suffix.
  let branchName = params.branchName;
  try {
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: newCommit.sha,
    });
  } catch (err: any) {
    if (err.status !== 422) throw err;
    branchName = `${branchName}-${Date.now().toString(36)}`;
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: newCommit.sha,
    });
  }

  const { data: pr } = await octokit.rest.pulls.create({
    owner,
    repo,
    title: params.prTitle,
    body: params.prBody,
    head: branchName,
    base: baseBranch,
  });

  return { prUrl: pr.html_url, prNumber: pr.number, branchName };
}
