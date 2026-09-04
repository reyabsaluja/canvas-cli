import type { Observation, ToolExecutionResult } from "../../agent/observation.js";
import { isGroundedContentObservation } from "../../agent/observation-relevance.js";
import { appendObservation, type RunState } from "../../agent/run-state.js";
import { mapToolCall } from "./tool-defs.js";
import type { ToolCallEvent, TurnToolExecutionResult } from "./types.js";
import {
  isUsefulNoInfoRecoveryResult,
  resolveToolTurnVerificationObservations,
  selectComplementaryRecoveryReadArtifactId,
  selectComplementarySearchToolCalls,
  selectNoInfoRecoveryToolCalls,
  selectRecoveryReadArtifactId,
  selectThreadRecoveryTopic,
  selectUngroundedSearchRecoveryReadArtifactId,
  shouldGroundUnverifiedAnswer,
  shouldRecoverFromNoInfoAnswer,
  shouldRecoverFromToolLoop,
  type RecoveryToolCall,
} from "./verification.js";

/**
 * Post-answer recovery.
 *
 * The model is free to stop calling tools whenever it likes, and it sometimes
 * stops too early: it answers from a search snippet it never opened, says
 * "not found" after one read, lists announcements without opening the one
 * that matters, or grounds a comparison in one side only. This pass runs
 * after the answer is in hand and, deterministically, spends a few extra
 * tool calls closing those gaps. When the extra calls bring grounded
 * evidence the answer is regenerated on it; otherwise the first answer
 * stands.
 *
 * Recovery calls sit outside the tool loop's step budget on purpose: a
 * turn that used its budget badly still deserves a grounded answer.
 *
 * Streaming: the first answer has already been streamed to the UI, so before
 * any recovery call that may lead to a regenerated answer a separator is
 * streamed, then the regenerated answer follows it. If recovery ends without
 * a regeneration, a short closing line says the first answer stands.
 */

/** Streamed after the first answer, before recovery tool calls begin. */
export const RECOVERY_SEPARATOR =
  "\n\nChecking the source before I commit to that…\n\n";

/** Streamed when recovery ran but found nothing worth regenerating on. */
export const RECOVERY_ANSWER_STANDS_NOTE =
  "(Nothing new turned up, so the answer above stands as written.)";

/** Reads attempted per turn across all recovery branches. */
export const MAX_RECOVERY_READ_ATTEMPTS = 2;

export interface PostAnswerRecoveryOptions {
  question: string;
  /** The model's final answer for the turn; may be empty. */
  answer: string;
  /** Names of the tools available this turn; recovery only proposes these. */
  toolNames: string[];
  /** Live run state; recovery appends the observations it produces. */
  runState: RunState;
  /** Index into runState.observations where this turn began. */
  observationStart: number;
  /** Runs a named tool through the turn's normal executor (cache, dedupe). */
  executeRecoveryToolCall: (
    name: string,
    input: Record<string, unknown>
  ) => Promise<TurnToolExecutionResult>;
  /** Reads an artifact by id through the retrieval-gate read path. */
  readRecoveryArtifact: (artifactId: string) => Promise<ToolExecutionResult>;
  /** Produces a fresh answer from the given evidence (streams it itself). */
  regenerateAnswer: (observations: Observation[]) => Promise<string>;
  onToolCall: (event: ToolCallEvent) => void;
  onTextDelta?: (delta: string) => void;
  abortSignal?: AbortSignal;
  maxRecoveryReadAttempts?: number;
}

export interface PostAnswerRecoveryResult {
  /** The answer to verify and show: regenerated when evidence arrived. */
  answer: string;
  regenerated: boolean;
  /** Tool calls and reads made by recovery, in order. */
  recoveryCalls: RecoveryToolCall[];
  supportingObservations: Observation[];
  verificationObservations: Observation[];
}

export async function runPostAnswerRecovery(
  options: PostAnswerRecoveryOptions
): Promise<PostAnswerRecoveryResult> {
  const { question, answer, toolNames, runState, observationStart } = options;
  const maxReads = options.maxRecoveryReadAttempts ?? MAX_RECOVERY_READ_ATTEMPTS;
  const hasAnswer = answer.trim().length > 0;
  const all = () => runState.observations;
  const turn = () => runState.observations.slice(observationStart);

  const recoveryCalls: RecoveryToolCall[] = [];
  const attemptedReadIds = new Set<string>();
  let evidenceArrived = false;
  let separatorStreamed = false;
  const aborted = () => options.abortSignal?.aborted === true;

  const streamSeparator = (): void => {
    if (separatorStreamed || !hasAnswer || !options.onTextDelta) {
      return;
    }
    separatorStreamed = true;
    options.onTextDelta(RECOVERY_SEPARATOR);
  };

  const noteEvidence = (observation: Observation): void => {
    if (isGroundedContentObservation(observation)) {
      evidenceArrived = true;
    }
  };

  const runToolCall = async (call: RecoveryToolCall): Promise<Observation> => {
    recoveryCalls.push(call);
    const execution = await options.executeRecoveryToolCall(call.name, call.input);
    const { observation, uiText } = execution.result;
    if (!execution.deduped) {
      appendObservation(runState, observation);
      noteEvidence(observation);
    }
    const { action, target, color } = mapToolCall(call.name, call.input);
    options.onToolCall({
      action,
      target,
      result: uiText,
      color: observation.status === "ok" ? color : "red",
      observation,
    });
    return observation;
  };

  const runRead = async (artifactId: string): Promise<Observation> => {
    attemptedReadIds.add(artifactId);
    recoveryCalls.push({ name: "read_file", input: { artifactId } });
    const result = await options.readRecoveryArtifact(artifactId);
    const { observation, uiText } = result;
    appendObservation(runState, observation);
    noteEvidence(observation);
    const filename = observation.artifacts[0]?.title ?? artifactId;
    const { action, target } = mapToolCall("read_file", { filename });
    options.onToolCall({
      action,
      target,
      result: uiText,
      color: observation.status === "ok" ? "green" : "red",
      observation,
    });
    return observation;
  };

  // 1. "Not found" answers: try the tools the model never reached for.
  if (hasAnswer && !aborted() && shouldRecoverFromNoInfoAnswer(answer)) {
    const calls = selectNoInfoRecoveryToolCalls(question, toolNames, turn());
    if (calls.length > 0) {
      streamSeparator();
    }
    for (const call of calls) {
      if (aborted()) break;
      const observation = await runToolCall(call);
      if (isUsefulNoInfoRecoveryResult(observation)) {
        break;
      }
    }
  }

  // 2. Announcement listings: open the post the question is about.
  if (!aborted()) {
    const topic = selectThreadRecoveryTopic(question, turn(), all());
    if (topic) {
      streamSeparator();
      await runToolCall({ name: "read_thread", input: { topic } });
    }
  }

  // 3. Empty answers and snippet-only answers: read the search hit behind them.
  const ungrounded = hasAnswer && shouldGroundUnverifiedAnswer(answer, turn(), question);
  if (!hasAnswer || ungrounded) {
    if (ungrounded) {
      streamSeparator();
    }
    while (attemptedReadIds.size < maxReads && !aborted()) {
      const artifactId =
        (ungrounded
          ? selectUngroundedSearchRecoveryReadArtifactId(question, turn(), all())
          : null) ?? selectRecoveryReadArtifactId(question, turn(), all());
      if (!artifactId || attemptedReadIds.has(artifactId)) {
        break;
      }
      const observation = await runRead(artifactId);
      if (isGroundedContentObservation(observation)) {
        break;
      }
    }
  }

  // 4. Comparisons grounded in one source: find and read the other side.
  if (!aborted()) {
    const searches = selectComplementarySearchToolCalls(question, toolNames, turn(), all());
    if (searches.length > 0) {
      streamSeparator();
    }
    for (const call of searches) {
      if (aborted()) break;
      await runToolCall(call);
      if (selectComplementaryRecoveryReadArtifactId(question, turn(), all())) {
        break;
      }
    }
    while (attemptedReadIds.size < maxReads && !aborted()) {
      const artifactId = selectComplementaryRecoveryReadArtifactId(question, turn(), all());
      if (!artifactId || attemptedReadIds.has(artifactId)) {
        break;
      }
      streamSeparator();
      await runRead(artifactId);
    }
  }

  const supportingObservations = turn();
  const verificationObservations = resolveToolTurnVerificationObservations(
    all(),
    observationStart,
    question
  );

  const shouldRegenerate =
    !aborted() &&
    (hasAnswer
      ? evidenceArrived
      : shouldRecoverFromToolLoop(answer, verificationObservations));

  if (shouldRegenerate) {
    const regenerated = await options.regenerateAnswer(verificationObservations);
    if (regenerated.trim().length > 0) {
      return {
        answer: regenerated,
        regenerated: true,
        recoveryCalls,
        supportingObservations,
        verificationObservations,
      };
    }
  }

  if (separatorStreamed && options.onTextDelta && !aborted()) {
    options.onTextDelta(RECOVERY_ANSWER_STANDS_NOTE);
  }

  return {
    answer,
    regenerated: false,
    recoveryCalls,
    supportingObservations,
    verificationObservations,
  };
}
