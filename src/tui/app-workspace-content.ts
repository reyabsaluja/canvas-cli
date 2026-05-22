import fs from "node:fs/promises";
import path from "node:path";
import type { Assignment, Course } from "../domain/models.js";
import type { LoadedWorkspace } from "../ask/types.js";
import type { AssignmentWorkup } from "../work/types.js";
import type { ChatMessage } from "./chat-state.js";
import {
  filterActionableUpcomingAssignments,
  formatDueCompact,
} from "./services.js";
import type { ShellPinOption } from "./app-types.js";
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
  const actionableUpcoming = filterActionableUpcomingAssignments(upcoming);
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
  if (actionableUpcoming.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("**Upcoming assignments**");
    for (const assignment of actionableUpcoming.slice(0, 5)) {
      lines.push(`• ${assignment.name} — ${assignment.courseName}`);
    }
  }
  if (lines.length === 0) return [];
  return [{ role: "assistant", content: lines.join("\n") }];
}

export function buildCourseIntroMessages(
  course: Course,
  assignments: Assignment[],
  _hasCache: boolean
): ChatMessage[] {
  const actionableUpcoming = filterActionableUpcomingAssignments(assignments);
  const visibleAssignments = actionableUpcoming.length > 0
    ? actionableUpcoming
    : assignments.filter((assignment) => !assignment.submitted && assignment.dueAt === null);
  if (visibleAssignments.length === 0) {
    return [{
      role: "assistant",
      content: `Course ready for ${course.name}. Use /help for course commands.`,
    }];
  }
  const lines = ["**Upcoming work**"];
  for (const assignment of visibleAssignments.slice(0, 5)) {
    lines.push(`• ${assignment.name} — ${formatDueCompact(assignment.dueAt)}`);
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

export function buildWorkspacePinOptions(
  openResources: Array<{ title: string; kind: string; targetType: string; target: string }>
): ShellPinOption[] {
  const options: ShellPinOption[] = [];
  const seenLabels = new Set<string>();

  for (const resource of openResources) {
    if (resource.targetType !== "file") continue;
    const label = toPinLabel(resource.title);
    if (!label || seenLabels.has(label)) continue;
    seenLabels.add(label);
    options.push({
      name: resource.title,
      label,
      detail: resource.kind,
      filePath: resource.target,
    });
  }

  return options;
}

export async function resolveWorkspacePinContent(
  pin: ShellPinOption
): Promise<string | null> {
  if (pin.filePath) {
    const content = await readWorkspacePinFile(pin.filePath);
    return content ? content.slice(0, 15000) : null;
  }
  return null;
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
