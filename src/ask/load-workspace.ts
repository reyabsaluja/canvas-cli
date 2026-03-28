import fs from "node:fs/promises";
import path from "node:path";
import type { LoadedWorkspace } from "./types.js";

/**
 * Load all workspace artifacts needed for question answering.
 */
export async function loadWorkspace(wsPath: string): Promise<LoadedWorkspace> {
  const [sessionRaw, assignmentMd, planMd, notesMd, workupRaw] =
    await Promise.all([
      readSafe(path.join(wsPath, "session.json")),
      readSafe(path.join(wsPath, "assignment.md")),
      readSafe(path.join(wsPath, "plan.md")),
      readSafe(path.join(wsPath, "notes.md")),
      readSafe(path.join(wsPath, "workup.json")),
    ]);

  let session: Record<string, unknown> = {};
  try {
    session = JSON.parse(sessionRaw ?? "{}");
  } catch {
    // malformed
  }

  let workupJson: Record<string, unknown> | null = null;
  try {
    if (workupRaw) workupJson = JSON.parse(workupRaw);
  } catch {
    // malformed
  }

  // Load extracted text files (including subdirectories like pages/)
  const extractedFiles: Array<{ name: string; content: string }> = [];
  const extractedDir = path.join(wsPath, "extracted");
  try {
    const entries = await fs.readdir(extractedDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".txt")) {
        const content = await readSafe(path.join(extractedDir, entry.name));
        if (content && content.trim().length > 0) {
          extractedFiles.push({ name: entry.name, content });
        }
      } else if (entry.isDirectory()) {
        // Read .txt files from subdirectories (e.g., pages/)
        try {
          const subEntries = await fs.readdir(path.join(extractedDir, entry.name));
          for (const sub of subEntries) {
            if (!sub.endsWith(".txt")) continue;
            const content = await readSafe(path.join(extractedDir, entry.name, sub));
            if (content && content.trim().length > 0) {
              extractedFiles.push({ name: `${entry.name}/${sub}`, content });
            }
          }
        } catch {
          // skip unreadable subdirectory
        }
      }
    }
  } catch {
    // no extracted dir
  }

  return {
    path: wsPath,
    sessionSlug: (session.sessionSlug as string) ?? path.basename(wsPath),
    assignmentName: (session.assignmentName as string) ?? "Unknown",
    courseName: (session.courseName as string) ?? "Unknown",
    assignmentMd,
    planMd,
    notesMd,
    workupJson,
    extractedFiles,
  };
}

async function readSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}
