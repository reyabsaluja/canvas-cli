import type { WorkspaceAnswer, LoadedWorkspace } from "../../ask/types.js";
import type { AIProviderConfig } from "../../ai/provider.js";
import type { Observation } from "../../agent/observation.js";
import { createEmptyRunState, hydrateRunState } from "../../agent/run-state.js";
import type {
  ChatAgentContext,
  ChatAgentExtraContext,
  ToolCallEvent,
} from "../chat-agent/types.js";

/**
 * Create a persistent chat agent context for a workspace session.
 * The context maintains conversation history across multiple questions.
 */
export function createChatContext(
  aiConfig: AIProviderConfig,
  loaded: LoadedWorkspace,
  extraContext?: ChatAgentExtraContext
): ChatAgentContext {
  return {
    aiConfig,
    loaded,
    cache: extraContext?.cache ?? null,
    client: extraContext?.client ?? null,
    config: extraContext?.config ?? null,
    courseId: extraContext?.courseId ?? null,
    courseName: extraContext?.courseName ?? loaded.courseName ?? null,
    assignments: extraContext?.assignments ?? [],
    radar: extraContext?.radar ?? null,
    conversationHistory: [],
    runState: createEmptyRunState(),
  };
}

export function hydrateConversationHistory(
  chatContext: ChatAgentContext,
  messages: Array<{ role: string; content: string; observation?: Observation }>
): void {
  chatContext.conversationHistory = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
  chatContext.runState = hydrateRunState(messages);
}

/**
 * Ask a question using the tool-calling chat agent.
 * Pass a persistent chatContext to maintain conversation history.
 */
export async function askWorkspaceQuestion(
  aiConfig: AIProviderConfig,
  loaded: LoadedWorkspace,
  question: string,
  onToolCall?: (event: {
    action: string;
    target: string;
    result: string;
    color: "green" | "red";
  }) => void,
  extraContext?: ChatAgentExtraContext,
  chatContext?: ChatAgentContext,
  onTextDelta?: (delta: string) => void,
  abortSignal?: AbortSignal
): Promise<WorkspaceAnswer> {
  const { runChatAgent } = await import("../chat-agent.js");

  const context = chatContext ?? createChatContext(aiConfig, loaded, extraContext);

  return runChatAgent(context, question, onToolCall ?? (() => {}), onTextDelta, abortSignal);
}

export type { ToolCallEvent };
