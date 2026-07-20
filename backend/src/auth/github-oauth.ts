export function getGithubAuthorizeUrl(state: string) {
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID!,
    redirect_uri: process.env.GITHUB_CALLBACK_URL!,
    scope: "repo read:user",
    state,
  });

  const url = `https://github.com/login/oauth/authorize?${params.toString()}`;

  console.log("GitHub Authorize URL:", url);

  return url;
}

export async function exchangeCodeForToken(code: string): Promise<string> {
  console.log("Authorization Code:", code);

  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID!,
      client_secret: process.env.GITHUB_CLIENT_SECRET!,
      code,
      redirect_uri: process.env.GITHUB_CALLBACK_URL!,
    }),
  });

  const data = await res.json();

  console.log("GitHub Token Response:", data);

  if (!data.access_token) {
    throw new Error(`GitHub token exchange failed: ${JSON.stringify(data)}`);
  }

  return data.access_token as string;
}

export async function fetchGithubUser(accessToken: string) {
  console.log("Access Token:", accessToken);

  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
    },
  });

  const user = await res.json();

  console.log("GitHub User:", user);

  if (!res.ok) {
    throw new Error("Failed to fetch GitHub user");
  }

  return {
    githubId: String(user.id),
    username: user.login as string,
    avatarUrl: user.avatar_url as string,
  };
}
