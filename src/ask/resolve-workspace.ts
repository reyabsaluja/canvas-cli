import fs from "node:fs/promises";
import path from "node:path";
import { getSessionsRoot } from "../workspace/paths.js";

/**
 * Resolve the active workspace path.
 *
 * Strategy:
 * 1. If --workspace is provided, use it directly
 * 2. If cwd is inside a workspace (has session.json), use cwd
 * 3. Walk up from cwd looking for .canvas-cli/sessions/ with workspaces
 * 4. If sessions dir exists with exactly one workspace, use it
 * 5. If multiple workspaces, pick the most recently updated one
 * 6. Return null if no workspace found
 */
export async function resolveWorkspace(
  explicitPath?: string
): Promise<string | null> {
  // 1. Explicit path
  if (explicitPath) {
    if (await hasSessionJson(explicitPath)) return explicitPath;
    return null;
  }

  // 2. Check if cwd is inside a workspace
  if (await hasSessionJson(process.cwd())) {
    return process.cwd();
  }

  // 3. Look for sessions directory
  const sessionsRoot = getSessionsRoot();
  if (!(await dirExists(sessionsRoot))) return null;

  // 4/5. Find workspaces and pick the most recent
  const entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
  const workspaces: Array<{ path: string; updatedAt: number }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const wsPath = path.join(sessionsRoot, entry.name);
    const sessionPath = path.join(wsPath, "session.json");

    try {
      const content = await fs.readFile(sessionPath, "utf-8");
      const session = JSON.parse(content);
      const updatedAt = session.updatedAt
        ? new Date(session.updatedAt).getTime()
        : 0;
      workspaces.push({ path: wsPath, updatedAt });
    } catch {
      // Not a valid workspace, skip
    }
  }

  if (workspaces.length === 0) return null;

  // Sort by most recently updated
  workspaces.sort((a, b) => b.updatedAt - a.updatedAt);
  return workspaces[0].path;
}

/**
 * List all available workspaces with their names.
 * Used for disambiguation messages.
 */
export async function listWorkspaces(): Promise<
  Array<{ path: string; name: string; course: string; slug: string }>
> {
  const sessionsRoot = getSessionsRoot();
  if (!(await dirExists(sessionsRoot))) return [];

  const entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
  const results: Array<{
    path: string;
    name: string;
    course: string;
    slug: string;
  }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const wsPath = path.join(sessionsRoot, entry.name);
    try {
      const content = await fs.readFile(
        path.join(wsPath, "session.json"),
        "utf-8"
      );
      const session = JSON.parse(content);
      results.push({
        path: wsPath,
        name: session.assignmentName ?? entry.name,
        course: session.courseName ?? "",
        slug: entry.name,
      });
    } catch {
      // skip
    }
  }

  return results;
}

async function hasSessionJson(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(dir, "session.json"));
    return stat.isFile();
  } catch {
    return false;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
