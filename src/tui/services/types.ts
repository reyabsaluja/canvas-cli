import type { CanvasClient } from "../../canvas/client.js";
import type { CanvasCourse } from "../../canvas/types.js";
import type { Config } from "../../config/env.js";
import type { Course, Assignment } from "../../domain/models.js";
import type { AIProviderConfig } from "../../ai/provider.js";
import type { LoadedWorkspace } from "../../ask/types.js";
import type { CourseConfig, UserCourse } from "../course-config.js";
import type { AssignmentWorkup } from "../../work/types.js";
import type { WorkspaceLifecycleState } from "../chat-state.js";
import type { RadarService } from "./radar-service.js";

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
  assignmentCache: Map<
    number,
    { courseName: string; assignmentsPromise: Promise<Assignment[]> }
  >;
  radar: RadarService;
  syncedAt: number;
  unreadAnnouncementCount: number;
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

export interface DisplayCourseAvailability {
  available: Course[];
  unavailable: UserCourse[];
}
