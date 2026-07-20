import { Octokit } from "octokit";

export function getOctokit(accessToken: string) {
  return new Octokit({ auth: accessToken });
}

export async function listUserRepos(accessToken: string) {
  const octokit = getOctokit(accessToken);
  const repos = await octokit.paginate(
    octokit.rest.repos.listForAuthenticatedUser,
    {
      per_page: 100,
      sort: "updated",
    },
  );

  return repos.map((r : any) => ({
    id: r.id,
    fullName: r.full_name,
    owner: r.owner.login,
    name: r.name,
    private: r.private,
    defaultBranch: r.default_branch,
    updatedAt: r.updated_at,
    cloneUrl: r.clone_url,
  }));
}

export async function getRepo(
  accessToken: any,
  owner: any,
  repo: any,
) {
  const octokit = getOctokit(accessToken);
  const { data } = await octokit.rest.repos.get({ owner, repo });
  return {
    fullName: data.full_name,
    defaultBranch: data.default_branch,
    cloneUrl: data.clone_url,
  };
}
