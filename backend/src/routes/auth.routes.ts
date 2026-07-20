import { Router } from "express";
import { nanoid } from "nanoid";
import {
  getGithubAuthorizeUrl,
  exchangeCodeForToken,
  fetchGithubUser,
} from "../auth/github-oauth.js";
import { createSessionToken, verifySessionToken } from "../auth/session.js";

const router = Router();
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

router.get("/github", (req, res) => {
  const state = nanoid();
  res.cookie("oauth_state", state, { httpOnly: true, maxAge: 5 * 60 * 1000 });
  res.redirect(getGithubAuthorizeUrl(state));
});

router.get("/github/callback", async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string };
  const expectedState = req.cookies?.oauth_state;

  if (!code || !state || state !== expectedState) {
    return res.status(400).json({ error: "Invalid OAuth callback" });
  }

  try {
    const accessToken = await exchangeCodeForToken(code);
    const githubUser = await fetchGithubUser(accessToken);

    const sessionToken = createSessionToken({
      githubId: githubUser.githubId,
      username: githubUser.username,
      avatarUrl: githubUser.avatarUrl,
      githubAccessToken: accessToken,
    });

    res.clearCookie("oauth_state");
    res.cookie("axiom_session", sessionToken, {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: "lax",
    });

    // Send the user straight into the app, not back to the marketing page.
    res.redirect(`${FRONTEND_URL}/workspace`);
  } catch (err) {
    console.error("GitHub OAuth callback failed:", err);
    res.status(500).json({ error: "GitHub authentication failed" });
  }
});

router.get("/me", (req, res) => {
  const token = req.cookies?.axiom_session;
  if (!token) return res.status(401).json({ authenticated: false });

  try {
    const { githubId, username, avatarUrl } = verifySessionToken(token);
    res.json({ authenticated: true, user: { githubId, username, avatarUrl } });
  } catch {
    res.status(401).json({ authenticated: false });
  }
});

router.post("/logout", (req, res) => {
  res.clearCookie("axiom_session");
  res.json({ success: true });
});

export default router;
