import type { Observation } from "../../agent/observation.js";
import type { RunState } from "../../agent/run-state.js";
import { questionNeedsMultipleSources } from "../../agent/question-intent.js";
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
    "Coverage checkpoint: compare this memory to every requested detail in the student's question before acting. If it fully answers the question, answer directly. If one detail is missing, make one targeted follow-up search/read for that missing detail or state exactly what could not be verified.",
  ];

  for (const observation of selected) {
    const parts = [
      `- ${observation.tool} [${observation.status}] ${observation.summary}`,
    ];
    const sourceTitles = [
      ...new Set(
        observation.artifacts
          .map(formatToolMemorySourceLabel)
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

  const nextStep = buildNextToolStep(question, selected);
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
  const recentFailures = selectRecentFailedToolObservations(question, observations);
  if (
    selected.length === 0 &&
    searchBreadcrumbs.length === 0 &&
    recentFailures.length === 0
  ) {
    return [];
  }

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

function buildNextToolStep(
  question: string,
  observations: Observation[]
): string | null {
  const groundedArtifactIds = new Set(
    observations
      .filter((observation) => observation.status === "ok" && observation.content?.trim())
      .flatMap((observation) => observation.artifacts)
      .map((artifact) => artifact.artifactId)
  );
  const unavailableArtifactIds = new Set([
    ...groundedArtifactIds,
    ...collectFailedReadArtifactIds(observations),
  ]);
  const candidateTitles = collectViableSearchCandidateTitles(
    observations,
    unavailableArtifactIds
  );

  const needsMultipleSources = questionNeedsMultipleSources(question);
  if (groundedArtifactIds.size > 0) {
    if (!needsMultipleSources || groundedArtifactIds.size > 1) {
      const sourceCount = groundedArtifactIds.size;
      return `Evidence sufficient: you have grounded text from ${sourceCount} source${sourceCount > 1 ? "s" : ""}. Answer directly from this evidence — do not call another tool.`;
    }
    if (candidateTitles.length === 0) {
      return buildFailureRecoveryNextStep(observations, {
        needsMultipleSources,
        hasGroundedRead: true,
      });
    }

    const candidates =
      candidateTitles.length === 1
        ? `"${candidateTitles[0]}"`
        : candidateTitles
            .map((title) => `"${title}"`)
            .join(", ");

    return `Unresolved next step: this question needs a comparison across sources, and you only have one grounded read so far. Reuse the breadcrumb and call read_file on ${candidates} before concluding or launching another search.`;
  }

  if (candidateTitles.length === 0) {
    return buildFailureRecoveryNextStep(observations, {
      needsMultipleSources,
      hasGroundedRead: false,
    });
  }

  const candidates =
    candidateTitles.length === 1
      ? `"${candidateTitles[0]}"`
      : candidateTitles
          .map((title) => `"${title}"`)
          .join(", ");

  return `Unresolved next step: you already found candidate sources but do not have grounded text yet. Reuse those breadcrumbs and call read_file on ${candidates} before running another search or answering from snippets.`;
}

function collectViableSearchCandidateTitles(
  observations: Observation[],
  unavailableArtifactIds: Set<string>
): string[] {
  const titlesByArtifactId = new Map<string, string>();
  for (const observation of observations) {
    if (
      observation.status !== "ok" ||
      (observation.tool !== "search_workspace" &&
        observation.tool !== "search_course")
    ) {
      continue;
    }

    for (const artifact of observation.artifacts) {
      if (unavailableArtifactIds.has(artifact.artifactId)) {
        continue;
      }
      const title = artifact.title.trim();
      if (title.length > 0 && !titlesByArtifactId.has(artifact.artifactId)) {
        titlesByArtifactId.set(artifact.artifactId, title);
      }
    }
  }

  return [...titlesByArtifactId.values()].slice(0, MAX_NEXT_STEP_SOURCES);
}

function buildFailureRecoveryNextStep(
  observations: Observation[],
  options: {
    needsMultipleSources: boolean;
    hasGroundedRead: boolean;
  }
): string | null {
  const latestFailure = [...observations]
    .reverse()
    .find(
      (observation) =>
        observation.status !== "ok" &&
        (observation.tool === "read_file" ||
          observation.tool === "download_course_file" ||
          observation.tool === "search_workspace" ||
          observation.tool === "search_course")
    );
  if (!latestFailure) {
    return null;
  }

  const comparisonSuffix =
    options.needsMultipleSources && options.hasGroundedRead
      ? " before concluding the comparison."
      : ".";

  if (
    latestFailure.tool === "read_file" ||
    latestFailure.tool === "download_course_file"
  ) {
    return `Unresolved next step: the last read failed. Change tactics instead of retrying the same target. Use list_files to find the exact available filename or title, or run a more specific search to relocate the right source${comparisonSuffix}`;
  }

  return `Unresolved next step: the last search came up empty. Change tactics instead of repeating the same query. Try a more specific filename or title search, or use list_files to inspect what is actually available${comparisonSuffix}`;
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

function formatToolMemorySourceLabel(
  artifact: Observation["artifacts"][number]
): string {
  const title = artifact.title.trim();
  if (!title) {
    return "";
  }
  const section = artifact.sectionLabel?.trim();
  return section ? `${title} — ${section}` : title;
}
