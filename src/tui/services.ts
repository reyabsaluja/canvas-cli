export type {
  AppServices,
  AssignmentTarget,
  DisplayCourseAvailability,
  WorkspaceOpenResult,
} from "./services/types.js";

export {
  fetchAssignments,
  fetchUpcomingAssignments,
  formatDueCompact,
  getCourseById,
  getCourseDisplayName,
  getDisplayCourseAvailability,
  getDisplayCourses,
  getUnavailableConfiguredCourses,
  initServices,
  invalidateAssignmentCache,
} from "./services/course-services.js";

export {
  getRecentWorkspaces,
  getWorkspaceLifecycleState,
  openWorkspace,
  refreshWorkspace,
} from "./services/workspace-lifecycle.js";

export {
  askWorkspaceQuestion,
  createChatContext,
  hydrateConversationHistory,
} from "./services/workspace-chat.js";

export type { ToolCallEvent } from "./services/workspace-chat.js";
