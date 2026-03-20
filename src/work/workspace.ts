import fs from "node:fs/promises";
import path from "node:path";
import type { AssignmentDetail, Course } from "../domain/models.js";
import type { AssignmentWorkup, InvestigationState, WorkResult } from "./types.js";
import type { SessionMeta } from "../workspace/session.js";
import { makeSessionSlug, getWorkspacePath } from "../workspace/paths.js";
import {
  generateWorkAssignmentMarkdown,
  generatePlanMarkdown,
  generateNotesMarkdown,
} from "./generate-markdown.js";

/**
 * Create or refresh the work workspace with all agent artifacts.
 * Preserves user files (notes.md, work/) on re-run.
 */
export async function createWorkWorkspace(
  detail: AssignmentDetail,
  course: Course,
  workup: AssignmentWorkup,
  state: InvestigationState
): Promise<WorkResult> {
  const slug = makeSessionSlug(course.courseCode, detail.name, detail.id);
  const wsPath = getWorkspacePath(slug);

  // Ensure directory structure
  await fs.mkdir(path.join(wsPath, "work"), { recursive: true });
  await fs.mkdir(path.join(wsPath, "resources"), { recursive: true });
  await fs.mkdir(path.join(wsPath, "extracted"), { recursive: true });

  const filesWritten: string[] = [];
  const filesSkipped: string[] = [];
  const now = new Date().toISOString();

  // session.json — create or update
  const sessionJsonPath = path.join(wsPath, "session.json");
  let session: SessionMeta;

  if (await fileExists(sessionJsonPath)) {
    const existing = JSON.parse(
      await fs.readFile(sessionJsonPath, "utf-8")
    ) as SessionMeta;
    session = {
      ...existing,
      updatedAt: now,
      assignmentName: detail.name,
      courseName: course.name,
      courseCode: course.courseCode,
      workspacePath: wsPath,
      sessionSlug: slug,
    };
  } else {
    session = {
      version: 1,
      createdAt: now,
      updatedAt: now,
      sessionSlug: slug,
      workspacePath: wsPath,
      assignmentId: detail.id,
      assignmentName: detail.name,
      courseId: course.id,
      courseName: course.name,
      courseCode: course.courseCode,
    };
  }
  await writeAtomic(sessionJsonPath, JSON.stringify(session, null, 2) + "\n");
  filesWritten.push("session.json");

  // assignment.json — always refresh
  await writeAtomic(
    path.join(wsPath, "assignment.json"),
    JSON.stringify(detail, null, 2) + "\n"
  );
  filesWritten.push("assignment.json");

  // workup.json — always refresh
  await writeAtomic(
    path.join(wsPath, "workup.json"),
    JSON.stringify(workup, null, 2) + "\n"
  );
  filesWritten.push("workup.json");

  // assignment.md — always refresh (rich combined brief)
  await writeAtomic(
    path.join(wsPath, "assignment.md"),
    generateWorkAssignmentMarkdown(detail, workup)
  );
  filesWritten.push("assignment.md");

  // plan.md — always refresh
  await writeAtomic(
    path.join(wsPath, "plan.md"),
    generatePlanMarkdown(detail, workup)
  );
  filesWritten.push("plan.md");

  // notes.md — only create if doesn't exist (preserve user edits)
  const notesMdPath = path.join(wsPath, "notes.md");
  if (await fileExists(notesMdPath)) {
    filesSkipped.push("notes.md");
  } else {
    await writeAtomic(notesMdPath, generateNotesMarkdown(detail, workup));
    filesWritten.push("notes.md");
  }

  // Write extracted documents
  const documentsExtracted: string[] = [];
  for (const [source, text] of state.extractedTexts) {
    const safeName = source
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/__+/g, "_");
    const extPath = path.join(wsPath, "extracted", `${safeName}.txt`);
    await writeAtomic(extPath, text);
    documentsExtracted.push(safeName + ".txt");
  }
  if (documentsExtracted.length > 0) {
    filesWritten.push(`extracted/ (${documentsExtracted.length} documents)`);
  }

  // Copy relevant resources (symlink or note their paths)
  const resourcesCopied: string[] = [];
  for (const res of workup.relevantResources) {
    if (res.location && res.type === "pdf") {
      resourcesCopied.push(res.title);
    }
  }

  return {
    workup,
    workspacePath: wsPath,
    filesWritten,
    filesSkipped,
    resourcesCopied,
    documentsExtracted,
  };
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = filePath + ".tmp";
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, filePath);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}
