import fs from "fs/promises";
import path from "path";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import {
  extractRelativeImports,
  resolveModulePath,
} from "./connectedFiles.service.js";

const traverse =
  typeof _traverse === "function" ? _traverse : _traverse.default;

export interface DiscoveredRoute {
  method: string;
  routePath: string;
  file: string;
  line: number;
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

interface RawRoute {
  method: string;
  routePath: string;
  file: string; // absolute, resolved to a relative path only at the end
  line: number;
}

interface MountCall {
  fromFile: string; // absolute path of the file containing the .use(...) call
  identifierName: string; // the local name of the router being mounted
  prefix: string;
}

interface MountEdge {
  fromFile: string;
  toFile: string; // absolute path of the resolved router module
  prefix: string;
}

// Joins a route prefix with a route's own path the way Express does:
// collapses a trailing slash on the base, and treats "/" on the segment
// side as "no additional segment" rather than literally appending "/".
function joinRoutePrefix(base: string, segment: string): string {
  const normalizedBase = base.replace(/\/+$/, "");
  const normalizedSegment = segment.startsWith("/") ? segment : `/${segment}`;
  if (normalizedSegment === "/") return normalizedBase || "/";
  return `${normalizedBase}${normalizedSegment}` || "/";
}

export async function parseRoutes(
  rootPath: string,
): Promise<DiscoveredRoute[]> {
  const { listSourceFiles } = await import("./ast-utils.js");
  const files = await listSourceFiles(rootPath);

  const rawRoutes: RawRoute[] = [];
  const mountCalls: MountCall[] = [];
  const fileSources = new Map<string, string>();

  for (const file of files) {
    const code = await fs.readFile(file, "utf-8");
    fileSources.set(file, code);

    let ast;
    try {
      ast = parse(code, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
      });
    } catch {
      // Skip files that fail to parse (non-JS/TS assets, malformed files, etc.)
      continue;
    }

    traverse(ast, {
      CallExpression(nodePath: any) {
        const callee = nodePath.node.callee;
        if (callee.type !== "MemberExpression") return;

        const objectName =
          callee.object.type === "Identifier" ? callee.object.name : null;
        const methodName =
          callee.property.type === "Identifier" ? callee.property.name : null;
        if (!objectName || !methodName) return;

        // Only match calls on identifiers that look like an Express app/router
        // (app, router, or anything ending in "Router")
        const looksLikeExpressTarget =
          objectName === "app" ||
          objectName === "router" ||
          /router$/i.test(objectName);
        if (!looksLikeExpressTarget) return;

        const args = nodePath.node.arguments;

        // Route registration: router.get("/", handler)
        if (HTTP_METHODS.has(methodName)) {
          const firstArg = args[0];
          if (firstArg && firstArg.type === "StringLiteral") {
            rawRoutes.push({
              method: methodName.toUpperCase(),
              routePath: firstArg.value,
              file,
              line: nodePath.node.loc?.start.line ?? 0,
            });
          }
          return;
        }

        // Mount point: app.use("/checkout", checkoutRoute). We only need
        // the identifier name here — resolving it to an actual file needs
        // this file's own imports, which we do in a second pass below
        // once every file's source has been read.
        if (methodName === "use") {
          const [firstArg, secondArg] = args;
          if (
            firstArg?.type === "StringLiteral" &&
            secondArg?.type === "Identifier"
          ) {
            mountCalls.push({
              fromFile: file,
              identifierName: secondArg.name,
              prefix: firstArg.value,
            });
          }
        }
      },
    });
  }

  // Resolve each mount call's router identifier to the actual file it was
  // imported from, using the same relative-import resolver connected-files
  // uses to walk route -> controller -> service.
  const mountEdges: MountEdge[] = [];
  for (const call of mountCalls) {
    const source = fileSources.get(call.fromFile) ?? "";
    const imports = extractRelativeImports(source);
    const matching = imports.find((imp) =>
      imp.identifiers.includes(call.identifierName),
    );
    if (!matching) continue;

    const resolved = await resolveModulePath(call.fromFile, matching.specifier);
    if (!resolved) continue;

    mountEdges.push({
      fromFile: call.fromFile,
      toFile: resolved,
      prefix: call.prefix,
    });
  }

  // Propagate prefixes through the mount graph to a fixed point, so a
  // chain like app.ts -("/api")-> apiRouter.ts -("/checkout")-> checkout.route.ts
  // ends up with the full "/api/checkout" prefix on checkout's own routes,
  // not just the last hop.
  const effectivePrefix = new Map<string, string>();
  for (let i = 0; i < 5; i++) {
    let changed = false;
    for (const edge of mountEdges) {
      const base = effectivePrefix.get(edge.fromFile) ?? "";
      const combined = joinRoutePrefix(base, edge.prefix);
      if (effectivePrefix.get(edge.toFile) !== combined) {
        effectivePrefix.set(edge.toFile, combined);
        changed = true;
      }
    }
    if (!changed) break;
  }

  return rawRoutes.map((route) => {
    const prefix = effectivePrefix.get(route.file) ?? "";
    return {
      method: route.method,
      routePath: joinRoutePrefix(prefix, route.routePath),
      file: path.relative(rootPath, route.file),
      line: route.line,
    };
  });
}
