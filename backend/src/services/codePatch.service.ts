import { createTwoFilesPatch } from "diff";
import fs from "node:fs/promises";
import path from "node:path";

export interface PatchResult {
  applied: boolean;
  newContent?: string;
  originalContent?: string;
  error?: string;
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
function locateSnippet(haystack: string, needle: string): string | null {
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
// match the body (see: this exact bug), and there is no reliable way to
// "fix" a malformed hunk without risking silently corrupting the file.
// A snippet search-and-replace has no such failure mode: it either finds
// the block or it doesn't.
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

export async function revertFile(
  repoRoot: string,
  filePath: string,
  originalContent: string,
): Promise<void> {
  const absolutePath = path.resolve(repoRoot, filePath);
  await fs.writeFile(absolutePath, originalContent, "utf8");
}

// Purely cosmetic — builds a unified diff string from the two snippets so
// the DiffViewer can still render +/- lines. This is a generation-only
// operation (never parsed back), so it can't hit the malformed-hunk bug.
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
