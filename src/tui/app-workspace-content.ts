import fs from "node:fs/promises";
import path from "node:path";
import { loadCourseCache } from "../enrich/cache-loader.js";
import {
  loadWorkspace,
  readWorkspaceExtractedFile,
} from "../ask/load-workspace.js";
import type { Assignment, Course } from "../domain/models.js";
import type { LoadedWorkspace } from "../ask/types.js";
import type { AssignmentWorkup } from "../work/types.js";
import type { ChatMessage } from "./chat-state.js";
import { formatDueCompact } from "./services.js";
import type { ShellPinOption } from "./app-types.js";
import { getExtractedAttachmentPath } from "../enrich/course-documents.js";
import { extractFileText } from "../extract/extract-text.js";

export function formatWorkspaceStatusLabel(
  lifecycleState: string
): string | undefined {
  switch (lifecycleState) {
    case "stale":
      return "Status: stale · /refresh recommended";
    case "refreshing":
      return "Status: refreshing";
    case "ingesting":
      return "Status: ingesting";
    case "creating":
      return "Status: creating";
    case "error":
      return "Status: error";
    default:
      return undefined;
  }
}

export function buildGlobalIntroMessages(
  recent: Array<{ name: string; course: string }>,
  upcoming: Assignment[],
  unavailableCourses: Array<{ displayName: string; originalCode: string }>
): ChatMessage[] {
  const lines: string[] = [];
  if (unavailableCourses.length > 0) {
    lines.push("**Unavailable courses**");
    for (const course of unavailableCourses.slice(0, 4)) {
      lines.push(
        `• ${course.displayName} (${course.originalCode}) is no longer available in Canvas`
      );
    }
    lines.push("Use `/manage-courses` to remove or rename outdated entries.");
  }
  if (upcoming.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("**Upcoming assignments**");
    for (const assignment of upcoming.slice(0, 5)) {
      lines.push(`• ${assignment.name} — ${assignment.courseName}`);
    }
  }
  if (lines.length === 0) return [];
  return [{ role: "assistant", content: lines.join("\n") }];
}

export function buildCourseIntroMessages(
  course: Course,
  assignments: Assignment[],
  hasCache: boolean
): ChatMessage[] {
  const lines = [
    `You are in ${course.name}.`,
    "",
    "Ask about assignments in this course, or use `/assignments`, `/files`, and `/modules`.",
    hasCache
      ? "Course cache is available for deeper questions."
      : "Course cache is not ready yet. Open an assignment workspace for richer detail.",
  ];
  if (assignments.length > 0) {
    lines.push("", "**Upcoming work**");
    for (const assignment of assignments.slice(0, 5)) {
      lines.push(`• ${assignment.name} — ${formatDueCompact(assignment.dueAt)}`);
    }
  }
  return [{ role: "assistant", content: lines.join("\n") }];
}

export function buildWorkspaceIntroMessages(
  loaded: LoadedWorkspace,
  workup: AssignmentWorkup | null,
  lifecycleState: string
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (lifecycleState === "stale") {
    messages.push({
      role: "system",
      content:
        "This workspace is available, but the course cache is newer than the current workup. Use /refresh when you want the latest assignment context.",
    });
  }
  if (workup?.overview) {
    messages.push({
      role: "system",
      content: workup.overview,
    });
  } else {
    messages.push({
      role: "assistant",
      content: `Workspace ready for ${loaded.assignmentName}. Use /help for assignment commands.`,
    });
  }
  return messages;
}

export async function buildWorkspacePinOptions(
  loaded: Awaited<ReturnType<typeof loadWorkspace>>,
  cache: Awaited<ReturnType<typeof loadCourseCache>>
): Promise<ShellPinOption[]> {
  const options: ShellPinOption[] = [];
  const addOption = (option: ShellPinOption): void => {
    if (!options.some((existing) => existing.label === option.label)) {
      options.push(option);
    }
  };

  for (const extracted of loaded.extractedFiles) {
    addOption({
      name: extracted.name,
      label: toPinLabel(extracted.name),
    });
  }
  const [attachmentFiles, resourceFiles] = await Promise.all([
    listWorkspacePinFiles(loaded.path, "attachments"),
    listWorkspacePinFiles(loaded.path, "resources"),
  ]);
  for (const file of attachmentFiles) {
    addOption({
      name: file,
      label: toPinLabel(file),
      workspaceRelativePath: file,
    });
  }
  for (const file of resourceFiles) {
    addOption({
      name: file,
      label: toPinLabel(file),
      workspaceRelativePath: file,
    });
  }
  if (cache) {
    for (const attachment of cache.attachments) {
      if (attachment.status !== "downloaded" && attachment.status !== "skipped") {
        continue;
      }
      addOption({
        name: attachment.originalFilename,
        label: toPinLabel(attachment.localPath || attachment.originalFilename),
        localPath: attachment.localPath,
      });
    }
  }
  if (loaded.assignmentMd) addOption({ name: "assignment.md", label: "assignment" });
  if (loaded.planMd) addOption({ name: "plan.md", label: "plan" });
  if (loaded.notesMd) addOption({ name: "notes.md", label: "notes" });
  if (loaded.workupJson) addOption({ name: "workup.json", label: "workup" });
  return options;
}

export async function resolveWorkspacePinContent(
  loaded: Awaited<ReturnType<typeof loadWorkspace>>,
  cache: Awaited<ReturnType<typeof loadCourseCache>>,
  pin: ShellPinOption
): Promise<string | null> {
  for (const extracted of loaded.extractedFiles) {
    if (extracted.name === pin.name || extracted.name.includes(pin.label)) {
      const content = await readWorkspaceExtractedFile(loaded, extracted);
      return content ? content.slice(0, 15000) : null;
    }
  }
  if (pin.workspaceRelativePath) {
    const workspaceFilePath = path.join(loaded.path, pin.workspaceRelativePath);
    const content = await readWorkspacePinFile(workspaceFilePath);
    return content ? content.slice(0, 15000) : null;
  }
  if (pin.localPath && cache) {
    const extractedPath = getExtractedAttachmentPath(cache.coursePath, pin.localPath);
    const extracted = await readSafe(extractedPath);
    if (extracted) {
      return extracted.slice(0, 15000);
    }
    const fallbackPath = path.join(cache.coursePath, pin.localPath);
    const content = await readWorkspacePinFile(fallbackPath);
    return content ? content.slice(0, 15000) : null;
  }
  if (pin.name === "assignment.md" && loaded.assignmentMd) {
    return loaded.assignmentMd.slice(0, 15000);
  }
  if (pin.name === "plan.md" && loaded.planMd) {
    return loaded.planMd.slice(0, 15000);
  }
  if (pin.name === "notes.md" && loaded.notesMd) {
    return loaded.notesMd.slice(0, 15000);
  }
  if (pin.name === "workup.json" && loaded.workupJson) {
    return JSON.stringify(loaded.workupJson, null, 2).slice(0, 15000);
  }
  return null;
}

async function listWorkspacePinFiles(
  workspacePath: string,
  relativeDir: string
): Promise<string[]> {
  const root = path.join(workspacePath, relativeDir);
  try {
    const entries: string[] = [];
    await walkWorkspacePinFiles(root, relativeDir, entries);
    return entries.sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function walkWorkspacePinFiles(
  absoluteDir: string,
  relativeDir: string,
  entries: string[]
): Promise<void> {
  const children = await fs.readdir(absoluteDir, { withFileTypes: true });
  for (const child of children) {
    const childAbsolute = path.join(absoluteDir, child.name);
    const childRelative = path.join(relativeDir, child.name);
    if (child.isDirectory()) {
      await walkWorkspacePinFiles(childAbsolute, childRelative, entries);
      continue;
    }
    if (child.isFile()) {
      entries.push(childRelative);
    }
  }
}

async function readWorkspacePinFile(filePath: string): Promise<string | null> {
  const ext = path.extname(filePath).toLowerCase();
  const isPlainText = new Set([
    ".txt",
    ".md",
    ".json",
    ".csv",
    ".html",
    ".htm",
    ".py",
    ".c",
    ".h",
    ".java",
    ".js",
    ".ts",
    ".s",
    ".asm",
  ]);
  if (isPlainText.has(ext)) {
    return await readSafe(filePath);
  }

  const extracted = await extractFileText(filePath, path.basename(filePath));
  return extracted?.trim() ? extracted : null;
}

function toPinLabel(value: string): string {
  return value
    .replace(/\.txt$/i, "")
    .replace(/[./\\\s-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

async function readSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}
