import type { Request, Response, NextFunction } from "express";
import { verifySessionToken, type SessionPayload } from "../auth/session.js";

export interface AuthedRequest extends Request {
  user?: SessionPayload;
}

export function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
) {
  const token = req.cookies?.axiom_session;
  if (!token) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  try {
    req.user = verifySessionToken(token);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}
