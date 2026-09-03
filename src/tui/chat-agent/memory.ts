import type { Observation } from "../../agent/observation.js";
import type { RunState } from "../../agent/run-state.js";
import { buildMatchExcerpt } from "../../knowledge/artifact-index.js";
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
/**
 * Budget for the "what you already read" block. The prompt tells the model
 * not to re-read documents it has, so this memory has to carry enough of
 * each read to answer follow-ups; a head slice of a few hundred characters
 * did not. Details are centred on the current question, not the document
 * head.
 */
const MAX_TOOL_MEMORY_CHARS = 12000;
const MAX_TOOL_MEMORY_DETAIL_CHARS = 1200;
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

    const coverage = describeReadCoverage(observation);
    if (coverage) {
      parts.push(coverage);
    }

    const detail = summarizeObservationDetail(observation, question);
    if (detail) {
      parts.push(`Key detail: ${detail}`);
    }

    lines.push(parts.join(" "));
  }

  const nextStep = buildNextToolStep(question, selected);
  if (nextStep) {
    lines.push(nextStep);
  }

  lines.push(
    "Reuse this memory instead of repeating the same calls, and call tools for any evidence it does not already contain."
  );

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

  const needsMultipleSources = questionNeedsMultipleSources(question);
  if (groundedArtifactIds.size > 0) {
    if (!needsMultipleSources || groundedArtifactIds.size > 1) {
      return null;
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

/** Which sections a read covered, and which it did not. */
function describeReadCoverage(observation: Observation): string | null {
  const notes: string[] = [];
  const sectionLabels = [
    ...new Set(
      observation.artifacts
        .map((artifact) => artifact.sectionLabel?.trim() ?? "")
        .filter((label) => label.length > 0)
    ),
  ];
  if (sectionLabels.length > 0) {
    notes.push(`Section read: ${sectionLabels.join(", ")}.`);
  }
  const truncated = observation.artifacts.find(
    (artifact) => artifact.truncated && (artifact.omittedLabels?.length ?? 0) > 0
  );
  if (truncated) {
    const omitted = truncated.omittedLabels ?? [];
    const shown = omitted.slice(0, 8).join(", ");
    const more = omitted.length > 8 ? ` and ${omitted.length - 8} more` : "";
    notes.push(
      `Cut off before the end; not read: ${shown}${more} (read_file with section: to fetch one).`
    );
  }
  return notes.length > 0 ? notes.join(" ") : null;
}

function summarizeObservationDetail(
  observation: Observation,
  question: string = ""
): string | null {
  const fromExcerpt = observation.artifacts
    .map((artifact) => cleanInlineText(artifact.excerpt))
    .find((excerpt) => excerpt.length > 0);
  const raw = observation.content?.trim() ? observation.content : fromExcerpt;
  if (!raw) {
    return null;
  }
  const detail = cleanInlineText(raw);
  if (detail.length <= MAX_TOOL_MEMORY_DETAIL_CHARS) {
    return detail;
  }
  // Centre the remembered detail on what is being asked now rather than on
  // the document head; the head is rarely where the answer to a follow-up is.
  const centred = question.trim()
    ? buildMatchExcerpt(raw, question, MAX_TOOL_MEMORY_DETAIL_CHARS)
    : "";
  if (centred) {
    return centred;
  }
  return `${detail.slice(0, MAX_TOOL_MEMORY_DETAIL_CHARS - 3).trimEnd()}...`;
}
