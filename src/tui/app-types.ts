import type { LoadedWorkspace } from "../ask/types.js";
import type { CourseCache } from "../enrich/cache-loader.js";
import type { AssignmentTarget } from "./services.js";
import type {
  AppScope,
  ChatMessage,
  ChatSession,
  ScopeRuntime,
} from "./chat-state.js";

export type ShellResult =
  | { type: "quit" }
  | { type: "scope"; scope: AppScope }
  | { type: "course-management" }
  | { type: "course-picker" }
  | { type: "recent-picker" }
  | { type: "assignment-picker"; courseId: number }
  | {
      type: "open-assignment";
      courseId: number;
      assignmentTarget: AssignmentTarget;
    }
  | {
      type: "workspace-refresh";
      courseId: number;
      assignmentTarget: AssignmentTarget;
    };

export interface ShellPinOption {
  name: string;
  label: string;
  detail?: string;
  filePath?: string;
  localPath?: string;
  workspaceRelativePath?: string;
}

export interface ShellOpenOption {
  title: string;
  query: string;
  detail?: string;
  searchTerms?: string[];
}

export interface ShellContext {
  session: ChatSession;
  runtime: ScopeRuntime;
  bannerRenderer?: (buf: { push(line?: string): void }) => void;
  extraHelpCommands?: Array<{ cmd: string; desc: string }>;
  getPinOptions?: () => ShellPinOption[];
  getOpenOptions?: () => ShellOpenOption[];
  onClear?: () => Promise<ChatMessage[]>;
  resolvePinContent?: (pin: ShellPinOption) => Promise<string | null>;
  getLoadedWorkspace?: () => LoadedWorkspace | null;
  getCourseCache?: () => CourseCache | null;
  onReady?: (api: ShellRuntimeApi) => Promise<void> | void;
  onAsk: (
    input: string,
    callbacks: {
      onToolCall?: (event: {
        action: string;
        target: string;
        result: string;
        color: "green" | "red";
      }) => void | Promise<void>;
      onTextDelta?: (delta: string) => void;
      abortSignal?: AbortSignal;
    }
  ) => Promise<{
    content: string;
    bulletPoints?: string[];
    sources?: Array<{ title: string; kind: string; section?: string | null }>;
    confidence?: string;
    verificationNote?: string | null;
  }>;
}

export interface ShellRuntimeApi {
  addMessage: (message: ChatMessage) => Promise<void>;
  addMessages: (messages: ChatMessage[]) => Promise<void>;
  render: () => void;
  session: ChatSession;
  runtime: ScopeRuntime;
}

export interface CommandApi {
  addMessage: (message: ChatMessage) => Promise<void>;
  session: ChatSession;
  runtime: ScopeRuntime;
  getLoadedWorkspace?: () => LoadedWorkspace | null;
  getCourseCache?: () => CourseCache | null;
}
