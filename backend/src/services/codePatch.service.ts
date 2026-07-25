import { createTwoFilesPatch } from "diff";
import fs from "node:fs/promises";
import path from "node:path";

export type FileChangeType = "modify" | "create";

export interface PatchResult {
  applied: boolean;
  newContent?: string;
  originalContent?: string;
  error?: string;
  resolvedFilePath?: string;
}

export interface FileChangeInput {
  filePath: string;
  changeType: FileChangeType;
  originalCode?: string; // required for "modify", ignored for "create"
  newCode: string;
}

export interface FileChangeApplyRecord {
  filePath: string;
  changeType: FileChangeType;
  originalContent?: string; // "modify" only — undefined for "create" (revert = delete)
}

export interface ApplyChangesResult {
  applied: boolean;
  results: FileChangeApplyRecord[];
  error?: string;
  failedFilePath?: string;
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "workspaces",
]);
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

// Cap how many files we'll ever fuzzy-scan in the repo-wide fallback —
// this only runs after both the exact and fuzzy match already failed on
// the stated file, so it's rare, but a runaway monorepo shouldn't turn a
// single failed patch into a multi-second directory crawl.
const MAX_REPO_SCAN_FILES = 2000;

// Walks the repo (skipping common noise dirs) and returns every source
// file's absolute path. Used only by the repo-wide fallback below, for
// when the model's stated filePath is stale (file moved/renamed) or it
// mis-attributed which file a code block came from.
export async function listSourceFiles(rootPath: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string) {
    if (results.length >= MAX_REPO_SCAN_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_REPO_SCAN_FILES) return;
      if (IGNORED_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        results.push(fullPath);
      }
    }
  }

  await walk(rootPath);
  return results;
}

// Collapses leading/trailing whitespace per line so a snippet match still
// works if the model reproduced the code with slightly different
// indentation than what's on disk (tabs vs spaces, trailing whitespace,
// etc.) — the exact-match attempt is tried first and preferred.
function normalizeForMatch(s: string): string {
  return s
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

// Looser again than normalizeForMatch: also strips a single trailing `;`
// per line and collapses '/"/` quote styles down to one placeholder
// character. Covers the next most common way an LLM reproduces "the same"
// line with cosmetic drift (quote style, optional semicolons) that
// normalizeForMatch's plain trim doesn't catch.
function normalizeForFuzzyMatch(s: string): string {
  return s
    .split("\n")
    .map((line) => line.trim().replace(/;$/, "").replace(/["'`]/g, '"'))
    .join("\n")
    .trim();
}

// Finds `needle` inside `haystack` either verbatim or, failing that, by
// normalizing whitespace on both sides and locating the same run of lines.
// Returns the exact substring of `haystack` to replace (so replacement
// preserves the file's real indentation) or null if no match is found.
export function locateSnippet(haystack: string, needle: string): string | null {
  if (haystack.includes(needle)) return needle;

  const haystackLines = haystack.split("\n");
  const needleNormalizedLines = normalizeForMatch(needle).split("\n");
  const n = needleNormalizedLines.length;

  for (let i = 0; i <= haystackLines.length - n; i++) {
    const window = haystackLines.slice(i, i + n);
    const windowNormalized = window.map((l) => l.trim()).join("\n");
    if (windowNormalized === needleNormalizedLines.join("\n")) {
      return window.join("\n");
    }
  }
  return null;
}

// Second-tier fallback, tried only after locateSnippet fails outright.
// Same sliding-window approach, but normalizes quote style and trailing
// semicolons too — catches cases like the model writing `'x'` where the
// file has `"x"`, or adding/dropping a trailing `;`.
export function locateSnippetFuzzy(
  haystack: string,
  needle: string,
): string | null {
  const haystackLines = haystack.split("\n");
  const needleNormalizedLines = normalizeForFuzzyMatch(needle).split("\n");
  const n = needleNormalizedLines.length;
  const needleJoined = needleNormalizedLines.join("\n");

  for (let i = 0; i <= haystackLines.length - n; i++) {
    const window = haystackLines.slice(i, i + n);
    const windowNormalized = normalizeForFuzzyMatch(window.join("\n"));
    if (windowNormalized === needleJoined) {
      return window.join("\n");
    }
  }
  return null;
}

// Last resort when the stated file doesn't contain the snippet at all
// (neither exact nor fuzzy): search every other source file in the repo.
// Only returns a result if EXACTLY ONE other file matches — two or more
// hits means we can't safely guess which one the model meant, so that's
// treated the same as "not found" by the caller.
async function locateSnippetAcrossRepo(
  repoRoot: string,
  excludeAbsolutePath: string,
  needle: string,
): Promise<{
  absolutePath: string;
  relativePath: string;
  matched: string;
} | null> {
  const files = await listSourceFiles(repoRoot);
  const hits: {
    absolutePath: string;
    relativePath: string;
    matched: string;
  }[] = [];

  for (const absPath of files) {
    if (absPath === excludeAbsolutePath) continue;
    let content: string;
    try {
      content = await fs.readFile(absPath, "utf8");
    } catch {
      continue;
    }
    const matched =
      locateSnippet(content, needle) ?? locateSnippetFuzzy(content, needle);
    if (matched) {
      hits.push({
        absolutePath: absPath,
        relativePath: path
          .relative(repoRoot, absPath)
          .split(path.sep)
          .join("/"),
        matched,
      });
      if (hits.length > 1) break; // ambiguous — stop early, caller treats as not-found
    }
  }

  return hits.length === 1 ? hits[0] : null;
}

// Replaces an exact (or whitespace-fuzzy) code snippet in a real file on
// disk. This deliberately avoids unified-diff parsing entirely — LLM-
// generated diffs frequently have hunk headers whose line counts don't
// match the body, and there is no reliable way to "fix" a malformed hunk
// without risking silently corrupting the file. A snippet search-and-
// replace has no such failure mode: it either finds the block or it doesn't.
//
// Match order: exact -> whitespace-fuzzy -> quote/semicolon-fuzzy, all
// against the stated file first. If none of those hit, falls back to
// scanning the rest of the repo (see locateSnippetAcrossRepo) in case the
// stated filePath is stale or the model mis-attributed the file — but
// only auto-applies if exactly one other file matches.
export async function applySnippetReplace(
  repoRoot: string,
  filePath: string,
  originalCode: string,
  newCode: string,
): Promise<PatchResult> {
  const absolutePath = path.resolve(repoRoot, filePath);
  const resolvedRoot = path.resolve(repoRoot);
  if (!absolutePath.startsWith(resolvedRoot + path.sep)) {
    return { applied: false, error: "Invalid file path" };
  }

  let originalContent: string;
  try {
    originalContent = await fs.readFile(absolutePath, "utf8");
  } catch (err) {
    return {
      applied: false,
      error: `Could not read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let matched = locateSnippet(originalContent, originalCode);
  if (matched === null) {
    matched = locateSnippetFuzzy(originalContent, originalCode);
  }

  if (matched !== null) {
    const occurrences = originalContent.split(matched).length - 1;
    if (occurrences > 1) {
      return {
        applied: false,
        originalContent,
        error:
          "The AI-suggested code block matches more than one place in the file — refusing to guess which one to replace.",
      };
    }

    const newContent = originalContent.replace(matched, newCode);
    await fs.writeFile(absolutePath, newContent, "utf8");
    return { applied: true, newContent, originalContent };
  }

  // Not found in the stated file at all, even fuzzily — try the rest of
  // the repo before giving up entirely.
  const elsewhere = await locateSnippetAcrossRepo(
    resolvedRoot,
    absolutePath,
    originalCode,
  );
  if (elsewhere) {
    let elsewhereContent: string;
    try {
      elsewhereContent = await fs.readFile(elsewhere.absolutePath, "utf8");
    } catch (err) {
      return {
        applied: false,
        originalContent,
        error: `Located a matching block in ${elsewhere.relativePath} but failed to read it: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    const occurrences = elsewhereContent.split(elsewhere.matched).length - 1;
    if (occurrences > 1) {
      return {
        applied: false,
        originalContent,
        error: `Found a matching block in ${elsewhere.relativePath}, but it appears more than once there — refusing to guess which one to replace.`,
      };
    }

    const newContent = elsewhereContent.replace(elsewhere.matched, newCode);
    await fs.writeFile(elsewhere.absolutePath, newContent, "utf8");
    return {
      applied: true,
      newContent,
      originalContent: elsewhereContent,
      resolvedFilePath: elsewhere.relativePath,
    };
  }

  return {
    applied: false,
    originalContent,
    error:
      "The AI-suggested code block couldn't be located in the current file — it may have changed since the fix was generated.",
  };
}

// Creates a brand new file. Refuses to clobber an existing file — if the
// model wants to change something that already exists, that's a "modify",
// not a "create", and should have gone through applySnippetReplace instead.
export async function createNewFile(
  repoRoot: string,
  filePath: string,
  content: string,
): Promise<PatchResult> {
  const resolvedRoot = path.resolve(repoRoot);
  const absolutePath = path.resolve(resolvedRoot, filePath);
  if (!absolutePath.startsWith(resolvedRoot + path.sep)) {
    return { applied: false, error: "Invalid file path" };
  }

  const exists = await fs
    .access(absolutePath)
    .then(() => true)
    .catch(() => false);
  if (exists) {
    return {
      applied: false,
      error: `Cannot create ${filePath} — a file already exists at that path.`,
    };
  }

  try {
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
    return { applied: true, newContent: content };
  } catch (err) {
    return {
      applied: false,
      error: `Failed to create ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function revertFile(
  repoRoot: string,
  filePath: string,
  originalContent: string,
): Promise<void> {
  const absolutePath = path.resolve(repoRoot, filePath);
  await fs.writeFile(absolutePath, originalContent, "utf8");
}

async function deleteCreatedFile(
  repoRoot: string,
  filePath: string,
): Promise<void> {
  const absolutePath = path.resolve(repoRoot, filePath);
  await fs.rm(absolutePath, { force: true }).catch(() => {});
}

// Applies every file change for a strategy, in order, as a single
// transaction: the first change that fails to apply triggers a rollback
// of everything already applied in this batch (reverting modified files,
// deleting created ones), so a partially-applicable strategy never leaves
// the working tree in a half-patched state.
//
// NOTE: if applySnippetReplace resolves a change to a different file than
// change.filePath (via the repo-wide fallback), the rollback record below
// still tracks the ORIGINAL requested filePath's slot in `results` order,
// but reverts using the actually-patched path — see the `revertPath`
// bookkeeping below.
export async function applyStrategyChanges(
  repoRoot: string,
  changes: FileChangeInput[],
): Promise<ApplyChangesResult> {
  const resolvedRoot = path.resolve(repoRoot);
  const applied: (FileChangeApplyRecord & { revertPath: string })[] = [];

  const rollback = async () => {
    for (const record of [...applied].reverse()) {
      if (record.changeType === "create") {
        await deleteCreatedFile(resolvedRoot, record.revertPath);
      } else if (record.originalContent !== undefined) {
        await revertFile(
          resolvedRoot,
          record.revertPath,
          record.originalContent,
        ).catch(() => {});
      }
    }
  };

  for (const change of changes) {
    if (change.changeType === "create") {
      const result = await createNewFile(
        resolvedRoot,
        change.filePath,
        change.newCode,
      );
      if (!result.applied) {
        await rollback();
        return {
          applied: false,
          results: applied.map(({ revertPath, ...rest }) => rest),
          error: result.error,
          failedFilePath: change.filePath,
        };
      }
      applied.push({
        filePath: change.filePath,
        changeType: "create",
        revertPath: change.filePath,
      });
    } else {
      const result = await applySnippetReplace(
        resolvedRoot,
        change.filePath,
        change.originalCode ?? "",
        change.newCode,
      );
      if (!result.applied) {
        await rollback();
        return {
          applied: false,
          results: applied.map(({ revertPath, ...rest }) => rest),
          error: result.error,
          failedFilePath: change.filePath,
        };
      }
      applied.push({
        filePath: result.resolvedFilePath ?? change.filePath,
        changeType: "modify",
        originalContent: result.originalContent,
        revertPath: result.resolvedFilePath ?? change.filePath,
      });
    }
  }

  return {
    applied: true,
    results: applied.map(({ revertPath, ...rest }) => rest),
  };
}

// Manual revert entry point — e.g. if a caller applied changes, then
// discovered a *later* failure unrelated to patching (app failed to boot,
// etc.) and needs to undo the whole batch after the fact.
export async function revertStrategyChanges(
  repoRoot: string,
  results: FileChangeApplyRecord[],
): Promise<void> {
  const resolvedRoot = path.resolve(repoRoot);
  for (const record of [...results].reverse()) {
    if (record.changeType === "create") {
      await deleteCreatedFile(resolvedRoot, record.filePath);
    } else if (record.originalContent !== undefined) {
      await revertFile(
        resolvedRoot,
        record.filePath,
        record.originalContent,
      ).catch(() => {});
    }
  }
}

// Purely cosmetic — builds a unified diff string so the DiffViewer can
// render +/- lines. Generation-only, never parsed back.
export function buildDisplayDiff(
  filePath: string,
  originalCode: string,
  newCode: string,
): string {
  return createTwoFilesPatch(
    filePath,
    filePath,
    originalCode,
    newCode,
    "",
    "",
    {
      context: 3,
    },
  );
}

// Same, but for a brand-new file — diffed against an empty original so it
// renders as an all-green "+" block.
export function buildCreateDisplayDiff(
  filePath: string,
  newCode: string,
): string {
  return createTwoFilesPatch(filePath, filePath, "", newCode, "", "", {
    context: 3,
  });
}
