import fs from "node:fs/promises";
import path from "node:path";

// Best-effort, regex-based — same philosophy as the rest of the parsing
// layer (route-parser, env-detect): looks at the route's own registration
// line for common auth-middleware identifiers. Won't catch everything
// (e.g. auth applied at the router/app level via app.use()), but catches
// the common case of `router.post("/x", requireAuth, handler)`.
const AUTH_MIDDLEWARE_PATTERNS = [
  /requireAuth/i,
  /isAuthenticated/i,
  /authenticate/i,
  /verifyToken/i,
  /verifyJWT/i,
  /passport\.authenticate/i,
  /checkAuth/i,
  /\bprotect\b/i,
  /jwtMiddleware/i,
  /ensureLoggedIn/i,
  /requireLogin/i,
];

export async function detectRouteMiddlewares(
  repoRoot: string,
  file: string,
  line: number,
): Promise<string[]> {
  try {
    const absolutePath = path.resolve(repoRoot, file);
    const content = await fs.readFile(absolutePath, "utf8");
    const lines = content.split("\n");
    const targetLine = lines[line - 1] ?? "";

    const found = new Set<string>();
    for (const pattern of AUTH_MIDDLEWARE_PATTERNS) {
      const match = targetLine.match(pattern);
      if (match) found.add(match[0]);
    }
    return Array.from(found);
  } catch {
    return [];
  }
}
