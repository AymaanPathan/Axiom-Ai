import fs from "fs/promises";
import path from "path";

export async function detectFramework(
  localPath: string,
): Promise<"express" | "unknown"> {
  const pkgPath = path.join(localPath, "package.json");
  try {
    const raw = await fs.readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(raw);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.express) return "express";
    return "unknown";
  } catch {
    return "unknown";
  }
}
