export type ScopeType = "global" | "course" | "workspace";

export interface GlobalScope {
  type: "global";
}

export interface CourseScope {
  type: "course";
  courseId: number;
}

export interface WorkspaceScope {
  type: "workspace";
  workspacePath: string;
  courseId: number | null;
  assignmentId: number | null;
}

export type AppScope = GlobalScope | CourseScope | WorkspaceScope;

export type WorkspaceLifecycleState =
  | "missing"
  | "creating"
  | "ingesting"
  | "ready"
  | "stale"
  | "refreshing"
  | "error";

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  sources?: Array<{ title: string; kind: string }>;
  confidence?: string;
  bulletPoints?: string[];
  toolAction?: string;
  toolTarget?: string;
  toolColor?: "green" | "red";
}

export interface ChatSessionMetadata {
  courseId?: number | null;
  courseName?: string;
  courseCode?: string;
  assignmentId?: number | null;
  assignmentName?: string;
  workspacePath?: string;
  sessionSlug?: string;
  lastOpenedAt?: string;
}

export interface ChatSession {
  version: 1;
  id: string;
  title: string;
  scope: AppScope;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  messages: ChatMessage[];
  metadata: ChatSessionMetadata;
}

export interface CommandDefinition {
  name: string;
  description: string;
  scopes: ScopeType[];
  aliases?: string[];
}

export interface ScopeRuntime {
  scope: AppScope;
  title: string;
  subtitle?: string;
  scopeLabel: string;
  placeholder?: string;
}
