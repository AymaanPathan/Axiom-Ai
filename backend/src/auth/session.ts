import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET!;
const SESSION_TTL = "7d";

export interface SessionPayload {
  githubId: string;
  username: string;
  avatarUrl: string;
  githubAccessToken: string; // NOTE: fine for hackathon scope. For anything beyond
  // a demo, don't put the raw GitHub token inside a client-readable JWT — store it
  // server-side (DB/Redis) keyed by a session id instead.
}

export function createSessionToken(payload: SessionPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: SESSION_TTL });
}

export function verifySessionToken(token: string): SessionPayload {
  return jwt.verify(token, JWT_SECRET) as SessionPayload;
}
