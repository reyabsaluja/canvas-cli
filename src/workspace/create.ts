import fs from "node:fs/promises";
import path from "node:path";
import type { AssignmentDetail, Course } from "../domain/models.js";
import type { Config } from "../config/env.js";
import type { SessionMeta } from "./session.js";
import { makeSessionSlug, getWorkspacePath } from "./paths.js";
import { generateAssignmentMarkdown } from "./assignment-markdown.js";
import {
  extractLinkedFiles,
  downloadAttachments,
  type DownloadResult,
} from "./attachments.js";

export interface WorkspaceResult {
  slug: string;
  workspacePath: string;
  created: boolean;
  filesWritten: string[];
  filesSkipped: string[];
  attachments: DownloadResult;
}

/**
 * Create or update a local workspace for an assignment.
 *
 * On first run: creates the full workspace structure and downloads attachments.
 * On repeated runs: refreshes assignment data, downloads new attachments,
 * but never touches user files (notes.md, work/).
 */
export async function createWorkspace(
  detail: AssignmentDetail,
  course: Course,
  config: Config
): Promise<WorkspaceResult> {
  const slug = makeSessionSlug(course.courseCode, detail.name, detail.id);
  const wsPath = getWorkspacePath(slug);

  const existed = await dirExists(wsPath);

  // Ensure directory structure
  await fs.mkdir(path.join(wsPath, "work"), { recursive: true });

  const filesWritten: string[] = [];
  const filesSkipped: string[] = [];
  const now = new Date().toISOString();

  // assignment.json — always refresh with latest data
  await fs.writeFile(
    path.join(wsPath, "assignment.json"),
    JSON.stringify(detail, null, 2) + "\n",
    "utf-8"
  );
  filesWritten.push("assignment.json");

  // assignment.md — always refresh with latest data
  await fs.writeFile(
    path.join(wsPath, "assignment.md"),
    generateAssignmentMarkdown(detail),
    "utf-8"
  );
  filesWritten.push("assignment.md");

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

  await fs.writeFile(
    sessionJsonPath,
    JSON.stringify(session, null, 2) + "\n",
    "utf-8"
  );
  filesWritten.push("session.json");

  // notes.md — only create if it doesn't exist
  const notesMdPath = path.join(wsPath, "notes.md");
  if (await fileExists(notesMdPath)) {
    filesSkipped.push("notes.md");
  } else {
    await fs.writeFile(
      notesMdPath,
      `# Notes: ${detail.name}\n\n`,
      "utf-8"
    );
    filesWritten.push("notes.md");
  }

  // work/ directory already ensured above
  if (!existed) {
    filesWritten.push("work/");
  }

  // Download attachments from description links
  const linkedFiles = detail.description
    ? extractLinkedFiles(detail.description)
    : [];

  let attachmentResult: DownloadResult = {
    downloaded: [],
    skipped: [],
    failed: [],
  };

  if (linkedFiles.length > 0) {
    const attachmentsDir = path.join(wsPath, "attachments");
    attachmentResult = await downloadAttachments(
      linkedFiles,
      attachmentsDir,
      config
    );
  }

  return {
    slug,
    workspacePath: wsPath,
    created: !existed,
    filesWritten,
    filesSkipped,
    attachments: attachmentResult,
  };
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}
