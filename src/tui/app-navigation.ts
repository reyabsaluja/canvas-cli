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
import type { AppScope, ChatSessionSummary } from "./chat-state.js";
import type { Course, Assignment } from "../domain/models.js";
import chalk from "chalk";
import { clearScreen, C, getTermSize, stripAnsi, hideCursor, showCursor, createBuffer, CANVAS_TEXT } from "./screen.js";
import { loadWorkspace } from "../ask/load-workspace.js";
import { matchAssignments } from "../domain/matching.js";
import { loadCourseCache } from "../enrich/cache-loader.js";
import { isAbortError } from "../errors.js";
import { ingestCourse } from "../ingest/ingest-course.js";
import { resolveIncludeSubmissionFeedback } from "../config/submission-feedback.js";

export async function pickCourse(services: AppServices): Promise<Course | null> {
  const courses = getDisplayCourses(services);
  if (courses.length === 0) return null;

  const sessions = await listChatSessions();
  const lastOpenedMap = new Map<number, string>();
  for (const session of sessions) {
    if (session.scope.type === "course") {
      lastOpenedMap.set(session.scope.courseId, session.lastOpenedAt);
    } else if (session.scope.type === "workspace" && session.scope.courseId != null) {
      const existing = lastOpenedMap.get(session.scope.courseId);
      if (!existing || session.lastOpenedAt > existing) {
        lastOpenedMap.set(session.scope.courseId, session.lastOpenedAt);
      }
    }
  }

  const selected = await showPicker({
    title: "Courses",
    subtitle: `${courses.length} courses`,
    items: courses.map((course) => ({
      label: course.name,
      sublabel: course.courseCode,
      description: course.termName ?? course.courseCode,
      rightLabel: formatTimeAgo(lastOpenedMap.get(course.id)),
      value: String(course.id),
    })),
    filterable: true,
    backLabel: "back",
  });
  if (!selected) return null;
  return courses.find((course) => String(course.id) === selected) ?? null;
}

function formatTimeAgo(isoDate: string | undefined): string {
  if (!isoDate) return "";
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  if (isNaN(then)) return "";
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 min ago" : `${minutes} mins ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return days === 1 ? "1 day ago" : `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? "1 month ago" : `${months} months ago`;
  const years = Math.floor(months / 12);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

export async function ensureCourseIngested(
  services: AppServices,
  course: Course,
  options?: { refresh?: boolean }
): Promise<boolean> {
  const refresh = options?.refresh ?? false;

  if (services.activeIngestionAc) {
    services.activeIngestionAc.abort();
    services.activeIngestionAc = null;
  }

  if (!refresh) {
    const cache = await loadCourseCache(course.courseCode, course.id);
    if (cache) return true;
  }

  const ac = new AbortController();
  services.activeIngestionAc = ac;
  const label = refresh
    ? `Refreshing ${course.name}`
    : `Ingesting ${course.name}`;
  const progress = new IngestionProgressRenderer(label, course.courseCode, ac);
  progress.start();

  try {
    await ingestCourse(course, services.client, services.config, {
      refresh,
      includeSubmissionFeedback: resolveIncludeSubmissionFeedback(),
      signal: ac.signal,
      onProgress: (msg) => {
        progress.addStep(msg);
      },
    });
    return true;
  } catch (error) {
    if (isAbortError(error)) {
      clearScreen();
      showCursor();
      console.log(C.dim("\n  Ingestion cancelled."));
      await sleep(600);
      return false;
    }
    clearScreen();
    showCursor();
    console.log("");
    console.error(
      C.error(`  Ingestion failed: ${error instanceof Error ? error.message : "unknown"}`)
    );
    console.log(C.dim("\n  Press any key to continue..."));
    await waitForKey();
    return false;
  } finally {
    progress.stop();
    if (services.activeIngestionAc === ac) {
      services.activeIngestionAc = null;
    }
  }
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
    title: course.name,
    subtitle: `${assignments.length} assignments`,
    items: assignments.map((assignment) => ({
      label: assignment.name,
      sublabel: formatDueCompact(assignment.dueAt),
      description: assignment.submitted ? "submitted" : (assignment.dueAt ? formatDueCompact(assignment.dueAt) : "no due date"),
      rightLabel: assignment.submitted ? "✓" : "",
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
      items: buildRecentSessionPickerItems(sessions),
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
      sublabel: "Workspace",
      description: workspace.course,
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

export function buildRecentSessionPickerItems(
  sessions: ChatSessionSummary[]
): Array<{
  label: string;
  sublabel: string;
  description: string;
  rightLabel: string;
  value: string;
}> {
  return sessions.map((session) => {
    const kind = session.scope.type === "course" ? "Course" : "Workspace";
    const courseName = session.metadata.courseName ?? "";
    return {
      label: session.title,
      sublabel: kind,
      description: courseName,
      rightLabel: formatTimeAgo(session.lastOpenedAt),
      value: session.id,
    };
  });
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

  const progress = new IngestionProgressRenderer(assignmentTarget.name, course.name);
  progress.start();

  try {
    const result = await openWorkspace(
      services,
      course,
      assignmentTarget,
      (stage, content) => {
        progress.addStep(stage, content);
      }
    );
    progress.stop();
    return {
      type: "workspace",
      workspacePath: result.workspacePath,
      courseId: course.id,
      assignmentId: result.loaded.assignmentId,
    };
  } catch (error) {
    progress.stop();
    clearScreen();
    showCursor();
    console.log("");
    console.error(
      C.error(`  Failed: ${error instanceof Error ? error.message : "unknown"}`)
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

  const progress = new IngestionProgressRenderer(
    `Refreshing ${assignmentTarget.name}`,
    course.name
  );
  progress.start();

  try {
    const refreshed = await refreshWorkspace(
      services,
      course,
      assignmentTarget,
      (stage, content) => {
        progress.addStep(stage, content);
      }
    );
    progress.stop();
    return {
      type: "workspace",
      workspacePath: refreshed.workspacePath,
      courseId: course.id,
      assignmentId: refreshed.loaded.assignmentId,
    };
  } catch (error) {
    progress.stop();
    clearScreen();
    showCursor();
    console.log("");
    console.error(
      C.error(
        `  Refresh failed: ${error instanceof Error ? error.message : "unknown"}`
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

const SPINNER_FRAMES = [
  "⢀⠀", "⡀⠀", "⠄⠀", "⢂⠀", "⡂⠀", "⠅⠀", "⢃⠀", "⡃⠀", "⠍⠀", "⢋⠀",
  "⡋⠀", "⠍⠁", "⢋⠁", "⡋⠁", "⠍⠉", "⠋⠉", "⠋⠉", "⠉⠙", "⠉⠙", "⠉⠩",
  "⠈⢙", "⠈⡙", "⢈⠩", "⡀⢙", "⠄⡙", "⢂⠩", "⡂⢘", "⠅⡘", "⢃⠨", "⡃⢐",
  "⠍⡐", "⢋⠠", "⡋⢀", "⠍⡁", "⢋⠁", "⡋⠁", "⠍⠉", "⠋⠉", "⠋⠉", "⠉⠙",
  "⠉⠙", "⠉⠩", "⠈⢙", "⠈⡙", "⠈⠩", "⠀⢙", "⠀⡙", "⠀⠩", "⠀⢘", "⠀⡘",
  "⠀⠨", "⠀⢐", "⠀⡐", "⠀⠠", "⠀⢀", "⠀⡀",
];
const SHIMMER_BASE = chalk.hex("#6e1114");
const SHIMMER_HIGHLIGHT = [
  chalk.hex("#8c1618"),
  chalk.hex("#c92023"),
  chalk.hex("#f78e90"),
  chalk.hex("#c92023"),
  chalk.hex("#8c1618"),
];
const toolActionColor = chalk.hex("#e8a86d").bold;
const toolTargetGreen = chalk.hex("#6ec86a");
const spinnerColor = chalk.hex("#e82429");

interface IngestionStep {
  action: string;
  target: string;
  content?: string;
  completedAt?: number;
  stageKey: string;
  updatingInPlace?: boolean;
}

const CONTENT_PREVIEW_LINES = 8;

const INGESTION_VERBS = [
  "Working",
  "Thinking",
  "Studying",
  "Reading",
  "Analyzing",
  "Researching",
  "Exploring",
  "Reviewing",
  "Processing",
];

const TOOL_ACTION_MAP: Record<string, string> = {
  search_modules: "searching",
  get_module_items: "reading",
  read_document: "reading",
  download_module_file: "downloading",
  get_syllabus: "reading",
  list_assignments: "listing",
  list_downloaded_files: "listing",
  search_files: "searching",
  complete_investigation: "completing",
};

function friendlyAction(raw: string): string {
  return TOOL_ACTION_MAP[raw] ?? raw;
}

function parseStage(stage: string): { action: string; target: string } {
  const toolMatch = stage.match(/^(\w+)\s*\((.+)\)$/);
  if (toolMatch) {
    return { action: friendlyAction(toolMatch[1]!), target: toolMatch[2]! };
  }
  const parts = stage.split(" ");
  if (parts.length >= 2) {
    return { action: friendlyAction(parts[0]!), target: parts.slice(1).join(" ") };
  }
  return { action: friendlyAction(stage), target: "" };
}

function wrapPlain(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!word) continue;
    if (word.length > maxWidth) {
      if (current) { lines.push(current); current = ""; }
      for (let i = 0; i < word.length; i += maxWidth) lines.push(word.slice(i, i + maxWidth));
      continue;
    }
    if (current.length + word.length + 1 > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m${remaining}s`;
}

class IngestionProgressRenderer {
  private title: string;
  private subtitle: string;
  private steps: IngestionStep[] = [];
  private expandedSteps = new Set<number>();
  private frame = 0;
  private shimmerFrame = 0;
  private verbIndex = 0;
  private verbTickCounter = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startTime: number;
  private scrollOffset = 0;
  private ac: AbortController | null;

  constructor(title: string, subtitle: string, ac?: AbortController) {
    this.title = title;
    this.subtitle = subtitle;
    this.ac = ac ?? null;
    this.startTime = Date.now();
    this.verbIndex = Math.floor(Math.random() * INGESTION_VERBS.length);
  }

  start(): void {
    this.startTime = Date.now();
    hideCursor();
    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.shimmerFrame++;
      this.verbTickCounter++;
      if (this.verbTickCounter >= 25) {
        this.verbTickCounter = 0;
        this.verbIndex = (this.verbIndex + 1) % INGESTION_VERBS.length;
      }
      this.render();
    }, 120);

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", this.onKey);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    process.stdin.removeListener("data", this.onKey);
    try { process.stdin.setRawMode(false); } catch {}
    try { process.stdin.pause(); } catch {}
    showCursor();
  }

  addStep(stage: string, content?: string): void {
    const now = Date.now();
    const { action, target } = parseStage(stage);
    const stageKey = stage;

    if (content !== undefined) {
      let existing: IngestionStep | undefined;
      for (let i = this.steps.length - 1; i >= 0; i--) {
        if (this.steps[i]!.stageKey === stageKey) { existing = this.steps[i]; break; }
      }
      if (existing) {
        existing.content = content;
        existing.completedAt = now;
        this.render();
        return;
      }
    }

    if (this.steps.length > 0) {
      const last = this.steps[this.steps.length - 1]!;
      if (!last.completedAt && last.action === action) {
        last.target = target;
        last.stageKey = stageKey;
        last.updatingInPlace = true;
        this.render();
        return;
      }
      if (!last.completedAt) last.completedAt = now;
    }
    this.steps.push({ action, target, content, stageKey });
    this.render();
  }

  private onKey = (key: string): void => {
    if ((key === "\x1B" || key === "\x03") && this.ac) {
      this.ac.abort();
      return;
    }
    if (key === "\x0F") {
      let lastWithContent = -1;
      for (let i = this.steps.length - 1; i >= 0; i--) {
        if (this.steps[i]!.content) { lastWithContent = i; break; }
      }
      if (lastWithContent >= 0) {
        if (this.expandedSteps.has(lastWithContent)) {
          this.expandedSteps.delete(lastWithContent);
        } else {
          this.expandedSteps.add(lastWithContent);
        }
        this.render();
      }
    }
    if (key === "\x1B[A" || key === "\x10") {
      this.scrollOffset = Math.min(this.scrollOffset + 3, 9999);
      this.render();
    }
    if (key === "\x1B[B" || key === "\x0E") {
      this.scrollOffset = Math.max(this.scrollOffset - 3, 0);
      this.render();
    }
  };

  private render(): void {
    const buf = createBuffer();
    const { cols, rows } = getTermSize();
    const contentWidth = Math.max(24, cols - 8);
    const marker = C.success("│");
    const dimMarker = C.dim("│");
    const elapsed = formatElapsed(Date.now() - this.startTime);

    const allLines: string[] = [];

    allLines.push("");

    const dividerWidth = Math.max(24, cols - 4);
    const accentWidth = Math.min(6, dividerWidth);
    allLines.push("  " + C.primaryBold("▎") + " " + C.pureWhiteBold(this.title) + "  " + C.secondary(this.subtitle) + "  " + C.secondary(elapsed));
    allLines.push("  " + C.primary("─".repeat(accentWidth)) + C.dimmer("─".repeat(dividerWidth - accentWidth)));

    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i]!;
      const isDone = step.completedAt !== undefined;
      const bar = isDone ? dimMarker : marker;

      allLines.push("");
      if (step.updatingInPlace) {
        allLines.push(
          `  ${C.dim("└")} ${C.dim(step.action)} ${C.dim(step.target)}`
        );
      } else if (!isDone) {
        allLines.push(
          `  ${bar} ${toolActionColor(step.action)} ${toolTargetGreen(step.target)}`
        );
      } else {
        allLines.push(
          `  ${bar} ${C.dim(step.action)} ${C.dim(step.target)}`
        );
      }

      if (step.content) {
        const expanded = this.expandedSteps.has(i);
        const rawLines = step.content.split("\n").flatMap((l) => wrapPlain(l, contentWidth));
        const showLines = expanded ? rawLines : rawLines.slice(0, CONTENT_PREVIEW_LINES);
        const remaining = expanded ? 0 : Math.max(0, rawLines.length - CONTENT_PREVIEW_LINES);

        allLines.push("");
        for (const line of showLines) {
          allLines.push(`  ${isDone ? dimMarker : marker} ${isDone ? C.dim(line) : chalk.white(line)}`);
        }
        if (remaining > 0) {
          allLines.push(
            `  ${isDone ? dimMarker : marker} ${C.dim(`... (${remaining} more lines, `)}${C.dimmer("ctrl+o")}${C.dim(" to expand)")}`
          );
        }
      }
    }

    allLines.push("");

    const verb = INGESTION_VERBS[this.verbIndex % INGESTION_VERBS.length]!;
    const verbText = `${verb}...`;
    const highlightWidth = SHIMMER_HIGHLIGHT.length;
    const cycleLength = verbText.length + highlightWidth;
    const highlightPos = this.shimmerFrame % cycleLength;
    let shimmer = "";
    for (let j = 0; j < verbText.length; j++) {
      const offset = j - highlightPos + Math.floor(highlightWidth / 2);
      if (offset >= 0 && offset < highlightWidth) {
        shimmer += SHIMMER_HIGHLIGHT[offset]!(verbText[j]!);
      } else {
        shimmer += SHIMMER_BASE(verbText[j]!);
      }
    }
    allLines.push(`  ${spinnerColor(SPINNER_FRAMES[this.frame]!)} ${shimmer}`);

    const maxVisible = rows - 1;
    const totalLines = allLines.length;
    if (totalLines <= maxVisible) {
      for (const line of allLines) buf.push(line);
    } else {
      const maxScroll = Math.max(0, totalLines - maxVisible);
      this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
      const end = totalLines - this.scrollOffset;
      const start = Math.max(0, end - maxVisible);
      for (let i = start; i < end; i++) buf.push(allLines[i]!);
    }

    buf.flush();
  }
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
