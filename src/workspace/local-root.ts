import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { debug } from "../debug.js";

/**
 * Create `.canvas-cli/` in the working directory readable only by the user
 * (0700), or tighten it if it already exists. It holds course files, grader
 * feedback, and conversations; everything inside is created by other modules
 * with default permissions, which is fine once the root is private.
 */
export function ensurePrivateLocalRoot(cwd: string = process.cwd()): void {
  const root = path.join(cwd, ".canvas-cli");
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
  } catch (error) {
    // Windows ignores POSIX modes, and a read-only folder is not fatal here.
    debug("config", `Could not restrict ${root}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
