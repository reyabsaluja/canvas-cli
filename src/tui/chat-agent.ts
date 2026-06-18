import type { WorkspaceAnswer } from "../ask/types.js";
import type { Observation, ToolExecutionResult } from "../agent/observation.js";
import { isGroundedContentObservation } from "../agent/observation-relevance.js";
import { appendObservation } from "../agent/run-state.js";
import { decideWorkspaceRetrieval } from "../agent/retrieval-gate.js";
import { verifyWorkspaceAnswer } from "../agent/verify.js";
import { streamWithTools, type ToolDefinition } from "../ai/provider.js";
import {
  buildToolPromptMessages,
  trimConversationEntries,
} from "./chat-agent/memory.js";
import {
  answerWithoutTools,
  buildEvidenceBackedQuestion,
  buildSystemPrompt,
} from "./chat-agent/prompt.js";
import {
  buildChatTools,
  getAvailableChatToolNames,
  mapToolCall,
} from "./chat-agent/tool-defs.js";
import {
  buildTurnToolCacheKey,
  executeToolCallForTurn,
  readArtifactForGate,
  seedTurnToolCacheEntry,
} from "./chat-agent/tool-execution.js";
import type {
  ChatAgentContext,
  ChatAgentConversationEntry,
  ChatAgentExtraContext,
  ToolCallEvent,
  ToolLoopRunResult,
} from "./chat-agent/types.js";
import {
  finalizeAnswerText,
  resolveToolTurnVerificationObservations,
  selectArtifactSupportObservations,
  selectComplementaryRecoveryReadArtifactId,
  selectComplementarySearchToolCalls,
  selectNoInfoRecoveryToolCalls,
  selectRecoveryReadArtifactId,
  selectThreadRecoveryTopic,
  selectUngroundedSearchRecoveryReadArtifactId,
  shouldContinueToolLoopAfterGateRead,
  shouldGroundUnverifiedAnswer,
  shouldRecoverFromNoInfoAnswer,
  shouldRecoverFromToolLoop,
  shouldRegenerateAnswerAfterRecoveryRead,
} from "./chat-agent/verification.js";

const MAX_RECOVERY_READ_ATTEMPTS = 2;

/**
 * Run the chat agent with streaming text output.
 * Tool calls fire onToolCall. The final text streams via onTextDelta.
 */
export async function runChatAgent(
  ctx: ChatAgentContext,
  question: string,
  onToolCall: (event: ToolCallEvent) => void,
  onTextDelta?: (delta: string) => void,
  abortSignal?: AbortSignal
): Promise<WorkspaceAnswer> {
  const systemPrompt = buildSystemPrompt(ctx);
  const availableTools = buildChatTools(ctx);

  const observationStart = ctx.runState.observations.length;
  const retrievalDecision = await decideWorkspaceRetrieval({
    question,
    runState: ctx.runState,
    loaded: ctx.loaded,
    cache: ctx.cache,
  });

  let fullText = "";
  let supportingObservations: Observation[] = [];
  let verificationObservations: Observation[] = [];
  let usedWorkup = false;

  if (retrievalDecision.action === "answer_from_workup") {
    usedWorkup = true;
    fullText = await answerWithoutTools(ctx, systemPrompt, question, [], onTextDelta, abortSignal);
  } else if (retrievalDecision.action === "answer_from_memory") {
    supportingObservations = selectArtifactSupportObservations(
      ctx.runState.observations,
      retrievalDecision.sourceArtifactIds
    );
    verificationObservations = supportingObservations;
    fullText = await answerWithoutTools(
      ctx,
      systemPrompt,
      question,
      supportingObservations,
      onTextDelta,
      abortSignal
    );
  } else if (retrievalDecision.action === "read_artifact") {
    const toolResult = await readArtifactForGate(retrievalDecision.artifactId, ctx);
    appendObservation(ctx.runState, toolResult.observation);
    supportingObservations = [toolResult.observation];
    verificationObservations = supportingObservations;
    const gateReadFilename =
      toolResult.observation.artifacts[0]?.title ?? retrievalDecision.artifactId;
    const { action, target } = mapToolCall("read_file", {
      filename: gateReadFilename,
    });
    onToolCall({
      action,
      target,
      result: toolResult.uiText,
      color: toolResult.observation.status === "ok" ? "green" : "red",
      observation: toolResult.observation,
    });
    if (
      shouldContinueToolLoopAfterGateRead(
        question,
        toolResult.observation,
        ctx.runState.observations
      )
    ) {
      ({
        fullText,
        supportingObservations,
        verificationObservations,
      } = await runToolLoopTurn(
        ctx,
        systemPrompt,
        availableTools,
        question,
        onToolCall,
        onTextDelta,
        observationStart,
        [
          {
            name: "read_file",
            input: { filename: gateReadFilename },
            result: toolResult,
          },
        ],
        abortSignal
      ));
    } else {
      fullText = await answerWithoutTools(
        ctx,
        systemPrompt,
        question,
        supportingObservations,
        onTextDelta,
        abortSignal
      );
    }
  } else {
    ({
      fullText,
      supportingObservations,
      verificationObservations,
    } = await runToolLoopTurn(
      ctx,
      systemPrompt,
      availableTools,
      question,
      onToolCall,
      onTextDelta,
      observationStart,
      [],
      abortSignal
    ));
  }

  const verification = verifyWorkspaceAnswer({
    question,
    answer: fullText,
    observations: verificationObservations,
    usedWorkup,
    loaded: ctx.loaded,
  });
  const finalAnswer = finalizeAnswerText(fullText, verification);

  ctx.conversationHistory.push({ role: "user", content: question });
  ctx.conversationHistory.push({ role: "assistant", content: finalAnswer });
  trimConversationHistory(ctx);

  return {
    question,
    answer: finalAnswer,
    bulletPoints: [],
    sources: verification.sources,
    confidence: verification.confidence,
    verificationNote: verification.note,
  };
}

async function runToolLoopTurn(
  ctx: ChatAgentContext,
  systemPrompt: string,
  toolDefs: ToolDefinition[],
  question: string,
  onToolCall: (event: ToolCallEvent) => void,
  onTextDelta: ((delta: string) => void) | undefined,
  observationStart: number,
  initialToolCacheEntries: Array<{
    name: string;
    input: Record<string, unknown>;
    result: Awaited<ReturnType<typeof readArtifactForGate>>;
  }> = [],
  abortSignal?: AbortSignal
): Promise<ToolLoopRunResult> {
  const pendingToolResults: ToolExecutionResult[] = [];
  const turnToolCache = new Map<string, ToolExecutionResult>();
  for (const entry of initialToolCacheEntries) {
    seedTurnToolCacheEntry(turnToolCache, entry.name, entry.input, entry.result);
  }
  const promptMessages = buildToolPromptMessages(
    ctx.conversationHistory,
    question,
    ctx.runState
  );
  let fullText = "";
  let toolLoopError: unknown = null;

  try {
    fullText = await streamWithTools(
      ctx.aiConfig,
      systemPrompt,
      promptMessages,
      toolDefs,
      async (name, input) => {
        const execution = await executeToolCallForTurn(turnToolCache, name, input, ctx);
        pendingToolResults.push(execution.result);
        if (!execution.deduped) {
          appendObservation(ctx.runState, execution.result.observation);
        }
        return execution.result.modelText;
      },
      {
        onToolCall: (name, input, toolResult) => {
          const { action, target, color } = mapToolCall(name, input);
          const detailed = pendingToolResults.shift();
          const observation = detailed?.observation;
          onToolCall({
            action,
            target,
            result: detailed?.uiText ?? toolResult,
            color: observation?.status === "ok" ? color : "red",
            observation,
          });
        },
        onTextDelta,
        abortSignal,
      },
      10
    );
  } catch (error) {
    toolLoopError = error;
  }

  let supportingObservations = ctx.runState.observations.slice(observationStart);
  let verificationObservations = resolveToolTurnVerificationObservations(
    ctx.runState.observations,
    observationStart,
    question
  );
  const observationsBeforeRecovery = supportingObservations;
  const attemptedRecoveryArtifactIds = new Set<string>();
  let recoveredComplementaryGrounding = false;
  let recoveredNoInfoGrounding = false;
  let recoveredRecoveryReadGrounding = false;
  let recoveredThreadGrounding = false;
  const executeRecoveryToolCall = async (
    name: string,
    input: Record<string, unknown>
  ): Promise<ToolExecutionResult> => {
    const execution = await executeToolCallForTurn(
      turnToolCache,
      name,
      input,
      ctx
    );
    if (!execution.deduped) {
      appendObservation(ctx.runState, execution.result.observation);
    }
    const { action, target, color } = mapToolCall(name, input);
    onToolCall({
      action,
      target,
      result: execution.result.uiText,
      color: execution.result.observation.status === "ok" ? color : "red",
      observation: execution.result.observation,
    });
    supportingObservations = ctx.runState.observations.slice(observationStart);
    verificationObservations = resolveToolTurnVerificationObservations(
      ctx.runState.observations,
      observationStart,
      question
    );
    return execution.result;
  };
  const readRecoveryArtifact = async (
    artifactId: string
  ): Promise<ToolExecutionResult> => {
    attemptedRecoveryArtifactIds.add(artifactId);
    const recoveryResult = await readArtifactForGate(artifactId, ctx);
    appendObservation(ctx.runState, recoveryResult.observation);
    const recoveryFilename =
      recoveryResult.observation.artifacts[0]?.title ?? artifactId;
    const { action, target } = mapToolCall("read_file", {
      filename: recoveryFilename,
    });
    onToolCall({
      action,
      target,
      result: recoveryResult.uiText,
      color: recoveryResult.observation.status === "ok" ? "green" : "red",
      observation: recoveryResult.observation,
    });
    supportingObservations = ctx.runState.observations.slice(observationStart);
    verificationObservations = resolveToolTurnVerificationObservations(
      ctx.runState.observations,
      observationStart,
      question
    );
    recoveredRecoveryReadGrounding =
      recoveredRecoveryReadGrounding ||
      isGroundedContentObservation(recoveryResult.observation);
    return recoveryResult;
  };

  if (shouldRecoverFromNoInfoAnswer(fullText, supportingObservations)) {
    const recoveryCalls = selectNoInfoRecoveryToolCalls(
      question,
      toolDefs.map((tool) => tool.name),
      supportingObservations
    );
    for (const recoveryCall of recoveryCalls) {
      const recoveryResult = await executeRecoveryToolCall(
        recoveryCall.name,
        recoveryCall.input
      );
      recoveredNoInfoGrounding =
        recoveredNoInfoGrounding ||
        isGroundedContentObservation(recoveryResult.observation);
      if (isUsefulNoInfoRecoveryResult(recoveryResult.observation)) {
        break;
      }
    }
  }

  const threadRecoveryTopic = selectThreadRecoveryTopic(
    question,
    supportingObservations,
    ctx.runState.observations
  );
  if (threadRecoveryTopic) {
    const execution = await executeRecoveryToolCall("read_thread", {
      topic: threadRecoveryTopic,
    });
    recoveredThreadGrounding =
      execution.observation.status === "ok" &&
      Boolean(execution.observation.content);
  }

  const shouldRecoverUngroundedSearchAnswer = shouldGroundUnverifiedAnswer(
    fullText,
    supportingObservations,
    question
  );
  const needsRecoveryRead =
    fullText.trim().length === 0 || shouldRecoverUngroundedSearchAnswer;
  const ungroundedSearchRecoveryArtifactId = shouldRecoverUngroundedSearchAnswer
    ? selectUngroundedSearchRecoveryReadArtifactId(
        question,
        supportingObservations,
        ctx.runState.observations
      )
    : null;
  if (needsRecoveryRead) {
    while (attemptedRecoveryArtifactIds.size < MAX_RECOVERY_READ_ATTEMPTS) {
      const recoveryArtifactId =
        ungroundedSearchRecoveryArtifactId &&
        !attemptedRecoveryArtifactIds.has(ungroundedSearchRecoveryArtifactId)
          ? ungroundedSearchRecoveryArtifactId
          : selectRecoveryReadArtifactId(
              question,
              supportingObservations,
              ctx.runState.observations
            );
      if (
        !recoveryArtifactId ||
        attemptedRecoveryArtifactIds.has(recoveryArtifactId)
      ) {
        break;
      }

      const recoveryResult = await readRecoveryArtifact(recoveryArtifactId);
      if (recoveryResult.observation.status === "ok" && recoveryResult.observation.content) {
        break;
      }
    }
  }

  const complementarySearchCalls = selectComplementarySearchToolCalls(
    question,
    toolDefs.map((tool) => tool.name),
    supportingObservations,
    ctx.runState.observations
  );
  for (const searchCall of complementarySearchCalls) {
    await executeRecoveryToolCall(searchCall.name, searchCall.input);
    const complementaryArtifactId = selectComplementaryRecoveryReadArtifactId(
      question,
      supportingObservations,
      ctx.runState.observations
    );
    if (complementaryArtifactId) {
      break;
    }
  }

  while (attemptedRecoveryArtifactIds.size < MAX_RECOVERY_READ_ATTEMPTS) {
    const complementaryArtifactId = selectComplementaryRecoveryReadArtifactId(
      question,
      supportingObservations,
      ctx.runState.observations
    );
    if (
      !complementaryArtifactId ||
      attemptedRecoveryArtifactIds.has(complementaryArtifactId)
    ) {
      break;
    }

    const recoveryResult = await readRecoveryArtifact(complementaryArtifactId);
    if (recoveryResult.observation.status === "ok" && recoveryResult.observation.content) {
      recoveredComplementaryGrounding = true;
    }
  }

  if (
    recoveredNoInfoGrounding ||
    recoveredRecoveryReadGrounding ||
    recoveredThreadGrounding ||
    recoveredComplementaryGrounding ||
    shouldRegenerateAnswerAfterRecoveryRead({
      answer: fullText,
      question,
      beforeRecoveryObservations: observationsBeforeRecovery,
      afterRecoveryObservations: verificationObservations,
    })
  ) {
    fullText = await answerWithoutTools(
      ctx,
      systemPrompt,
      question,
      verificationObservations,
      onTextDelta,
      abortSignal
    );
  } else if (shouldRecoverFromToolLoop(fullText, verificationObservations)) {
    fullText = await answerWithoutTools(
      ctx,
      systemPrompt,
      question,
      verificationObservations,
      onTextDelta,
      abortSignal
    );
  } else if (toolLoopError) {
    throw toolLoopError;
  }

  return {
    fullText,
    supportingObservations,
    verificationObservations,
  };
}

function trimConversationHistory(ctx: ChatAgentContext): void {
  ctx.conversationHistory = trimConversationEntries(ctx.conversationHistory);
}

function isUsefulNoInfoRecoveryResult(observation: Observation): boolean {
  if (isGroundedContentObservation(observation)) {
    return true;
  }

  if (
    observation.tool === "search_workspace" ||
    observation.tool === "search_course"
  ) {
    return observation.status === "ok" && observation.artifacts.length > 0;
  }

  if (observation.tool === "list_announcements") {
    return observation.status === "ok" && /^\s*\[[AD]\]\s+/m.test(
      observation.content ?? ""
    );
  }

  return (
    observation.status === "ok" &&
    (observation.artifacts.length > 0 ||
      Boolean(observation.content?.trim()))
  );
}

export {
  buildEvidenceBackedQuestion,
  buildToolPromptMessages,
  buildTurnToolCacheKey,
  executeToolCallForTurn,
  getAvailableChatToolNames,
  resolveToolTurnVerificationObservations,
  seedTurnToolCacheEntry,
  selectArtifactSupportObservations,
  selectComplementaryRecoveryReadArtifactId,
  selectComplementarySearchToolCalls,
  selectNoInfoRecoveryToolCalls,
  selectRecoveryReadArtifactId,
  selectThreadRecoveryTopic,
  selectUngroundedSearchRecoveryReadArtifactId,
  shouldContinueToolLoopAfterGateRead,
  shouldGroundUnverifiedAnswer,
  shouldRecoverFromNoInfoAnswer,
  shouldRegenerateAnswerAfterRecoveryRead,
  shouldRecoverFromToolLoop,
};

export type {
  ChatAgentContext,
  ChatAgentConversationEntry,
  ChatAgentExtraContext,
  ToolCallEvent,
} from "./chat-agent/types.js";
