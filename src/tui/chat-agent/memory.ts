import type { Observation } from "../../agent/observation.js";
import type { RunState } from "../../agent/run-state.js";
import { buildMatchExcerpt } from "../../knowledge/artifact-index.js";
import { isGroundedContentObservation } from "../../agent/observation-relevance.js";
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
/** Coverage labels ("syllabus.pdf — Late Policy") named in the evidence checkpoint. */
const MAX_CHECKPOINT_COVERAGE_LABELS = 3;
/** Unread search candidates named as the likely next read in the checkpoint. */
const MAX_CHECKPOINT_NEXT_READS = 2;

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
  // A listing (list_announcements) has content but is not a grounded read;
  // isGroundedContentObservation keeps it out of the coverage count.
  const groundedObservations = observations.filter((observation) =>
    isGroundedContentObservation(observation)
  );
  const groundedArtifactIds = new Set(
    groundedObservations
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
      return buildEvidenceSufficientDirective(
        groundedObservations,
        candidateTitles
      );
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

/**
 * Per-question coverage prompt once at least one grounded read exists. It
 * never tells the model to stop: it names what the evidence covers, asks it
 * to check every specific detail of the question against that, and points at
 * the best unread candidate for a follow-up read.
 */
function buildEvidenceSufficientDirective(
  groundedObservations: Observation[],
  remainingCandidateTitles: string[]
): string {
  const sourceCount = new Set(
    groundedObservations
      .flatMap((observation) => observation.artifacts)
      .map((artifact) => artifact.artifactId)
  ).size;

  const coverageLabels = collectGroundedCoverageLabels(groundedObservations);
  const coverageSummary =
    coverageLabels.length > 0 ? ` covering: ${coverageLabels.join("; ")}.` : ".";

  const parts = [
    `Evidence checkpoint: you have grounded text from ${sourceCount} source${sourceCount > 1 ? "s" : ""}${coverageSummary}`,
    "Compare this evidence against the student's question — does it address every specific detail with exact facts (dates, points, names, steps)?",
    "If any detail is vague, partially covered, or could be more specific, do a follow-up read to strengthen your answer.",
  ];

  if (remainingCandidateTitles.length > 0) {
    const candidates = remainingCandidateTitles
      .slice(0, MAX_CHECKPOINT_NEXT_READS)
      .map((title) => `"${title}"`)
      .join(", ");
    parts.push(
      `Likely next read: ${candidates}. Read before answering if the evidence above doesn't fully nail every detail.`
    );
  } else {
    parts.push(
      "If a specific detail is still missing, run one more focused search (search_workspace, search_course, or list_announcements then read_thread) for it; if nothing turns up, state exactly what you found and what could not be verified."
    );
  }

  return parts.join(" ");
}

/**
 * "title — section" labels for what the grounded reads covered, using the
 * same section/cut-off framing as describeReadCoverage so the checkpoint and
 * the per-observation memory lines agree about what was and was not read.
 */
function collectGroundedCoverageLabels(
  groundedObservations: Observation[]
): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();

  for (const observation of groundedObservations) {
    for (const artifact of observation.artifacts) {
      let label = formatToolMemorySourceLabel(artifact);
      if (!label) {
        continue;
      }
      if (artifact.truncated && (artifact.omittedLabels?.length ?? 0) > 0) {
        const omitted = artifact.omittedLabels ?? [];
        const shown = omitted.slice(0, 4).join(", ");
        const more = omitted.length > 4 ? ` and ${omitted.length - 4} more` : "";
        label = `${label} (cut off; not read: ${shown}${more})`;
      }
      if (!seen.has(label)) {
        seen.add(label);
        labels.push(label);
      }
    }
  }

  return labels.slice(0, MAX_CHECKPOINT_COVERAGE_LABELS);
}

/**
 * Titles of search hits that are still worth reading: not already read in
 * full and not a target whose read already failed.
 */
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

/** "title — section" when the artifact is a section read, else the title. */
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
