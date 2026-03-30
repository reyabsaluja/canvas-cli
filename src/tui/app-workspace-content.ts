import path from "node:path";
import { loadCourseCache } from "../enrich/cache-loader.js";
import { loadWorkspace } from "../ask/load-workspace.js";
import { extractFileText } from "../extract/extract-text.js";
import type { Assignment, Course } from "../domain/models.js";
import type { LoadedWorkspace } from "../ask/types.js";
import type { AssignmentWorkup } from "../work/types.js";
import type { ChatMessage } from "./chat-state.js";
import { formatDueCompact } from "./services.js";
import type { ShellPinOption } from "./app-types.js";

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
  const lines = [
    "Academic control center ready.",
    "",
    "Use `/courses` to open a course, `/manage-courses` to edit your list, `/recent` to reopen work, or ask a broad question across your courses.",
  ];
  if (unavailableCourses.length > 0) {
    lines.push("", "**Unavailable courses**");
    for (const course of unavailableCourses.slice(0, 4)) {
      lines.push(
        `• ${course.displayName} (${course.originalCode}) is no longer available in Canvas`
      );
    }
    lines.push("Use `/manage-courses` to remove or rename outdated entries.");
  }
  if (recent.length > 0) {
    lines.push("", "**Recent workspaces**");
    for (const workspace of recent.slice(0, 4)) {
      lines.push(`• ${workspace.name} — ${workspace.course}`);
    }
  }
  if (upcoming.length > 0) {
    lines.push("", "**Upcoming assignments**");
    for (const assignment of upcoming.slice(0, 5)) {
      lines.push(`• ${assignment.name} — ${assignment.courseName}`);
    }
  }
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

export function buildWorkspacePinOptions(
  loaded: Awaited<ReturnType<typeof loadWorkspace>>,
  cache: Awaited<ReturnType<typeof loadCourseCache>>
): ShellPinOption[] {
  const options: ShellPinOption[] = [];
  for (const extracted of loaded.extractedFiles) {
    options.push({
      name: extracted.name,
      label: extracted.name
        .replace(/\.txt$/, "")
        .replace(/[._\s-]/g, "_")
        .toLowerCase(),
    });
  }
  if (cache) {
    for (const attachment of cache.attachments) {
      if (attachment.status !== "downloaded" && attachment.status !== "skipped") {
        continue;
      }
      const label = attachment.originalFilename
        .replace(/\.[^.]+$/, "")
        .replace(/[.\s-]/g, "_")
        .toLowerCase();
      if (!options.some((option) => option.label === label)) {
        options.push({
          name: attachment.originalFilename,
          label,
          localPath: attachment.localPath,
        });
      }
    }
  }
  if (loaded.assignmentMd) options.push({ name: "assignment.md", label: "assignment" });
  if (loaded.planMd) options.push({ name: "plan.md", label: "plan" });
  if (loaded.workupJson) options.push({ name: "workup.json", label: "workup" });
  return options;
}

export async function resolveWorkspacePinContent(
  loaded: Awaited<ReturnType<typeof loadWorkspace>>,
  cache: Awaited<ReturnType<typeof loadCourseCache>>,
  pin: ShellPinOption
): Promise<string | null> {
  for (const extracted of loaded.extractedFiles) {
    if (extracted.name === pin.name || extracted.name.includes(pin.label)) {
      return extracted.content.slice(0, 15000);
    }
  }
  if (pin.localPath && cache) {
    const fullPath = path.join(cache.coursePath, pin.localPath);
    const extracted = await extractFileText(fullPath, pin.name);
    return extracted.slice(0, 15000);
  }
  if (pin.name === "assignment.md" && loaded.assignmentMd) {
    return loaded.assignmentMd.slice(0, 15000);
  }
  if (pin.name === "plan.md" && loaded.planMd) {
    return loaded.planMd.slice(0, 15000);
  }
  if (pin.name === "workup.json" && loaded.workupJson) {
    return JSON.stringify(loaded.workupJson, null, 2).slice(0, 15000);
  }
  return null;
}
