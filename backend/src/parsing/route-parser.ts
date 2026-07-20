import fs from "fs/promises";
import path from "path";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";


const traverse =
  typeof _traverse === "function" ? _traverse : _traverse.default;

export interface DiscoveredRoute {
  method: string;
  routePath: string;
  file: string;
  line: number;
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

export async function parseRoutes(
  rootPath: string,
): Promise<DiscoveredRoute[]> {
  const { listSourceFiles } = await import("./ast-utils.js");
  const files = await listSourceFiles(rootPath);
  const routes: DiscoveredRoute[] = [];

  for (const file of files) {
    const code = await fs.readFile(file, "utf-8");
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
      CallExpression(nodePath:any) {
        const callee = nodePath.node.callee;
        if (callee.type !== "MemberExpression") return;

        const objectName =
          callee.object.type === "Identifier" ? callee.object.name : null;
        const methodName =
          callee.property.type === "Identifier" ? callee.property.name : null;

        if (!objectName || !methodName) return;
        if (!HTTP_METHODS.has(methodName)) return;

        // Only match calls on identifiers that look like an Express app/router
        // (app, router, or anything ending in "Router")
        const looksLikeExpressTarget =
          objectName === "app" ||
          objectName === "router" ||
          /router$/i.test(objectName);
        if (!looksLikeExpressTarget) return;

        const firstArg = nodePath.node.arguments[0];
        if (!firstArg || firstArg.type !== "StringLiteral") return;

        routes.push({
          method: methodName.toUpperCase(),
          routePath: firstArg.value,
          file: path.relative(rootPath, file),
          line: nodePath.node.loc?.start.line ?? 0,
        });
      },
    });
  }

  return routes;
}
