// services/codePatch.service.ts
import { createTwoFilesPatch } from "diff";
import fs from "node:fs/promises";
import path from "node:path";

export type FileChangeType = "modify" | "create";

export interface PatchResult {
  applied: boolean;
  newContent?: string;
  originalContent?: string;
  error?: string;
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

// Replaces an exact (or whitespace-fuzzy) code snippet in a real file on
// disk. This deliberately avoids unified-diff parsing entirely — LLM-
// generated diffs frequently have hunk headers whose line counts don't
// match the body, and there is no reliable way to "fix" a malformed hunk
// without risking silently corrupting the file. A snippet search-and-
// replace has no such failure mode: it either finds the block or it doesn't.
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

  const matched = locateSnippet(originalContent, originalCode);
  if (matched === null) {
    return {
      applied: false,
      originalContent,
      error:
        "The AI-suggested code block couldn't be located in the current file — it may have changed since the fix was generated.",
    };
  }

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
export async function applyStrategyChanges(
  repoRoot: string,
  changes: FileChangeInput[],
): Promise<ApplyChangesResult> {
  const resolvedRoot = path.resolve(repoRoot);
  const applied: FileChangeApplyRecord[] = [];

  const rollback = async () => {
    for (const record of [...applied].reverse()) {
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
          results: applied,
          error: result.error,
          failedFilePath: change.filePath,
        };
      }
      applied.push({ filePath: change.filePath, changeType: "create" });
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
          results: applied,
          error: result.error,
          failedFilePath: change.filePath,
        };
      }
      applied.push({
        filePath: change.filePath,
        changeType: "modify",
        originalContent: result.originalContent,
      });
    }
  }

  return { applied: true, results: applied };
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
