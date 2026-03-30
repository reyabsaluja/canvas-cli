import fs from "node:fs/promises";
import path from "node:path";
import { showPicker } from "./picker.js";
import {
  type AssignmentTarget,
  fetchAssignments,
  getCourseById,
  getDisplayCourses,
  getRecentWorkspaces,
  openWorkspace,
  refreshWorkspace,
  formatDueCompact,
  type AppServices,
} from "./services.js";
import { listChatSessions } from "./chat-sessions.js";
import type { AppScope } from "./chat-state.js";
import type { Course, Assignment } from "../domain/models.js";
import { clearScreen, C } from "./screen.js";
import { loadWorkspace } from "../ask/load-workspace.js";
import { matchAssignments } from "../domain/matching.js";

export async function pickCourse(services: AppServices): Promise<Course | null> {
  const courses = getDisplayCourses(services);
  if (courses.length === 0) return null;
  const selected = await showPicker({
    title: "Courses",
    subtitle: `${courses.length} courses`,
    items: courses.map((course) => ({
      label: course.name,
      sublabel: course.courseCode,
      value: String(course.id),
    })),
    filterable: true,
    backLabel: "back",
  });
  if (!selected) return null;
  return courses.find((course) => String(course.id) === selected) ?? null;
}

export async function pickAssignmentScope(
  services: AppServices,
  courseId: number
): Promise<AppScope | null> {
  const course = getCourseById(services, courseId);
  if (!course) return null;

  clearScreen();
  console.log("");
  console.log(C.dim(`  loading assignments for ${course.courseCode}...`));

  let assignments: Assignment[];
  try {
    assignments = await fetchAssignments(services, course.id, course.name);
  } catch (error) {
    console.error(
      C.error(`  Error: ${error instanceof Error ? error.message : "unknown"}`)
    );
    await sleep(1200);
    return null;
  }

  if (assignments.length === 0) {
    console.log(C.dim("  No assignments found for this course."));
    await sleep(1200);
    return null;
  }

  const selected = await showPicker({
    title: course.courseCode || course.name,
    subtitle: `${assignments.length} assignments`,
    items: assignments.map((assignment) => ({
      label: assignment.name,
      sublabel:
        formatDueCompact(assignment.dueAt) +
        (assignment.submitted ? " · submitted" : ""),
      value: String(assignment.id),
      dimmed: assignment.submitted,
    })),
    filterable: true,
    backLabel: "back",
  });

  if (!selected) return null;
  const selectedAssignment =
    assignments.find((assignment) => String(assignment.id) === selected) ?? null;
  if (!selectedAssignment) return null;

  return openAssignmentScope(services, course.id, {
    id: selectedAssignment.id,
    name: selectedAssignment.name,
  });
}

export async function pickRecentScope(
  services: AppServices
): Promise<AppScope | null> {
  const allSessions = (await listChatSessions()).filter(
    (session) => session.scope.type !== "global"
  );
  const sessions: typeof allSessions = [];
  for (const session of allSessions) {
    if (
      session.scope.type === "workspace" &&
      !(await workspaceExists(session.scope.workspacePath))
    ) {
      continue;
    }
    sessions.push(session);
  }

  if (sessions.length > 0) {
    const selected = await showPicker({
      title: "Recent sessions",
      subtitle: `${sessions.length} recent items`,
      items: sessions.slice(0, 20).map((session) => ({
        label: session.title,
        sublabel:
          session.scope.type === "course"
            ? `Course · ${session.metadata.courseName ?? ""}`
            : `Workspace · ${session.metadata.courseName ?? ""}`,
        value: session.id,
      })),
      filterable: true,
      backLabel: "back",
    });
    if (!selected) return null;
    const session = sessions.find((entry) => entry.id === selected) ?? null;
    return session?.scope ?? null;
  }

  const allRecent = await getRecentWorkspaces();
  const recent: typeof allRecent = [];
  for (const workspace of allRecent) {
    if (await workspaceExists(workspace.path)) {
      recent.push(workspace);
    }
  }
  if (recent.length === 0) return null;
  const selected = await showPicker({
    title: "Recent workspaces",
    subtitle: `${recent.length} workspaces`,
    items: recent.map((workspace) => ({
      label: workspace.name,
      sublabel: workspace.course,
      value: workspace.path,
    })),
    filterable: true,
    backLabel: "back",
  });
  if (!selected || !(await workspaceExists(selected))) {
    return null;
  }
  try {
    const loaded = await loadWorkspace(selected);
    return {
      type: "workspace",
      workspacePath: selected,
      courseId: loaded.courseId,
      assignmentId: loaded.assignmentId,
    };
  } catch {
    return null;
  }
}

export async function resolveGlobalOpen(
  query: string,
  services: AppServices
): Promise<{ scope: AppScope | null; error?: string }> {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return { scope: null };

  const course = getDisplayCourses(services).find(
    (entry) =>
      entry.name.toLowerCase().includes(trimmed) ||
      entry.courseCode.toLowerCase().includes(trimmed)
  );
  if (course) {
    return { scope: { type: "course", courseId: course.id } };
  }

  const recent = await getRecentWorkspaces();
  const workspace = recent.find(
    (entry) =>
      entry.name.toLowerCase().includes(trimmed) ||
      entry.course.toLowerCase().includes(trimmed)
  );
  if (!workspace) return { scope: null };
  if (!(await workspaceExists(workspace.path))) {
    return {
      scope: null,
      error:
        "That workspace is no longer available on disk. Use /recent or /courses to open something else.",
    };
  }
  try {
    const loaded = await loadWorkspace(workspace.path);
    return {
      scope: {
        type: "workspace",
        workspacePath: workspace.path,
        courseId: loaded.courseId,
        assignmentId: loaded.assignmentId,
      },
    };
  } catch {
    return {
      scope: null,
      error:
        "That workspace could not be reopened. Use /recent or /courses to pick another one.",
    };
  }
}

export function normalizeScopeAfterCourseManagement(
  scope: AppScope,
  services: AppServices
): AppScope {
  if (scope.type === "course") {
    return getCourseById(services, scope.courseId)
      ? scope
      : { type: "global" };
  }
  return scope;
}

export async function openAssignmentScope(
  services: AppServices,
  courseId: number,
  assignmentTarget: AssignmentTarget
): Promise<AppScope | null> {
  const course = getCourseById(services, courseId);
  if (!course) return null;

  clearScreen();
  console.log("");
  console.log(C.primaryBold(`  ${assignmentTarget.name}`));
  console.log(C.dim(`  ${course.name}`));
  console.log("");

  try {
    const result = await openWorkspace(
      services,
      course,
      assignmentTarget,
      (stage) => {
        console.log(`  ${C.dim("›")} ${C.dim(stage)}`);
      }
    );
    return {
      type: "workspace",
      workspacePath: result.workspacePath,
      courseId: course.id,
      assignmentId: result.loaded.assignmentId,
    };
  } catch (error) {
    console.error(
      C.error(`\n  Failed: ${error instanceof Error ? error.message : "unknown"}`)
    );
    console.log(C.dim("\n  Press any key to continue..."));
    await waitForKey();
    return null;
  }
}

export async function refreshWorkspaceScope(
  services: AppServices,
  courseId: number,
  assignmentTarget: AssignmentTarget,
  fallbackScope: AppScope
): Promise<AppScope> {
  const course = getCourseById(services, courseId);
  if (!course) return fallbackScope;

  clearScreen();
  console.log("");
  console.log(C.primaryBold(`  Refreshing ${assignmentTarget.name}`));
  console.log(C.dim(`  ${course.name}`));
  console.log("");

  try {
    const refreshed = await refreshWorkspace(
      services,
      course,
      assignmentTarget,
      (stage) => {
        console.log(`  ${C.dim("›")} ${C.dim(stage)}`);
      }
    );
    return {
      type: "workspace",
      workspacePath: refreshed.workspacePath,
      courseId: course.id,
      assignmentId: refreshed.loaded.assignmentId,
    };
  } catch (error) {
    console.error(
      C.error(
        `\n  Refresh failed: ${error instanceof Error ? error.message : "unknown"}`
      )
    );
    console.log(C.dim("\n  Press any key to continue..."));
    await waitForKey();
    return fallbackScope;
  }
}

export async function workspaceExists(workspacePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(workspacePath, "session.json"));
    return stat.isFile();
  } catch {
    return false;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function waitForKey(): Promise<void> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.once("data", () => {
      stdin.setRawMode(false);
      stdin.pause();
      resolve();
    });
  });
}

export async function resolveCourseAssignmentOpen(
  services: AppServices,
  courseId: number,
  query: string
): Promise<
  | { type: "assignment-picker"; courseId: number }
  | { type: "open-assignment"; courseId: number; assignmentTarget: AssignmentTarget }
  | { type: "message"; content: string }
  | null
> {
  const course = getCourseById(services, courseId);
  if (!course) return null;

  if (!query.trim()) {
    return { type: "assignment-picker", courseId: course.id };
  }

  const assignments = await fetchAssignments(services, course.id, course.name);
  const matches = matchAssignments(query.trim(), assignments);
  if (matches.length === 1) {
    return {
      type: "open-assignment",
      courseId: course.id,
      assignmentTarget: {
        id: matches[0]!.id,
        name: matches[0]!.name,
      },
    };
  }
  if (matches.length > 1) {
    return {
      type: "message",
      content: [
        `Multiple assignments in ${course.name} matched "${query.trim()}".`,
        "Be more specific or use /assignments:",
        ...matches.slice(0, 5).map((assignment) => `• ${assignment.name}`),
      ].join("\n"),
    };
  }
  return {
    type: "message",
    content: `No assignment in ${course.name} matched "${query.trim()}".`,
  };
}
