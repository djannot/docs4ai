import fs from "fs";
import path from "path";
import { app } from "electron";
import type Database from "better-sqlite3";

function extFileName() {
  if (process.platform === "win32") return "vec0.dll";
  if (process.platform === "darwin") return "vec0.dylib";
  return "vec0.so";
}

function pkgDirName() {
  if (process.platform === "win32") return "sqlite-vec-windows-x64";
  if (process.platform === "darwin") {
    return process.arch === "arm64"
      ? "sqlite-vec-darwin-arm64"
      : "sqlite-vec-darwin-x64";
  }
  return "sqlite-vec-linux-x64";
}

function firstExisting(paths: string[]) {
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function sqliteVecExtensionPath(): string {
  const file = extFileName();
  const dir = pkgDirName();

  // base for dev vs packaged
  const base = app.isPackaged
    ? path.join(process.resourcesPath, "app.asar.unpacked")
    : process.cwd();

  // Try both common layouts:
  // 1) Hoisted: node_modules/sqlite-vec-linux-x64/vec0.so
  // 2) Nested under sqlite-vec: node_modules/sqlite-vec/node_modules/sqlite-vec-linux-x64/vec0.so
  const candidates = [
    path.join(base, "node_modules", dir, file),
    path.join(base, "node_modules", "sqlite-vec", "node_modules", dir, file),
  ];

  const found = firstExisting(candidates);
  if (!found) {
    throw new Error(
      `[sqlite-vec] Extension not found. Tried:\n- ${candidates.join("\n- ")}`
    );
  }
  return found;
}

export function loadSqliteVec(db: Database.Database) {
  const extPath = sqliteVecExtensionPath();
  console.log("[sqlite-vec] loading extension:", extPath);
  db.loadExtension(extPath);
}
