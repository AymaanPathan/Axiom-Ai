import { Project, SyntaxKind, type Node } from "ts-morph";

const IGNORE_LIST = new Set(["NODE_ENV"]);

function hasFallback(node: Node): boolean {
  const parent = node.getParent();
  if (!parent) return false;

  if (parent.getKind() === SyntaxKind.BinaryExpression) {
    const bin = parent.asKindOrThrow(SyntaxKind.BinaryExpression);
    const op = bin.getOperatorToken().getText();
    if ((op === "||" || op === "??") && bin.getLeft() === node) {
      return true;
    }
  }
  return false;
}

function isProcessEnv(node: Node): boolean {
  if (node.getKind() !== SyntaxKind.PropertyAccessExpression) return false;
  const pae = node.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
  return pae.getExpression().getText() === "process" && pae.getName() === "env";
}

export async function detectRequiredEnvVars(
  repoPath: string,
): Promise<string[]> {
  const project = new Project({ skipAddingFilesFromTsConfig: true });

  project.addSourceFilesAtPaths([
    `${repoPath}/**/*.{ts,tsx,js,jsx,mjs,cjs}`,
    `!${repoPath}/**/node_modules/**`,
    `!${repoPath}/**/dist/**`,
    `!${repoPath}/**/build/**`,
    `!${repoPath}/**/.git/**`,
  ]);

  const found = new Set<string>();

  for (const sourceFile of project.getSourceFiles()) {
    sourceFile.forEachDescendant((node) => {
      // process.env.FOO
      if (node.getKind() === SyntaxKind.PropertyAccessExpression) {
        const pae = node.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
        if (isProcessEnv(pae.getExpression()) && !hasFallback(pae)) {
          found.add(pae.getName());
        }
      }

      // process.env["FOO"] / process.env['FOO']
      if (node.getKind() === SyntaxKind.ElementAccessExpression) {
        const eae = node.asKindOrThrow(SyntaxKind.ElementAccessExpression);
        if (isProcessEnv(eae.getExpression()) && !hasFallback(eae)) {
          const arg = eae.getArgumentExpression();
          if (arg?.getKind() === SyntaxKind.StringLiteral) {
            found.add(
              arg.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText(),
            );
          }
        }
      }
    });
  }

  return Array.from(found)
    .filter((key) => !IGNORE_LIST.has(key))
    .sort();
}
