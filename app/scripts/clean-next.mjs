/**
 * Always remove app/.next regardless of npm workspace cwd (fixes rm .next at repo root).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextDir = path.join(appRoot, ".next");

if (fs.existsSync(nextDir)) {
  fs.rmSync(nextDir, { recursive: true, force: true });
  console.log("[clean-next] removed", nextDir);
} else {
  console.log("[clean-next] skip (not found):", nextDir);
}
