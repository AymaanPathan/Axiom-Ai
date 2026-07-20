import {simpleGit} from "simple-git";
import path from "path";
import fs from "fs/promises";
import { nanoid } from "nanoid";

const WORKSPACES_DIR = path.resolve(process.cwd(), "workspaces");

export async function cloneRepo(
  cloneUrl: any,
  accessToken: any,
  owner: any,
  repoName: any,
) {
  await fs.mkdir(WORKSPACES_DIR, { recursive: true });

  const repoId = `${owner}-${repoName}-${nanoid(6)}`;
  const localPath = path.join(WORKSPACES_DIR, repoId);

  // Inject the access token into the clone URL so private repos work too
  const authedUrl = cloneUrl.replace(
    "https://",
    `https://x-access-token:${accessToken}@`,
  );

  const git = simpleGit();
  await git.clone(authedUrl, localPath, ["--depth", "1"]);

  return { repoId, localPath };
}
