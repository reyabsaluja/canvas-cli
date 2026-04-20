import type { CanvasClient } from "../canvas/client.js";
import type { Config } from "../config/env.js";
import type { AIProviderConfig } from "../ai/provider.js";
import type { AssignmentDetail, Course } from "../domain/models.js";
import { loadCourseCache, type CourseCache } from "../enrich/cache-loader.js";
import { enrichAssignmentDetail } from "../enrich/enrich-assignment.js";
import { ingestCourse } from "../ingest/ingest-course.js";
import { runInvestigation } from "../work/orchestrator.js";
import type { AssignmentWorkup, InvestigationState, WorkResult } from "../work/types.js";
import { createWorkWorkspace } from "./create.js";

export const WORKSPACE_AI_REQUIRED_ERROR_MESSAGE =
  "ANTHROPIC_API_KEY not set — cannot run assignment workup";

export type WorkspaceCachePolicy =
  | "require_existing"
  | "ensure_present"
  | "refresh";

export type WorkspaceLifecycleCheckpoint =
  | "creating"
  | "ingesting"
  | "refreshing"
  | "error";

export interface WorkspaceLifecycleProgressLabels {
  checkCache: string;
  loadCache: string;
  ingest: string;
  ingested: string;
  refreshIngest: string;
  loadFreshCache: string;
  enrich: string;
  investigate: string;
  create: string;
}

export interface WorkspaceLifecycleOptions {
  aiConfig: AIProviderConfig | null;
  detail: AssignmentDetail;
  course: Course;
  client: CanvasClient;
  config: Config;
  cachePolicy: WorkspaceCachePolicy;
  onProgress?: (phase: string, content?: string) => void;
  onStateChange?: (
    state: WorkspaceLifecycleCheckpoint,
    lastError?: string | null
  ) => Promise<void> | void;
  progressLabels?: Partial<WorkspaceLifecycleProgressLabels>;
}

export interface WorkspaceLifecycleResult {
  cache: CourseCache;
  workup: AssignmentWorkup;
  state: InvestigationState;
  result: WorkResult;
}

export class MissingCourseCacheError extends Error {
  constructor(readonly courseCode: string) {
    super(`No ingestion cache found for ${courseCode}.`);
    this.name = "MissingCourseCacheError";
  }
}

const DEFAULT_PROGRESS_LABELS: WorkspaceLifecycleProgressLabels = {
  checkCache: "checking course cache",
  loadCache: "loading course cache",
  ingest: "ingesting course data",
  ingested: "course ingested",
  refreshIngest: "re-ingesting course data",
  loadFreshCache: "loading fresh course cache",
  enrich: "enriching assignment",
  investigate: "investigating assignment",
  create: "creating workspace",
};

export async function runWorkspaceLifecycle(
  options: WorkspaceLifecycleOptions
): Promise<WorkspaceLifecycleResult> {
  const onProgress = options.onProgress ?? (() => {});
  const progressLabels = {
    ...DEFAULT_PROGRESS_LABELS,
    ...options.progressLabels,
  };

  const setState = async (
    state: WorkspaceLifecycleCheckpoint,
    lastError: string | null = null
  ): Promise<void> => {
    await options.onStateChange?.(state, lastError);
  };

  const initialState = getInitialState(options.cachePolicy);
  if (initialState) {
    await setState(initialState);
  }

  try {
    if (!options.aiConfig) {
      throw new Error(WORKSPACE_AI_REQUIRED_ERROR_MESSAGE);
    }

    const cache = await resolveWorkspaceCache(
      options,
      progressLabels,
      onProgress,
      setState
    );

    onProgress(progressLabels.enrich);
    const enriched = enrichAssignmentDetail(options.detail, cache);

    onProgress(progressLabels.investigate);
    const investigation = await runInvestigation(
      options.aiConfig,
      options.detail,
      options.course,
      enriched.enrichment,
      cache,
      options.client,
      options.config,
      (phase, content) => onProgress(phase, content)
    );

    onProgress(progressLabels.create);
    const result = await createWorkWorkspace(
      options.detail,
      options.course,
      investigation.workup,
      investigation.state,
      options.config
    );

    return {
      cache,
      workup: investigation.workup,
      state: investigation.state,
      result,
    };
  } catch (error) {
    await setState("error", getErrorMessage(error));
    throw error;
  }
}

async function resolveWorkspaceCache(
  options: WorkspaceLifecycleOptions,
  progressLabels: WorkspaceLifecycleProgressLabels,
  onProgress: (phase: string, content?: string) => void,
  setState: (
    state: WorkspaceLifecycleCheckpoint,
    lastError?: string | null
  ) => Promise<void>
): Promise<CourseCache> {
  switch (options.cachePolicy) {
    case "require_existing": {
      onProgress(progressLabels.loadCache);
      const cache = await loadCourseCache(
        options.course.courseCode,
        options.course.id
      );
      if (!cache) {
        throw new MissingCourseCacheError(options.course.courseCode);
      }
      return cache;
    }
    case "ensure_present": {
      onProgress(progressLabels.checkCache);
      let cache = await loadCourseCache(
        options.course.courseCode,
        options.course.id
      );

      if (!cache) {
        await setState("ingesting");
        onProgress(progressLabels.ingest);
        await ingestCourse(options.course, options.client, options.config, {
          refresh: false,
        });
        onProgress(progressLabels.ingested);
        cache = await loadCourseCache(options.course.courseCode, options.course.id);
        await setState("creating");
      }

      if (!cache) {
        throw new Error("Failed to load course cache after ingestion");
      }
      return cache;
    }
    case "refresh": {
      onProgress(progressLabels.refreshIngest);
      await ingestCourse(options.course, options.client, options.config, {
        refresh: true,
      });
      onProgress(progressLabels.loadFreshCache);
      const cache = await loadCourseCache(
        options.course.courseCode,
        options.course.id
      );
      if (!cache) {
        throw new Error("Failed to load course cache after re-ingestion");
      }
      return cache;
    }
  }
}

function getInitialState(
  cachePolicy: WorkspaceCachePolicy
): WorkspaceLifecycleCheckpoint | null {
  switch (cachePolicy) {
    case "ensure_present":
      return "creating";
    case "refresh":
      return "refreshing";
    default:
      return null;
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
