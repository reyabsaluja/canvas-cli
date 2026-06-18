import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AssignmentDetail, Course } from "../domain/models.js";
import type { Config } from "../config/env.js";
import { debugFs } from "../debug.js";
import { sanitizeDocumentSegment } from "../sanitize.js";
import {
  loadWorkspaceSessionMeta,
  saveWorkspaceSessionMeta,
  type SessionMeta,
} from "./session.js";
import { makeSessionSlug, getWorkspacePath } from "./paths.js";
import { generateAssignmentMarkdown } from "./assignment-markdown.js";
import {
  generateNotesMarkdown,
  generatePlanMarkdown,
  generateWorkAssignmentMarkdown,
} from "../work/generate-markdown.js";
import type {
  AssignmentWorkup,
  InvestigationState,
  WorkResult,
} from "../work/types.js";
import {
  extractLinkedFiles,
  downloadAttachments,
  type DownloadResult,
} from "./attachments.js";

interface WorkspaceWriteOptions {
  config?: Config;
  workup?: AssignmentWorkup;
  state?: InvestigationState;
}

interface UnifiedWorkspaceResult {
  slug: string;
  workspacePath: string;
  created: boolean;
  filesWritten: string[];
  filesSkipped: string[];
  attachments: DownloadResult;
  resourcesCopied: string[];
  documentsExtracted: string[];
}

export async function createWorkWorkspace(
  detail: AssignmentDetail,
  course: Course,
  workup: AssignmentWorkup,
  state: InvestigationState,
  config?: Config
): Promise<WorkResult> {
  const result = await writeWorkspaceArtifacts(detail, course, {
    config,
    workup,
    state,
  });

  return {
    workup,
    workspacePath: result.workspacePath,
    filesWritten: result.filesWritten,
    filesSkipped: result.filesSkipped,
    resourcesCopied: result.resourcesCopied,
    documentsExtracted: result.documentsExtracted,
  };
}

async function writeWorkspaceArtifacts(
  detail: AssignmentDetail,
  course: Course,
  options: WorkspaceWriteOptions
): Promise<UnifiedWorkspaceResult> {
  const slug = makeSessionSlug(course.courseCode, detail.name, detail.id);
  const wsPath = getWorkspacePath(slug);
  const existed = await dirExists(wsPath);
  debugFs(existed ? "update" : "create", wsPath, `workspace for "${detail.name}"`);

  // Ensure shared workspace structure first so every caller gets the same layout.
  await fs.mkdir(path.join(wsPath, "work"), { recursive: true });
  await fs.mkdir(path.join(wsPath, "resources"), { recursive: true });
  await fs.mkdir(path.join(wsPath, "extracted"), { recursive: true });

  const filesWritten: string[] = [];
  const filesSkipped: string[] = [];
  const now = new Date().toISOString();

  await writeAtomic(
    path.join(wsPath, "assignment.json"),
    JSON.stringify(detail, null, 2) + "\n",
  );
  filesWritten.push("assignment.json");

  const assignmentMarkdown = options.workup
    ? generateWorkAssignmentMarkdown(detail, options.workup)
    : generateAssignmentMarkdown(detail);
  await writeAtomic(
    path.join(wsPath, "assignment.md"),
    assignmentMarkdown,
  );
  filesWritten.push("assignment.md");

  if (options.workup) {
    await writeAtomic(
      path.join(wsPath, "workup.json"),
      JSON.stringify(options.workup, null, 2) + "\n",
    );
    filesWritten.push("workup.json");

    await writeAtomic(
      path.join(wsPath, "plan.md"),
      generatePlanMarkdown(detail, options.workup),
    );
    filesWritten.push("plan.md");
  }

  const session = buildSessionMeta(
    await loadWorkspaceSessionMeta(wsPath),
    {
      slug,
      workspacePath: wsPath,
      detail,
      course,
      now,
      hasWorkup: Boolean(options.workup),
    }
  );
  await saveWorkspaceSessionMeta(wsPath, session);
  filesWritten.push("session.json");

  const notesMdPath = path.join(wsPath, "notes.md");
  if (await fileExists(notesMdPath)) {
    filesSkipped.push("notes.md");
  } else {
    const notesContent = options.workup
      ? generateNotesMarkdown(detail, options.workup)
      : `# Notes: ${detail.name}\n\n`;
    await writeAtomic(
      notesMdPath,
      notesContent,
    );
    filesWritten.push("notes.md");
  }

  if (!existed) {
    filesWritten.push("work/");
    filesWritten.push("resources/");
    filesWritten.push("extracted/");
  }

  const documentsExtracted: string[] = [];
  if (options.state) {
    for (const [source, text] of options.state.extractedTexts) {
      const safeName = sanitizeDocumentSegment(source);
      const extractedPath = path.join(wsPath, "extracted", `${safeName}.txt`);
      await writeAtomic(extractedPath, text);
      documentsExtracted.push(`${safeName}.txt`);
    }
    if (documentsExtracted.length > 0) {
      filesWritten.push(`extracted/ (${documentsExtracted.length} documents)`);
    }
  }

  const resourcesCopied: string[] = [];
  if (options.workup) {
    for (const resource of options.workup.relevantResources) {
      if (resource.location && resource.type === "pdf") {
        resourcesCopied.push(resource.title);
      }
    }
  }

  const linkedFiles = detail.description && options.config
    ? extractLinkedFiles(detail.description, options.config.baseUrl)
    : [];
  let attachmentResult: DownloadResult = {
    downloaded: [],
    skipped: [],
    failed: [],
  };

  if (linkedFiles.length > 0 && options.config) {
    const attachmentsDir = path.join(wsPath, "attachments");
    attachmentResult = await downloadAttachments(
      linkedFiles,
      attachmentsDir,
      options.config
    );
    if (!existed && attachmentResult.downloaded.length > 0) {
      filesWritten.push("attachments/");
    }
  }

  return {
    slug,
    workspacePath: wsPath,
    created: !existed,
    filesWritten,
    filesSkipped,
    attachments: attachmentResult,
    resourcesCopied,
    documentsExtracted,
  };
}

function buildSessionMeta(
  existing: SessionMeta | null,
  options: {
    slug: string;
    workspacePath: string;
    detail: AssignmentDetail;
    course: Course;
    now: string;
    hasWorkup: boolean;
  }
): SessionMeta {
  return {
    version: 1,
    createdAt: existing?.createdAt ?? options.now,
    updatedAt: options.now,
    sessionSlug: options.slug,
    workspacePath: options.workspacePath,
    assignmentId: options.detail.id,
    assignmentName: options.detail.name,
    courseId: options.course.id,
    courseName: options.course.name,
    courseCode: options.course.courseCode,
    preparedAt: options.hasWorkup ? options.now : existing?.preparedAt ?? options.now,
    lastOpenedAt: existing?.lastOpenedAt,
    workspaceState: options.hasWorkup ? "ready" : existing?.workspaceState ?? "ready",
    lastError: options.hasWorkup ? null : existing?.lastError ?? null,
  };
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, content, "utf-8");
  await fs.rename(tempPath, filePath);
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
