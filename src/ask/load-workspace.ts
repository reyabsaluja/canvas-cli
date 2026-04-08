import fs from "node:fs/promises";
import path from "node:path";
import type { ExtractedWorkspaceFile, LoadedWorkspace } from "./types.js";

/**
 * Load workspace metadata and small artifacts needed for shell entry.
 * Extracted document text is indexed by filename only and loaded lazily on demand.
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

  const extractedFiles = await listWorkspaceExtractedFiles(wsPath);

  return {
    path: wsPath,
    sessionSlug: (session.sessionSlug as string) ?? path.basename(wsPath),
    assignmentId:
      typeof session.assignmentId === "number" ? session.assignmentId : null,
    assignmentName: (session.assignmentName as string) ?? "Unknown",
    courseId: typeof session.courseId === "number" ? session.courseId : null,
    courseName: (session.courseName as string) ?? "Unknown",
    courseCode: (session.courseCode as string) ?? null,
    preparedAt: (session.preparedAt as string) ?? null,
    workspaceState: (session.workspaceState as string) ?? null,
    assignmentMd,
    planMd,
    notesMd,
    workupJson,
    extractedFiles,
    extractedFileCache: new Map<string, string>(),
  };
}

export async function readWorkspaceExtractedFile(
  ws: LoadedWorkspace,
  file: string | ExtractedWorkspaceFile
): Promise<string | null> {
  const entry =
    typeof file === "string"
      ? ws.extractedFiles.find((candidate) => candidate.name === file) ?? null
      : file;
  if (!entry) return null;

  ws.extractedFileCache ??= new Map<string, string>();
  const cached = ws.extractedFileCache.get(entry.name);
  if (cached !== undefined) {
    return cached;
  }

  const content = await readSafe(path.join(ws.path, entry.relativePath));
  if (!content || content.trim().length === 0) {
    return null;
  }
  ws.extractedFileCache.set(entry.name, content);
  return content;
}

export async function loadWorkspaceExtractedFiles(
  ws: LoadedWorkspace
): Promise<Array<{ name: string; content: string }>> {
  const files: Array<{ name: string; content: string }> = [];
  for (const entry of ws.extractedFiles) {
    const content = await readWorkspaceExtractedFile(ws, entry);
    if (content) {
      files.push({ name: entry.name, content });
    }
  }
  return files;
}

async function listWorkspaceExtractedFiles(
  wsPath: string
): Promise<ExtractedWorkspaceFile[]> {
  const extractedDir = path.join(wsPath, "extracted");
  try {
    return await walkExtractedFiles(extractedDir, "extracted");
  } catch {
    return [];
  }
}

async function walkExtractedFiles(
  absoluteDir: string,
  relativeDir: string
): Promise<ExtractedWorkspaceFile[]> {
  const files: ExtractedWorkspaceFile[] = [];
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  for (const entry of entries) {
    const nextAbsolute = path.join(absoluteDir, entry.name);
    const nextRelative = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkExtractedFiles(nextAbsolute, nextRelative)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".txt")) {
      continue;
    }
    files.push({
      name: path.relative("extracted", nextRelative),
      relativePath: nextRelative,
    });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

async function readSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}
