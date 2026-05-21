import type { LoadedWorkspace } from "../../ask/types.js";
import type { CourseCache } from "../../enrich/cache-loader.js";
import type { CanvasClient } from "../../canvas/client.js";
import type { Config } from "../../config/env.js";
import type { AIProviderConfig } from "../../ai/provider.js";
import type { Observation, ToolExecutionResult } from "../../agent/observation.js";
import type { RunState } from "../../agent/run-state.js";
import type { Assignment } from "../../domain/models.js";
import type { RadarService } from "../services/radar-service.js";

export interface ChatAgentContext {
  aiConfig: AIProviderConfig;
  loaded: LoadedWorkspace;
  cache: CourseCache | null;
  client: CanvasClient | null;
  config: Config | null;
  courseId: number | null;
  /** Course name, when the workspace is scoped to a course. */
  courseName?: string | null;
  /** Assignments list for the current course, when preloaded by the shell. */
  assignments?: Assignment[];
  /** Radar service for announcements/discussions, when available. */
  radar?: RadarService | null;
  /** Persistent conversation history for multi-turn context. */
  conversationHistory: ChatAgentConversationEntry[];
  /** Minimal serialized working memory for grounding and retrieval gating. */
  runState: RunState;
  /** Latest /pdf export from this chat session. */
  lastExportedPdfPath?: string | null;
}

export interface ChatAgentConversationEntry {
  role: string;
  content: string;
}

export interface ChatAgentExtraContext {
  cache: CourseCache | null;
  client: CanvasClient | null;
  config: Config | null;
  courseId: number | null;
  courseName?: string | null;
  assignments?: Assignment[];
  radar?: RadarService | null;
  lastExportedPdfPath?: string | null;
}

export interface ToolCallEvent {
  action: string;
  target: string;
  result: string;
  color: "green" | "red";
  observation?: Observation;
}

export type ConversationEntry = ChatAgentContext["conversationHistory"][number];
export type ConversationTurn = [ConversationEntry, ConversationEntry];
export type TurnToolCache = Map<string, ToolExecutionResult>;

export interface TurnToolExecutionResult {
  result: ToolExecutionResult;
  deduped: boolean;
}

export interface ToolLoopRunResult {
  fullText: string;
  supportingObservations: Observation[];
  verificationObservations: Observation[];
}
