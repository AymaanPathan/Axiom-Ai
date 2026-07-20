import { Project, SyntaxKind, type Node } from "ts-morph";

const DEFAULT_PORT = 3000;
const MAX_RESOLVE_DEPTH = 5; // guards against pathological reference chains

function resolveIdentifierInitializer(node: Node): Node | null {
  if (node.getKind() !== SyntaxKind.Identifier) return null;
  const identifier = node.asKindOrThrow(SyntaxKind.Identifier);
  const symbol = identifier.getSymbol();
  if (!symbol) return null;

  for (const decl of symbol.getDeclarations()) {
    if (decl.getKind() === SyntaxKind.VariableDeclaration) {
      const varDecl = decl.asKindOrThrow(SyntaxKind.VariableDeclaration);
      const initializer = varDecl.getInitializer();
      if (initializer) return initializer;
    }
  }
  return null;
}

function extractNumericLiteral(node: Node, depth = 0): number | null {
  if (depth > MAX_RESOLVE_DEPTH) return null;

  if (node.getKind() === SyntaxKind.NumericLiteral) {
    return Number(node.getText());
  }

  // Handles `process.env.PORT || 4000` and `process.env.PORT ?? 4000`
  if (node.getKind() === SyntaxKind.BinaryExpression) {
    const bin = node.asKindOrThrow(SyntaxKind.BinaryExpression);
    const op = bin.getOperatorToken().getText();
    if (op === "||" || op === "??") {
      return extractNumericLiteral(bin.getRight(), depth + 1);
    }
  }

  // Handles `const PORT = process.env.PORT || 4000; app.listen(PORT, ...)`
  if (node.getKind() === SyntaxKind.Identifier) {
    const resolved = resolveIdentifierInitializer(node);
    if (resolved) return extractNumericLiteral(resolved, depth + 1);
  }

  // Handles `app.listen(Number(process.env.PORT) || 4000, ...)`
  if (node.getKind() === SyntaxKind.CallExpression) {
    const call = node.asKindOrThrow(SyntaxKind.CallExpression);
    if (call.getExpression().getText() === "Number") {
      const arg = call.getArguments()[0];
      if (arg) return extractNumericLiteral(arg, depth + 1);
    }
  }

  return null;
}

export async function detectAppPort(repoPath: string): Promise<number> {
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  project.addSourceFilesAtPaths([
    `${repoPath}/**/*.{ts,tsx,js,jsx,mjs,cjs}`,
    `!${repoPath}/**/node_modules/**`,
    `!${repoPath}/**/dist/**`,
    `!${repoPath}/**/build/**`,
  ]);

  for (const sourceFile of project.getSourceFiles()) {
    const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const call of calls) {
      const expr = call.getExpression();
      if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
      const pae = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      if (pae.getName() !== "listen") continue;

      const args = call.getArguments();
      if (args.length === 0) continue;

      const port = extractNumericLiteral(args[0]);
      if (port !== null) return port;
    }
  }

  return DEFAULT_PORT;
}
