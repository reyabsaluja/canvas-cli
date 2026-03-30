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
import {
  makeSessionSlug,
  getSessionsRoot,
  getWorkspacePath,
} from "../workspace/paths.js";
import { listWorkspaces } from "../ask/resolve-workspace.js";
import {
  loadWorkspaceSessionMeta,
  saveWorkspaceSessionMeta,
  type SessionMeta,
  updateWorkspaceSessionMeta,
} from "../workspace/session.js";
import type { Course, Assignment, AssignmentDetail } from "../domain/models.js";
import type { CanvasCourse } from "../canvas/types.js";
import type { CourseConfig } from "./course-config.js";
import type { AssignmentWorkup } from "../work/types.js";
import type { WorkspaceAnswer } from "../ask/types.js";
import type { LoadedWorkspace } from "../ask/types.js";
import type { WorkspaceLifecycleState } from "./chat-state.js";
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

export interface WorkspaceOpenResult {
  workspacePath: string;
  workup: AssignmentWorkup | null;
  loaded: LoadedWorkspace;
  lifecycleState: WorkspaceLifecycleState;
}

export interface AssignmentTarget {
  id: number | null;
  name: string;
}

export function getWorkspaceLifecycleState(
  preparedAt: string | null,
  storedState: string | null,
  cache: CourseCache | null
): WorkspaceLifecycleState {
  switch (storedState) {
    case "creating":
    case "ingesting":
    case "refreshing":
    case "error":
      return storedState;
    case "missing":
      return "missing";
    default:
      return isWorkspaceStale(preparedAt, cache) ? "stale" : "ready";
  }
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

  // Map user config to Course objects with custom display names.
  // courseCode keeps the ORIGINAL code (for slugs/cache), name shows the display name.
  return services.courseConfig.courses.map((uc) => {
    const original = services.allCourses.find((c) => c.id === uc.id);
    return {
      id: uc.id,
      name: uc.displayName, // display name shown in UI
      courseCode: uc.originalCode, // original code used for slugs/cache
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
  assignmentTarget: AssignmentTarget,
  onProgress: (stage: string) => void
): Promise<WorkspaceOpenResult> {
  onProgress("checking existing workspaces");
  const existingWorkspacePath = await findExistingWorkspacePath(
    course,
    assignmentTarget
  );
  if (existingWorkspacePath) {
    return loadExistingWorkspaceResult(
      existingWorkspacePath,
      course,
      onProgress
    );
  }

  // Step 1: Resolve the assignment on Canvas only when no local workspace exists.
  onProgress("resolving assignment");
  const detail = await resolveAssignmentDetail(
    services,
    course,
    assignmentTarget
  );

  const slug = makeSessionSlug(course.courseCode, detail.name, detail.id);
  const wsPath = getWorkspacePath(slug);

  if (await workspaceHasWorkup(wsPath)) {
    return loadExistingWorkspaceResult(wsPath, course, onProgress);
  }

  await persistWorkspaceLifecycleState(wsPath, detail, course, "creating");

  try {
    // Step 3: Check ingestion cache
    onProgress("checking course cache");
    let cache = await loadCourseCache(course.courseCode, course.id);

    if (!cache) {
      // Need to ingest first
      await persistWorkspaceLifecycleState(wsPath, detail, course, "ingesting");
      onProgress("ingesting course data");
      await ingestCourse(course, services.client, services.config, {
        refresh: false,
      });
      onProgress("course ingested");
      cache = await loadCourseCache(course.courseCode, course.id);
      await persistWorkspaceLifecycleState(wsPath, detail, course, "creating");
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
    const lifecycleState = await syncLoadedWorkspaceLifecycle(
      result.workspacePath,
      loaded,
      course
    );

    return {
      workspacePath: result.workspacePath,
      workup: investigation.workup,
      loaded,
      lifecycleState,
    };
  } catch (error) {
    await persistWorkspaceLifecycleState(
      wsPath,
      detail,
      course,
      "error",
      error instanceof Error ? error.message : "unknown error"
    );
    throw error;
  }
}

async function loadExistingWorkspaceResult(
  workspacePath: string,
  course: Course,
  onProgress: (stage: string) => void
): Promise<WorkspaceOpenResult> {
  onProgress("loading workspace");
  const loaded = await loadWorkspace(workspacePath);
  const lifecycleState = await syncLoadedWorkspaceLifecycle(
    workspacePath,
    loaded,
    course
  );
  return {
    workspacePath,
    workup: loaded.workupJson as unknown as AssignmentWorkup | null,
    loaded,
    lifecycleState,
  };
}

async function findExistingWorkspacePath(
  course: Course,
  assignmentTarget: AssignmentTarget
): Promise<string | null> {
  const sessionsRoot = getSessionsRoot();
  let entries;
  try {
    entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  const normalizedAssignmentName = normalizeWorkspaceLookupValue(
    assignmentTarget.name
  );
  const candidates: SessionMeta[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspacePath = getWorkspacePath(entry.name);
    const meta = await loadWorkspaceSessionMeta(workspacePath);
    if (!meta) continue;
    if (meta.courseId !== course.id) continue;
    if (assignmentTarget.id !== null && meta.assignmentId !== assignmentTarget.id) {
      continue;
    }
    if (
      assignmentTarget.id === null &&
      normalizeWorkspaceLookupValue(meta.assignmentName) !== normalizedAssignmentName
    ) {
      continue;
    }
    if (!(await workspaceHasWorkup(workspacePath))) continue;
    candidates.push(meta);
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    return (
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  });
  return candidates[0]!.workspacePath;
}

function normalizeWorkspaceLookupValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

async function resolveAssignmentDetail(
  services: AppServices,
  course: Course,
  assignmentTarget: AssignmentTarget
): Promise<AssignmentDetail> {
  if (assignmentTarget.id !== null) {
    const rawDetail = await services.client.getAssignmentDetail(
      course.id,
      assignmentTarget.id
    );
    return normalizeAssignmentDetail(rawDetail, course.name);
  }

  const rawAssignments = await services.client.getAssignments(course.id);
  const allAssignments = rawAssignments.map((a) =>
    normalizeAssignment(a, course.name)
  );
  const matches = matchAssignments(assignmentTarget.name, allAssignments);

  if (matches.length === 0) {
    throw new Error(`No assignment matching "${assignmentTarget.name}" found.`);
  }

  const rawDetail = await services.client.getAssignmentDetail(
    course.id,
    matches[0]!.id
  );
  return normalizeAssignmentDetail(rawDetail, course.name);
}

async function workspaceHasWorkup(workspacePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(`${workspacePath}/workup.json`);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Refresh a workspace — re-runs ingest (with --refresh) + work pipeline.
 * Returns the updated workspace data.
 */
export async function refreshWorkspace(
  services: AppServices,
  course: Course,
  assignmentTarget: AssignmentTarget,
  onProgress: (stage: string) => void
): Promise<WorkspaceOpenResult> {
  // Step 1: Resolve assignment
  onProgress("resolving assignment");
  const detail = await resolveAssignmentDetail(
    services,
    course,
    assignmentTarget
  );
  const slug = makeSessionSlug(course.courseCode, detail.name, detail.id);
  const wsPath = getWorkspacePath(slug);

  await persistWorkspaceLifecycleState(wsPath, detail, course, "refreshing");

  try {
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
    const lifecycleState = await syncLoadedWorkspaceLifecycle(
      result.workspacePath,
      loaded,
      course
    );

    return {
      workspacePath: result.workspacePath,
      workup: investigation.workup,
      loaded,
      lifecycleState,
    };
  } catch (error) {
    await persistWorkspaceLifecycleState(
      wsPath,
      detail,
      course,
      "error",
      error instanceof Error ? error.message : "unknown error"
    );
    throw error;
  }
}

// ToolCallEvent is defined in chat-agent.ts
export type { ToolCallEvent } from "./chat-agent.js";

/**
 * Create a persistent chat agent context for a workspace session.
 * The context maintains conversation history across multiple questions.
 */
export function createChatContext(
  aiConfig: AIProviderConfig,
  loaded: LoadedWorkspace,
  extraContext?: {
    cache: CourseCache | null;
    client: CanvasClient | null;
    config: Config | null;
    courseId: number | null;
  }
): any {
  return {
    aiConfig,
    loaded,
    cache: extraContext?.cache ?? null,
    client: extraContext?.client ?? null,
    config: extraContext?.config ?? null,
    courseId: extraContext?.courseId ?? null,
    conversationHistory: [],
  };
}

export function hydrateConversationHistory(
  chatContext: { conversationHistory: Array<{ role: string; content: string }> },
  messages: Array<{ role: string; content: string }>
): void {
  chatContext.conversationHistory = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
}

/**
 * Ask a question using the tool-calling chat agent.
 * Pass a persistent chatContext to maintain conversation history.
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
  },
  chatContext?: any,
  onTextDelta?: (delta: string) => void
): Promise<WorkspaceAnswer> {
  const { runChatAgent } = await import("./chat-agent.js");

  const ctx = chatContext ?? {
    aiConfig,
    loaded,
    cache: extraContext?.cache ?? null,
    client: extraContext?.client ?? null,
    config: extraContext?.config ?? null,
    courseId: extraContext?.courseId ?? null,
    conversationHistory: [],
  };

  return runChatAgent(ctx, question, onToolCall ?? (() => {}), onTextDelta);
}

/**
 * Get recent workspaces sorted by last update.
 */
export async function getRecentWorkspaces(): Promise<
  Array<{ name: string; course: string; slug: string; path: string }>
> {
  return listWorkspaces();
}

export function getCourseById(
  services: AppServices,
  courseId: number
): Course | null {
  return getDisplayCourses(services).find((course) => course.id === courseId) ?? null;
}

export function getCourseDisplayName(
  services: AppServices,
  courseId: number
): string | null {
  const configured = services.courseConfig?.courses.find((course) => course.id === courseId);
  if (configured) return configured.displayName;
  return services.allCourses.find((course) => course.id === courseId)?.name ?? null;
}

export async function fetchUpcomingAssignments(
  services: AppServices,
  limit: number = 12
): Promise<Assignment[]> {
  const courses = getDisplayCourses(services);
  const allAssignments = await Promise.all(
    courses.map(async (course) => {
      try {
        return await fetchAssignments(services, course.id, course.name);
      } catch {
        return [];
      }
    })
  );

  return sortByUrgency(
    allAssignments
      .flat()
      .filter((assignment) => !assignment.submitted)
  ).slice(0, limit);
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

function isWorkspaceStale(
  preparedAt: string | null,
  cache: CourseCache | null
): boolean {
  if (!preparedAt || !cache?.ingestion?.ingestedAt) return false;
  return new Date(cache.ingestion.ingestedAt).getTime() > new Date(preparedAt).getTime();
}

async function syncLoadedWorkspaceLifecycle(
  workspacePath: string,
  loaded: LoadedWorkspace,
  course: Course
): Promise<WorkspaceLifecycleState> {
  const cache = await loadCourseCache(course.courseCode, course.id);
  const lifecycleState = getWorkspaceLifecycleState(
    loaded.preparedAt,
    loaded.workspaceState,
    cache
  );
  await updateWorkspaceSessionMeta(workspacePath, (current) => ({
    ...current,
    updatedAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
    workspaceState: lifecycleState,
    lastError: lifecycleState === "error" ? current.lastError ?? null : null,
  }));
  return lifecycleState;
}

async function persistWorkspaceLifecycleState(
  workspacePath: string,
  detail: AssignmentDetail,
  course: Course,
  workspaceState: WorkspaceLifecycleState,
  lastError: string | null = null
): Promise<SessionMeta> {
  const existing = await loadWorkspaceSessionMeta(workspacePath);
  const now = new Date().toISOString();
  const session: SessionMeta = {
    version: 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    sessionSlug: existing?.sessionSlug ?? makeSessionSlug(course.courseCode, detail.name, detail.id),
    workspacePath,
    assignmentId: detail.id,
    assignmentName: detail.name,
    courseId: course.id,
    courseName: course.name,
    courseCode: course.courseCode,
    preparedAt:
      workspaceState === "ready"
        ? now
        : existing?.preparedAt,
    lastOpenedAt: existing?.lastOpenedAt,
    workspaceState,
    lastError: workspaceState === "error" ? lastError : null,
  };
  await saveWorkspaceSessionMeta(workspacePath, session);
  return session;
}
