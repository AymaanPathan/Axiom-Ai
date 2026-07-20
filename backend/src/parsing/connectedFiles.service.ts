import path from "node:path";
import fs from "node:fs/promises";

export interface ConnectedFile {
  path: string; // relative to repo root, forward-slashed for display
  role: "route" | "controller" | "service" | "other";
  content: string;
  startLine: number;
  endLine: number;
  highlightLine?: number;
}

export interface ConnectedFilesResult {
  files: ConnectedFile[];
  requestBodyFields: string[];
}

const RESOLVABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const MAX_HOPS = 2; // route -> controller -> one further hop (service/model)
const MAX_FILE_CHARS = 4000;
const ROUTE_CONTEXT_LINES = 10;

async function resolveModulePath(
  fromFile: string,
  specifier: string,
): Promise<string | null> {
  const baseDir = path.dirname(fromFile);
  const base = path.resolve(baseDir, specifier);

  const candidates = [
    base,
    ...RESOLVABLE_EXTENSIONS.map((ext) => base + ext),
    ...RESOLVABLE_EXTENSIONS.map((ext) => path.join(base, "index" + ext)),
  ];

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // not this one, keep trying
    }
  }
  return null;
}

// Matches `import { a, b as c } from "./x"`, `import Default from "./x"`,
// and combinations of the two. Only captures relative specifiers — local
// files are what we can walk into; npm packages are a dead end here.
function extractRelativeImports(
  source: string,
): { specifier: string; identifiers: string[] }[] {
  const results: { specifier: string; identifiers: string[] }[] = [];
  const importRegex =
    /import\s+(?:(\w+)\s*,\s*)?(?:\{([^}]*)\})?\s*from\s+["'](\.[^"']+)["']/g;

  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(source))) {
    const [, defaultName, namedBlock, specifier] = match;
    const identifiers: string[] = [];
    if (defaultName) identifiers.push(defaultName.trim());
    if (namedBlock) {
      namedBlock
        .split(",")
        .map((s) =>
          s
            .trim()
            .split(/\s+as\s+/)
            .pop()!
            .trim(),
        )
        .filter(Boolean)
        .forEach((id) => identifiers.push(id));
    }
    if (identifiers.length > 0) results.push({ specifier, identifiers });
  }
  return results;
}

// Pulls the handler reference off a route-registration line, e.g.
// `router.get("/", listProducts)` -> "listProducts", or
// `router.post("/", checkoutController.create)` -> "checkoutController.create"
function extractHandlerIdentifier(lineText: string): string | null {
  const match = lineText.match(/router\.\w+\(\s*["'][^"']*["']\s*,\s*([\w.]+)/);
  return match ? match[1] : null;
}

function findFunctionBody(
  source: string,
  functionName: string,
): { content: string; startLine: number; endLine: number } | null {
  const patterns = [
    new RegExp(`(export\\s+)?(async\\s+)?function\\s+${functionName}\\s*\\(`),
    new RegExp(`(export\\s+)?const\\s+${functionName}\\s*=\\s*(async\\s*)?\\(`),
  ];

  const lines = source.split("\n");
  for (const pattern of patterns) {
    for (let i = 0; i < lines.length; i++) {
      if (!pattern.test(lines[i])) continue;

      let depth = 0;
      let started = false;
      let endLineIdx = i;
      for (let j = i; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === "{") {
            depth++;
            started = true;
          }
          if (ch === "}") depth--;
        }
        if (started && depth <= 0) {
          endLineIdx = j;
          break;
        }
      }
      const endLine = Math.min(lines.length, endLineIdx + 1);
      return {
        content: lines.slice(i, endLine).join("\n"),
        startLine: i + 1,
        endLine,
      };
    }
  }
  return null;
}

function extractBodyFields(handlerSource: string): string[] {
  const fields = new Set<string>();

  const destructureMatch = handlerSource.match(/\{([^}]+)\}\s*=\s*req\.body/);
  if (destructureMatch) {
    destructureMatch[1]
      .split(",")
      .map((f) => f.trim().split(":")[0].split("=")[0].trim())
      .filter(Boolean)
      .forEach((f) => fields.add(f));
  }

  const dotAccessRegex = /req\.body\.(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = dotAccessRegex.exec(handlerSource))) {
    fields.add(m[1]);
  }

  return Array.from(fields);
}

function toDisplayPath(repoRoot: string, absolute: string): string {
  return path.relative(repoRoot, absolute).split(path.sep).join("/");
}

export async function resolveConnectedFiles(
  repoRoot: string,
  entryFile: string,
  entryLine: number,
): Promise<ConnectedFilesResult> {
  const files: ConnectedFile[] = [];
  const seen = new Set<string>();
  let requestBodyFields: string[] = [];

  const entryAbsolute = path.resolve(repoRoot, entryFile);
  const entrySource = await fs.readFile(entryAbsolute, "utf8");
  const entryLines = entrySource.split("\n");
  const targetLineText = entryLines[entryLine - 1] ?? "";

  const start = Math.max(1, entryLine - ROUTE_CONTEXT_LINES);
  const end = Math.min(entryLines.length, entryLine + ROUTE_CONTEXT_LINES);
  const entryDisplayPath = toDisplayPath(repoRoot, entryAbsolute);
  files.push({
    path: entryDisplayPath,
    role: "route",
    content: entryLines.slice(start - 1, end).join("\n"),
    startLine: start,
    endLine: end,
    highlightLine: entryLine,
  });
  seen.add(entryDisplayPath);

  const handlerIdentifier = extractHandlerIdentifier(targetLineText);
  if (!handlerIdentifier) return { files, requestBodyFields };

  const rootIdentifier = handlerIdentifier.split(".")[0];
  const entryImports = extractRelativeImports(entrySource);
  const matchingImport = entryImports.find((imp) =>
    imp.identifiers.includes(rootIdentifier),
  );
  if (!matchingImport) return { files, requestBodyFields };

  // Walk hop by hop: route -> controller -> (best-effort) one more file it
  // imports, e.g. a service or model. Queue-based rather than recursive
  // closures to keep the control flow easy to follow.
  const queue: {
    specifier: string;
    fromFile: string;
    identifier: string;
    role: ConnectedFile["role"];
    hop: number;
  }[] = [
    {
      specifier: matchingImport.specifier,
      fromFile: entryAbsolute,
      identifier: handlerIdentifier,
      role: "controller",
      hop: 1,
    },
  ];

  while (queue.length > 0) {
    const { specifier, fromFile, identifier, role, hop } = queue.shift()!;
    if (hop > MAX_HOPS) continue;

    const resolved = await resolveModulePath(fromFile, specifier);
    if (!resolved) continue;

    const displayPath = toDisplayPath(repoRoot, resolved);
    if (seen.has(displayPath)) continue;
    seen.add(displayPath);

    const source = await fs.readFile(resolved, "utf8");
    const fnName = identifier.split(".").pop()!;
    const fn = findFunctionBody(source, fnName);

    if (fn) {
      files.push({
        path: displayPath,
        role,
        content: fn.content.slice(0, MAX_FILE_CHARS),
        startLine: fn.startLine,
        endLine: fn.endLine,
      });
      if (role === "controller") {
        requestBodyFields = extractBodyFields(fn.content);
      }
    } else {
      const lines = source.split("\n");
      files.push({
        path: displayPath,
        role,
        content: lines.slice(0, 40).join("\n"),
        startLine: 1,
        endLine: Math.min(40, lines.length),
      });
    }

    if (hop >= MAX_HOPS) continue;

    // Follow this file's own relative imports one more hop (e.g. the
    // service or model the controller calls into). Best-effort: cap how
    // many we chase to avoid pulling in an entire dependency graph.
    const nestedImports = extractRelativeImports(source).slice(0, 3);
    for (const nested of nestedImports) {
      const nextIdentifier = nested.identifiers[0];
      if (!nextIdentifier) continue;
      queue.push({
        specifier: nested.specifier,
        fromFile: resolved,
        identifier: nextIdentifier,
        role: "service",
        hop: hop + 1,
      });
    }
  }

  return { files, requestBodyFields };
}
