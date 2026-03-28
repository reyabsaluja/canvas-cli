import { CanvasClient } from "../canvas/client.js";
import { loadConfig, type Config } from "../config/env.js";
import { normalizeCourse, normalizeAssignment } from "../domain/normalize.js";
import { filterRelevantAssignments } from "../domain/assignment-relevance.js";
import { sortByUrgency } from "../domain/sorting.js";
import { loadCourseCache, type CourseCache } from "../enrich/cache-loader.js";
import { enrichAssignmentDetail } from "../enrich/enrich-assignment.js";
import {
  normalizeAssignmentDetail,
} from "../domain/normalize.js";
import { matchAssignments } from "../domain/matching.js";
import { ingestCourse } from "../ingest/ingest-course.js";
import { runInvestigation } from "../work/orchestrator.js";
import { createWorkWorkspace } from "../work/workspace.js";
import { loadWorkspace } from "../ask/load-workspace.js";
// buildChunks, retrieveRelevant, answerQuestion now used by chat-agent.ts
import { getAIConfig, type AIProviderConfig } from "../ai/provider.js";
import { makeSessionSlug, getWorkspacePath } from "../workspace/paths.js";
import { listWorkspaces } from "../ask/resolve-workspace.js";
import type { Course, Assignment, AssignmentDetail } from "../domain/models.js";
import type { CanvasCourse } from "../canvas/types.js";
import type { UserCourse, CourseConfig } from "./course-config.js";
import type { AssignmentWorkup } from "../work/types.js";
import type { WorkspaceAnswer } from "../ask/types.js";
import type { LoadedWorkspace } from "../ask/types.js";
import fs from "node:fs/promises";

/**
 * Shared service state — initialized once, reused across TUI screens.
 */
export interface AppServices {
  config: Config;
  client: CanvasClient;
  aiConfig: AIProviderConfig | null;
  rawCourses: CanvasCourse[];
  /** All current courses from Canvas (unfiltered). */
  allCourses: Course[];
  /** User-configured courses (filtered + renamed). Null if no config yet. */
  courseConfig: CourseConfig | null;
}

export async function initServices(): Promise<AppServices> {
  const config = loadConfig();
  const client = new CanvasClient(config);
  const aiConfig = getAIConfig();
  const rawCourses = await client.getCourses();
  const allCourses = rawCourses
    .map(normalizeCourse)
    .filter((c) => c.isCurrent);

  return { config, client, aiConfig, rawCourses, allCourses, courseConfig: null };
}

/**
 * Get the display courses — user-configured with custom names.
 * Returns empty array if no courses configured (user must add via Manage courses).
 * Only falls back to allCourses if courseConfig is null (pre-setup state).
 */
export function getDisplayCourses(services: AppServices): Course[] {
  if (!services.courseConfig) {
    // Pre-setup state — show all courses as fallback
    return services.allCourses;
  }

  // Map user config to Course objects with custom display names
  return services.courseConfig.courses.map((uc) => {
    const original = services.allCourses.find((c) => c.id === uc.id);
    return {
      id: uc.id,
      name: uc.originalName,
      courseCode: uc.displayName,
      termName: original?.termName ?? null,
      isCurrent: true,
    };
  });
}

/**
 * Fetch assignments for a course, filtered and sorted.
 */
export async function fetchAssignments(
  services: AppServices,
  courseId: number,
  courseName: string
): Promise<Assignment[]> {
  const raw = await services.client.getAssignments(courseId);
  const normalized = raw.map((a) => normalizeAssignment(a, courseName));
  const filtered = filterRelevantAssignments(normalized, {
    all: true, // show all in TUI picker
  });
  return sortByUrgency(filtered);
}

/**
 * Open an assignment workspace. Runs ingest + work if needed.
 * Calls onProgress for each stage.
 */
export async function openWorkspace(
  services: AppServices,
  course: Course,
  assignmentName: string,
  onProgress: (stage: string) => void
): Promise<{
  workspacePath: string;
  workup: AssignmentWorkup | null;
  loaded: LoadedWorkspace;
}> {
  // Step 1: Resolve the assignment (TUI-safe, no process.exit)
  onProgress("resolving assignment");

  const rawAssignments = await services.client.getAssignments(course.id);
  const allAssignments = rawAssignments.map((a) =>
    normalizeAssignment(a, course.name)
  );
  const matches = matchAssignments(assignmentName, allAssignments);

  if (matches.length === 0) {
    throw new Error(`No assignment matching "${assignmentName}" found.`);
  }

  const match = matches[0];
  const rawDetail = await services.client.getAssignmentDetail(
    course.id,
    match.id
  );
  const detail = normalizeAssignmentDetail(rawDetail, course.name);

  const slug = makeSessionSlug(course.courseCode, detail.name, detail.id);
  const wsPath = getWorkspacePath(slug);

  // Step 2: Check if workspace already exists
  const workupPath = `${wsPath}/workup.json`;
  let workupExists = false;
  try {
    await fs.stat(workupPath);
    workupExists = true;
  } catch {}

  if (workupExists) {
    onProgress("loading workspace");
    const loaded = await loadWorkspace(wsPath);
    return {
      workspacePath: wsPath,
      workup: loaded.workupJson as unknown as AssignmentWorkup | null,
      loaded,
    };
  }

  // Step 3: Check ingestion cache
  onProgress("checking course cache");
  let cache = await loadCourseCache(course.courseCode, course.id);

  if (!cache) {
    // Need to ingest first
    onProgress("ingesting course data");
    await ingestCourse(course, services.client, services.config, {
      refresh: false,
    });
    onProgress("course ingested");
    cache = await loadCourseCache(course.courseCode, course.id);
  }

  if (!cache) {
    throw new Error("Failed to load course cache after ingestion");
  }

  // Step 4: Run work pipeline
  if (!services.aiConfig) {
    throw new Error(
      "ANTHROPIC_API_KEY not set — cannot run assignment workup"
    );
  }

  onProgress("enriching assignment");
  const enriched = enrichAssignmentDetail(detail, cache);

  onProgress("investigating assignment");
  const investigation = await runInvestigation(
    services.aiConfig,
    detail,
    course,
    enriched.enrichment,
    cache,
    services.client,
    services.config,
    (phase) => onProgress(phase)
  );

  onProgress("creating workspace");
  const result = await createWorkWorkspace(
    detail,
    course,
    investigation.workup,
    investigation.state
  );

  onProgress("workspace ready");
  const loaded = await loadWorkspace(result.workspacePath);

  return {
    workspacePath: result.workspacePath,
    workup: investigation.workup,
    loaded,
  };
}

/**
 * Refresh a workspace — re-runs ingest (with --refresh) + work pipeline.
 * Returns the updated workspace data.
 */
export async function refreshWorkspace(
  services: AppServices,
  course: Course,
  assignmentName: string,
  onProgress: (stage: string) => void
): Promise<{
  workspacePath: string;
  workup: AssignmentWorkup | null;
  loaded: LoadedWorkspace;
}> {
  // Step 1: Resolve assignment
  onProgress("resolving assignment");
  const rawAssignments = await services.client.getAssignments(course.id);
  const allAssignments = rawAssignments.map((a) =>
    normalizeAssignment(a, course.name)
  );
  const matches = matchAssignments(assignmentName, allAssignments);
  if (matches.length === 0) {
    throw new Error(`No assignment matching "${assignmentName}" found.`);
  }
  const match = matches[0];
  const rawDetail = await services.client.getAssignmentDetail(course.id, match.id);
  const detail = normalizeAssignmentDetail(rawDetail, course.name);

  // Step 2: Force re-ingest
  onProgress("re-ingesting course data");
  await ingestCourse(course, services.client, services.config, { refresh: true });

  // Step 3: Load fresh cache
  onProgress("loading fresh course cache");
  const cache = await loadCourseCache(course.courseCode, course.id);
  if (!cache) throw new Error("Failed to load course cache after re-ingestion");

  // Step 4: Re-run work pipeline
  if (!services.aiConfig) {
    throw new Error("ANTHROPIC_API_KEY not set — cannot run assignment workup");
  }

  onProgress("enriching assignment");
  const enriched = enrichAssignmentDetail(detail, cache);

  onProgress("investigating assignment");
  const investigation = await runInvestigation(
    services.aiConfig,
    detail,
    course,
    enriched.enrichment,
    cache,
    services.client,
    services.config,
    (phase) => onProgress(phase)
  );

  onProgress("creating workspace");
  const result = await createWorkWorkspace(detail, course, investigation.workup, investigation.state);

  onProgress("workspace refreshed");
  const loaded = await loadWorkspace(result.workspacePath);

  return {
    workspacePath: result.workspacePath,
    workup: investigation.workup,
    loaded,
  };
}

// ToolCallEvent is defined in chat-agent.ts
export type { ToolCallEvent } from "./chat-agent.js";

/**
 * Ask a question using the tool-calling chat agent.
 * onToolCall fires after each tool execution with the action, target, result, and color.
 */
export async function askWorkspaceQuestion(
  aiConfig: AIProviderConfig,
  loaded: LoadedWorkspace,
  question: string,
  onToolCall?: (event: { action: string; target: string; result: string; color: "green" | "red" }) => void,
  extraContext?: {
    cache: CourseCache | null;
    client: CanvasClient | null;
    config: Config | null;
    courseId: number | null;
  }
): Promise<WorkspaceAnswer> {
  const { runChatAgent } = await import("./chat-agent.js");

  return runChatAgent(
    {
      aiConfig,
      loaded,
      cache: extraContext?.cache ?? null,
      client: extraContext?.client ?? null,
      config: extraContext?.config ?? null,
      courseId: extraContext?.courseId ?? null,
    },
    question,
    onToolCall ?? (() => {})
  );
}

/**
 * Get recent workspaces sorted by last update.
 */
export async function getRecentWorkspaces(): Promise<
  Array<{ name: string; course: string; slug: string; path: string }>
> {
  return listWorkspaces();
}

/**
 * Format a due date for compact display.
 */
export function formatDueCompact(dueAt: Date | null): string {
  if (!dueAt) return "no due date";
  const now = new Date();
  const diffMs = dueAt.getTime() - now.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 0) return `overdue by ${Math.abs(diffDays)}d`;
  if (diffDays === 0) return "due today";
  if (diffDays === 1) return "due tomorrow";
  if (diffDays <= 7) return `due in ${diffDays}d`;
  return `due ${dueAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}
