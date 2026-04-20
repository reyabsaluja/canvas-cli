import type { Observation } from "../../agent/observation.js";
import type { RunState } from "../../agent/run-state.js";
import { cleanInlineText } from "./shared.js";
import type {
  ChatAgentConversationEntry,
  ConversationEntry,
  ConversationTurn,
} from "./types.js";
import {
  collectFailedReadArtifactIds,
  collectObservationArtifactIds,
  pruneSearchBreadcrumbArtifacts,
  selectRelevantObservations,
  selectRelevantSearchBreadcrumbObservations,
  selectSupplementalEvidenceObservations,
} from "./verification.js";

const MAX_CONVERSATION_MESSAGES = 12;
const MAX_CONVERSATION_CHARS = 80000;
const MAX_TOOL_MEMORY_CHARS = 2400;
const MAX_TOOL_MEMORY_DETAIL_CHARS = 220;
const MAX_NEXT_STEP_SOURCES = 3;

export function buildToolPromptMessages(
  history: ChatAgentConversationEntry[],
  question: string,
  runState?: RunState
): ChatAgentConversationEntry[] {
  return trimConversationEntries([
    ...history,
    {
      role: "user",
      content: buildToolPromptQuestion(question, runState),
    },
  ]);
}

export function trimConversationEntries(
  history: ConversationEntry[]
): ConversationEntry[] {
  const { turns, pendingUser } = normalizeConversationHistory(history);

  while (conversationMessageCount(turns, pendingUser) > MAX_CONVERSATION_MESSAGES) {
    turns.shift();
  }

  let totalChars = conversationCharCount(turns, pendingUser);
  while (totalChars > MAX_CONVERSATION_CHARS && turns.length > 0) {
    const removedTurn = turns.shift();
    if (!removedTurn) {
      break;
    }
    totalChars -= removedTurn[0].content.length + removedTurn[1].content.length;
  }

  return flattenConversationHistory(turns, pendingUser);
}

function normalizeConversationHistory(
  history: ConversationEntry[]
): { turns: ConversationTurn[]; pendingUser?: ConversationEntry } {
  const turns: ConversationTurn[] = [];
  let pendingUser: ConversationEntry | undefined;

  for (const entry of history) {
    if (entry.role === "user") {
      pendingUser = entry;
      continue;
    }

    if (entry.role === "assistant" && pendingUser) {
      turns.push([pendingUser, entry]);
      pendingUser = undefined;
    }
  }

  return { turns, pendingUser };
}

function flattenConversationHistory(
  turns: ConversationTurn[],
  pendingUser?: ConversationEntry
): ConversationEntry[] {
  const history = turns.flatMap(([user, assistant]) => [user, assistant]);
  if (pendingUser) {
    history.push(pendingUser);
  }
  return history;
}

function conversationMessageCount(
  turns: ConversationTurn[],
  pendingUser?: ConversationEntry
): number {
  return turns.length * 2 + (pendingUser ? 1 : 0);
}

function conversationCharCount(
  turns: ConversationTurn[],
  pendingUser?: ConversationEntry
): number {
  return turns.reduce(
    (sum, [user, assistant]) => sum + user.content.length + assistant.content.length,
    pendingUser?.content.length ?? 0
  );
}

function buildToolPromptQuestion(
  question: string,
  runState?: RunState
): string {
  const memory = buildToolRuntimeMemory(question, runState?.observations ?? []);
  if (!memory) {
    return question;
  }
  return `${question}\n\n${memory}`;
}

function buildToolRuntimeMemory(
  question: string,
  observations: Observation[]
): string {
  if (observations.length === 0) {
    return "";
  }

  const selected = selectToolMemoryObservations(question, observations);
  if (selected.length === 0) {
    return "";
  }

  const lines = [
    "Previously gathered tool memory (reuse this before calling tools again):",
  ];

  for (const observation of selected) {
    const parts = [
      `- ${observation.tool} [${observation.status}] ${observation.summary}`,
    ];
    const sourceTitles = [
      ...new Set(
        observation.artifacts
          .map((artifact) => artifact.title.trim())
          .filter((title) => title.length > 0)
      ),
    ].slice(0, 2);
    if (sourceTitles.length > 0) {
      parts.push(`Sources: ${sourceTitles.join(", ")}`);
    }

    const detail = summarizeObservationDetail(observation);
    if (detail) {
      parts.push(`Key detail: ${detail}`);
    }

    lines.push(parts.join(" "));
  }

  const nextStep = buildNextToolStep(selected);
  if (nextStep) {
    lines.push(nextStep);
  }

  lines.push("Only call a tool if you still need new evidence beyond this memory.");

  const rendered = lines.join("\n");
  if (rendered.length <= MAX_TOOL_MEMORY_CHARS) {
    return rendered;
  }

  return `${rendered.slice(0, MAX_TOOL_MEMORY_CHARS - 3).trimEnd()}...`;
}

function selectToolMemoryObservations(
  question: string,
  observations: Observation[]
): Observation[] {
  const selected = selectSupplementalEvidenceObservations(observations, question);
  const coveredArtifactIds = collectObservationArtifactIds(selected);
  const failedArtifactIds = collectFailedReadArtifactIds(observations);
  const excludedBreadcrumbArtifactIds = new Set([
    ...coveredArtifactIds,
    ...failedArtifactIds,
  ]);
  const searchBreadcrumbs = selectRelevantSearchBreadcrumbObservations(
    question,
    observations,
    {
      coveredArtifactIds,
      failedArtifactIds,
    }
  ).map((observation) =>
    pruneSearchBreadcrumbArtifacts(observation, excludedBreadcrumbArtifactIds)
  );
  if (selected.length === 0 && searchBreadcrumbs.length === 0) {
    return [];
  }

  const recentFailures = selectRecentFailedToolObservations(question, observations);
  const combined = [...selected];
  for (const observation of searchBreadcrumbs) {
    if (!combined.includes(observation)) {
      combined.push(observation);
    }
  }
  for (const observation of recentFailures) {
    if (!combined.includes(observation)) {
      combined.push(observation);
    }
  }
  return combined;
}

function buildNextToolStep(observations: Observation[]): string | null {
  const grounded = observations.some(
    (observation) => observation.status === "ok" && observation.content?.trim()
  );
  if (grounded) {
    return null;
  }

  const candidateTitles = [
    ...new Set(
      observations
        .filter(
          (observation) =>
            observation.status === "ok" &&
            (observation.tool === "search_workspace" ||
              observation.tool === "search_course")
        )
        .flatMap((observation) => observation.artifacts)
        .map((artifact) => artifact.title.trim())
        .filter((title) => title.length > 0)
    ),
  ].slice(0, MAX_NEXT_STEP_SOURCES);

  if (candidateTitles.length === 0) {
    return null;
  }

  const candidates =
    candidateTitles.length === 1
      ? `"${candidateTitles[0]}"`
      : candidateTitles
          .map((title) => `"${title}"`)
          .join(", ");

  return `Unresolved next step: you already found candidate sources but do not have grounded text yet. Reuse those breadcrumbs and call read_file on ${candidates} before running another search or answering from snippets.`;
}

function selectRecentFailedToolObservations(
  question: string,
  observations: Observation[]
): Observation[] {
  const failures = observations.filter((observation) => observation.status !== "ok");
  const relevantFailures = selectRelevantObservations(failures, question, 2);
  if (relevantFailures.length > 0) {
    return relevantFailures;
  }
  return failures.slice(-2);
}

function summarizeObservationDetail(
  observation: Observation
): string | null {
  const fromExcerpt = observation.artifacts
    .map((artifact) => cleanInlineText(artifact.excerpt))
    .find((excerpt) => excerpt.length > 0);
  const detail = cleanInlineText(observation.content) || fromExcerpt;
  if (!detail) {
    return null;
  }
  if (detail.length <= MAX_TOOL_MEMORY_DETAIL_CHARS) {
    return detail;
  }
  return `${detail.slice(0, MAX_TOOL_MEMORY_DETAIL_CHARS - 3).trimEnd()}...`;
}
