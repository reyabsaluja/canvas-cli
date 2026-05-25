import fs from "node:fs/promises";
import { loadWorkspace } from "../../ask/load-workspace.js";
import { listWorkspaces } from "../../ask/resolve-workspace.js";
import { loadCourseCache, type CourseCache } from "../../enrich/cache-loader.js";
import { matchAssignments } from "../../domain/matching.js";
import { normalizeAssignmentDetail } from "../../domain/normalize.js";
import type { Course, AssignmentDetail } from "../../domain/models.js";
import { runWorkspaceLifecycle } from "../../workspace/lifecycle.js";
import {
  getSessionsRoot,
  getWorkspacePath,
  makeSessionSlug,
} from "../../workspace/paths.js";
import {
  loadWorkspaceSessionMeta,
  saveWorkspaceSessionMeta,
  type SessionMeta,
  updateWorkspaceSessionMeta,
} from "../../workspace/session.js";
import type { LoadedWorkspace } from "../../ask/types.js";
import type { AssignmentWorkup } from "../../work/types.js";
import type { WorkspaceLifecycleState } from "../chat-state.js";
import type {
  AppServices,
  AssignmentTarget,
  WorkspaceOpenResult,
} from "./types.js";
import { fetchAssignments } from "./course-services.js";

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

/**
 * Open an assignment workspace. Runs ingest + work if needed.
 * Calls onProgress for each stage.
 */
export async function openWorkspace(
  services: AppServices,
  course: Course,
  assignmentTarget: AssignmentTarget,
  onProgress: (stage: string, content?: string) => void
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

  // Resolve the assignment on Canvas only when no local workspace exists.
  onProgress("resolving assignment");
  const detail = await resolveAssignmentDetail(services, course, assignmentTarget);

  const slug = makeSessionSlug(course.courseCode, detail.name, detail.id);
  const workspacePath = getWorkspacePath(slug);

  if (await workspaceHasWorkup(workspacePath)) {
    return loadExistingWorkspaceResult(workspacePath, course, onProgress);
  }

  const lifecycle = await runWorkspaceLifecycle({
    aiConfig: services.aiConfig,
    detail,
    course,
    client: services.client,
    config: services.config,
    cachePolicy: "require_existing",
    onProgress,
    onStateChange: async (workspaceState, lastError) => {
      await persistWorkspaceLifecycleState(
        workspacePath,
        detail,
        course,
        workspaceState,
        lastError ?? null
      );
    },
  });

  onProgress("workspace ready");
  const loaded = await loadWorkspace(lifecycle.result.workspacePath);
  const lifecycleState = await syncLoadedWorkspaceLifecycle(
    lifecycle.result.workspacePath,
    loaded,
    course
  );

  return {
    workspacePath: lifecycle.result.workspacePath,
    workup: lifecycle.workup,
    loaded,
    lifecycleState,
  };
}

/**
 * Refresh a workspace — re-runs ingest (with --refresh) + work pipeline.
 * Returns the updated workspace data.
 */
export async function refreshWorkspace(
  services: AppServices,
  course: Course,
  assignmentTarget: AssignmentTarget,
  onProgress: (stage: string, content?: string) => void
): Promise<WorkspaceOpenResult> {
  onProgress("resolving assignment");
  const detail = await resolveAssignmentDetail(services, course, assignmentTarget);
  const slug = makeSessionSlug(course.courseCode, detail.name, detail.id);
  const workspacePath = getWorkspacePath(slug);

  const lifecycle = await runWorkspaceLifecycle({
    aiConfig: services.aiConfig,
    detail,
    course,
    client: services.client,
    config: services.config,
    cachePolicy: "refresh",
    onProgress,
    onStateChange: async (workspaceState, lastError) => {
      await persistWorkspaceLifecycleState(
        workspacePath,
        detail,
        course,
        workspaceState,
        lastError ?? null
      );
    },
  });

  onProgress("workspace refreshed");
  const loaded = await loadWorkspace(lifecycle.result.workspacePath);
  const lifecycleState = await syncLoadedWorkspaceLifecycle(
    lifecycle.result.workspacePath,
    loaded,
    course
  );

  return {
    workspacePath: lifecycle.result.workspacePath,
    workup: lifecycle.workup,
    loaded,
    lifecycleState,
  };
}

/**
 * Get recent workspaces sorted by last update.
 */
export async function getRecentWorkspaces(): Promise<
  Array<{ name: string; course: string; slug: string; path: string }>
> {
  return listWorkspaces();
}

async function loadExistingWorkspaceResult(
  workspacePath: string,
  course: Course,
  onProgress: (stage: string, content?: string) => void
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

  candidates.sort(
    (left, right) =>
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  );
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

  const allAssignments = await fetchAssignments(services, course.id, course.name);
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
    sessionSlug:
      existing?.sessionSlug ??
      makeSessionSlug(course.courseCode, detail.name, detail.id),
    workspacePath,
    assignmentId: detail.id,
    assignmentName: detail.name,
    courseId: course.id,
    courseName: course.name,
    courseCode: course.courseCode,
    preparedAt: workspaceState === "ready" ? now : existing?.preparedAt,
    lastOpenedAt: existing?.lastOpenedAt,
    workspaceState,
    lastError: workspaceState === "error" ? lastError : null,
  };
  await saveWorkspaceSessionMeta(workspacePath, session);
  return session;
}
