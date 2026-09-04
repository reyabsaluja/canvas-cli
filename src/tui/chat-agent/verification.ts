import type { Observation } from "../../agent/observation.js";
import { questionNeedsMultipleSources } from "../../agent/question-intent.js";
import {
  isGroundedContentObservation,
  scoreObservationRelevance,
} from "../../agent/observation-relevance.js";
import {
  answerLooksLikeNotFound,
  findUnsupportedAnswerClaims,
} from "../../agent/verify.js";

export function selectSupplementalEvidenceObservations(
  observations: Observation[],
  question?: string
): Observation[] {
  const allCandidates = observations.filter(canObservationSupportAnswerRecovery);
  if (allCandidates.length === 0) {
    return [];
  }

  const grounded = allCandidates.filter((observation) =>
    isGroundedContentObservation(observation)
  );
  const relevantGrounded = selectRelevantObservations(grounded, question, 3);
  if (relevantGrounded.length > 0) {
    return relevantGrounded;
  }

  const relevant = selectRelevantObservations(allCandidates, question, 3);
  if (relevant.length > 0) {
    return relevant;
  }

  const fallbackCandidates = grounded.length > 0 ? grounded : allCandidates;
  if (fallbackCandidates.length <= 3) {
    return fallbackCandidates;
  }

  return fallbackCandidates.slice(-3);
}

export function selectRelevantObservations(
  observations: Observation[],
  question: string | undefined,
  limit: number
): Observation[] {
  const trimmedQuestion = question?.trim();
  if (!trimmedQuestion) {
    return [];
  }

  const ranked = observations
    .map((observation, index) => ({
      observation,
      index,
      score: scoreObservationRelevance(trimmedQuestion, observation),
    }))
    .filter((entry) => entry.score > 0);

  if (ranked.length === 0) {
    return [];
  }

  return ranked
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.index - left.index;
    })
    .slice(0, limit)
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.observation);
}

export function selectRelevantSearchBreadcrumbObservations(
  question: string,
  observations: Observation[],
  options?: {
    coveredArtifactIds?: Set<string>;
    failedArtifactIds?: Set<string>;
  }
): Observation[] {
  const coveredArtifactIds = options?.coveredArtifactIds ?? new Set<string>();
  const failedArtifactIds = options?.failedArtifactIds ?? new Set<string>();
  const viableCandidates = observations.filter(
    (observation) =>
      isSuccessfulSearchBreadcrumbObservation(observation) &&
      observation.artifacts.some(
        (artifact) =>
          !coveredArtifactIds.has(artifact.artifactId) &&
          !failedArtifactIds.has(artifact.artifactId)
      )
  );
  if (viableCandidates.length > 0) {
    return selectRelevantObservations(viableCandidates, question, 2);
  }

  if (failedArtifactIds.size === 0) {
    return [];
  }

  const fallbackCandidates = observations.filter(
    (observation) =>
      isSuccessfulSearchBreadcrumbObservation(observation) &&
      observation.artifacts.some(
        (artifact) => !coveredArtifactIds.has(artifact.artifactId)
      )
  );
  if (fallbackCandidates.length === 0) {
    return [];
  }
  return selectRelevantObservations(fallbackCandidates, question, 2);
}

export function selectRecoveryReadArtifactId(
  question: string,
  currentTurnObservations: Observation[],
  allObservations: Observation[] = currentTurnObservations
): string | null {
  const groundedCurrentTurn = selectRelevantObservations(
    currentTurnObservations.filter((observation) =>
      isGroundedContentObservation(observation)
    ),
    question,
    1
  );
  if (groundedCurrentTurn.length > 0) {
    return null;
  }

  const failedArtifactIds = collectFailedReadArtifactIds(allObservations);
  const breadcrumbs = selectRelevantSearchBreadcrumbObservations(
    question,
    currentTurnObservations,
    { failedArtifactIds }
  );

  for (const observation of breadcrumbs) {
    for (const artifact of observation.artifacts) {
      if (!failedArtifactIds.has(artifact.artifactId)) {
        return artifact.artifactId;
      }
    }
  }

  return null;
}

export function collectFailedReadArtifactIds(
  observations: Observation[]
): Set<string> {
  const artifactIds = new Set<string>();
  for (const observation of observations) {
    if (
      observation.status === "ok" ||
      (observation.tool !== "read_file" &&
        observation.tool !== "download_course_file")
    ) {
      continue;
    }
    for (const artifact of observation.artifacts) {
      artifactIds.add(artifact.artifactId);
    }
  }
  return artifactIds;
}

export function pruneSearchBreadcrumbArtifacts(
  observation: Observation,
  excludedArtifactIds: Set<string>
): Observation {
  if (
    excludedArtifactIds.size === 0 ||
    !isSuccessfulSearchBreadcrumbObservation(observation)
  ) {
    return observation;
  }

  const filteredArtifacts = observation.artifacts.filter(
    (artifact) => !excludedArtifactIds.has(artifact.artifactId)
  );
  if (
    filteredArtifacts.length === 0 ||
    filteredArtifacts.length === observation.artifacts.length
  ) {
    return observation;
  }

  return {
    ...observation,
    artifacts: filteredArtifacts,
  };
}

export function collectObservationArtifactIds(
  observations: Observation[]
): Set<string> {
  const artifactIds = new Set<string>();
  for (const observation of observations) {
    for (const artifact of observation.artifacts) {
      artifactIds.add(artifact.artifactId);
    }
  }
  return artifactIds;
}

export function resolveToolTurnVerificationObservations(
  observations: Observation[],
  observationStart: number,
  question?: string
): Observation[] {
  const currentTurn = observations.slice(observationStart);
  if (currentTurn.length === 0) {
    return selectSupplementalEvidenceObservations(observations, question);
  }

  const currentTurnGrounded = currentTurn.filter((observation) =>
    isGroundedContentObservation(observation)
  );
  if (
    currentTurnGrounded.length > 0 &&
    (!question ||
      selectRelevantObservations(currentTurnGrounded, question, 1).length > 0)
  ) {
    return currentTurn;
  }

  const priorSupport = selectSupplementalEvidenceObservations(
    observations.slice(0, observationStart),
    question
  );
  if (priorSupport.length === 0) {
    return currentTurn;
  }

  return [...priorSupport, ...currentTurn];
}

export function shouldRecoverFromToolLoop(
  answer: string,
  observations: Observation[]
): boolean {
  if (answer.trim().length > 0) {
    return false;
  }

  return observations.some(canObservationSupportAnswerRecovery);
}

// ---------------------------------------------------------------------------
// Post-answer recovery selectors.
//
// The tool loop is allowed to stop early; these decide, deterministically and
// after the model has answered, whether the turn should keep looking: read a
// search hit the answer leaned on, try tools the model never touched after a
// "not found" answer, open the announcement it only listed, or ground the
// second side of a comparison. They are pure so the loop in recovery.ts can
// be driven by fakes in tests.

export interface RecoveryToolCall {
  name: string;
  input: Record<string, unknown>;
}

/**
 * The search hit the answer most likely came from but that was never read:
 * an artifact from a successful breadcrumb this turn that is neither grounded
 * nor known to fail. Unlike selectRecoveryReadArtifactId this does not give
 * up when some other grounded read exists, because the unread hit may be the
 * one the answer quoted.
 */
export function selectUngroundedSearchRecoveryReadArtifactId(
  question: string,
  currentTurnObservations: Observation[],
  allObservations: Observation[] = currentTurnObservations
): string | null {
  const groundedArtifactIds = collectObservationArtifactIds(
    currentTurnObservations.filter((observation) =>
      isGroundedContentObservation(observation)
    )
  );
  const failedArtifactIds = collectFailedReadArtifactIds(allObservations);
  const breadcrumbs = selectRelevantSearchBreadcrumbObservations(
    question,
    currentTurnObservations,
    { coveredArtifactIds: groundedArtifactIds, failedArtifactIds }
  );

  for (const observation of breadcrumbs) {
    for (const artifact of observation.artifacts) {
      if (
        groundedArtifactIds.has(artifact.artifactId) ||
        failedArtifactIds.has(artifact.artifactId)
      ) {
        continue;
      }
      return artifact.artifactId;
    }
  }

  return null;
}

/**
 * True when a non-empty answer was given from search snippets: the turn has a
 * successful search breadcrumb with an unread, unfailed artifact, and the
 * answer either states a checkable figure (date, time, number) beyond what
 * the question already said, or visibly echoes that breadcrumb. Trivial
 * answers to trivial questions are left alone so they are not answered twice.
 */
export function shouldGroundUnverifiedAnswer(
  answer: string,
  currentTurnObservations: Observation[],
  question: string
): boolean {
  if (answer.trim().length === 0) {
    return false;
  }

  const breadcrumbs = currentTurnObservations.filter(
    isSuccessfulSearchBreadcrumbObservation
  );
  if (breadcrumbs.length === 0) {
    return false;
  }

  const recoverableArtifactId = selectUngroundedSearchRecoveryReadArtifactId(
    question,
    currentTurnObservations,
    currentTurnObservations
  );
  if (recoverableArtifactId === null) {
    return false;
  }

  return (
    answerStatesCheckableFigure(answer, question) ||
    answerEchoesBreadcrumb(answer, breadcrumbs, recoverableArtifactId)
  );
}

/**
 * After recovery reads, regenerate the snippet-based answer only when the
 * turn now holds a grounded read that is relevant to the question.
 */
export function shouldRegenerateAnswerAfterRecoveryRead(input: {
  answer: string;
  question: string;
  beforeRecoveryObservations: Observation[];
  afterRecoveryObservations: Observation[];
}): boolean {
  if (
    !shouldGroundUnverifiedAnswer(
      input.answer,
      input.beforeRecoveryObservations,
      input.question
    )
  ) {
    return false;
  }

  const relevantGroundedAfterRecovery = selectRelevantObservations(
    input.afterRecoveryObservations.filter((observation) =>
      isGroundedContentObservation(observation)
    ),
    input.question,
    1
  );
  return relevantGroundedAfterRecovery.length > 0;
}

/** True when the answer tells the student the information was not found. */
export function shouldRecoverFromNoInfoAnswer(answer: string): boolean {
  return answerLooksLikeNotFound(answer);
}

/**
 * Tools worth trying after a "not found" answer, in order, skipping anything
 * already tried this turn: the assignment list for due-date style questions,
 * announcements when the question is about a post, then a workspace and a
 * course search built from the question's key words, and finally list_files
 * when nothing else applies.
 */
export function selectNoInfoRecoveryToolCalls(
  question: string,
  availableToolNames: string[],
  currentTurnObservations: Observation[]
): RecoveryToolCall[] {
  const available = new Set(availableToolNames);
  const query = buildNoInfoRecoverySearchQuery(question);
  const calls: RecoveryToolCall[] = [];

  if (
    available.has("list_assignments") &&
    questionLooksLikeAssignmentListQuestion(question) &&
    !toolWasTried("list_assignments", currentTurnObservations)
  ) {
    calls.push({ name: "list_assignments", input: {} });
  }

  if (
    available.has("list_announcements") &&
    questionNeedsThreadContent(question) &&
    !toolWasTried("list_announcements", currentTurnObservations)
  ) {
    calls.push({ name: "list_announcements", input: { filter: "all", query } });
  }

  if (
    available.has("search_workspace") &&
    !searchToolWasTried("search_workspace", query, currentTurnObservations)
  ) {
    calls.push({ name: "search_workspace", input: { query } });
  }

  if (
    available.has("search_course") &&
    !searchToolWasTried("search_course", query, currentTurnObservations)
  ) {
    calls.push({ name: "search_course", input: { query } });
  }

  if (
    calls.length === 0 &&
    available.has("list_files") &&
    !toolWasTried("list_files", currentTurnObservations)
  ) {
    calls.push({ name: "list_files", input: {} });
  }

  return calls;
}

/**
 * Whether a recovery result moved the turn forward: grounded text, a search
 * with hits, a listing with actual [A]/[D] rows, or any other successful
 * result that carries artifacts or content.
 */
export function isUsefulNoInfoRecoveryResult(observation: Observation): boolean {
  if (isGroundedContentObservation(observation)) {
    return true;
  }

  if (observation.status !== "ok") {
    return false;
  }

  if (
    observation.tool === "search_workspace" ||
    observation.tool === "search_course"
  ) {
    return observation.artifacts.length > 0;
  }

  if (observation.tool === "list_announcements") {
    return THREAD_LIST_ROW_PATTERN.test(observation.content ?? "");
  }

  return (
    observation.artifacts.length > 0 ||
    (typeof observation.content === "string" && observation.content.trim().length > 0)
  );
}

/**
 * After a list_announcements result with [A]/[D] rows, the unread title that
 * best matches a question asking what a post actually said.
 */
export function selectThreadRecoveryTopic(
  question: string,
  currentTurnObservations: Observation[],
  allObservations: Observation[] = currentTurnObservations
): string | null {
  if (!questionNeedsThreadContent(question)) {
    return null;
  }

  const relevantThreadRead = selectRelevantObservations(
    allObservations.filter(
      (observation) =>
        observation.tool === "read_thread" &&
        isGroundedContentObservation(observation)
    ),
    question,
    1
  );
  if (relevantThreadRead.length > 0) {
    return null;
  }

  const listObservation = [...currentTurnObservations]
    .reverse()
    .find(isSuccessfulThreadListObservation);
  if (!listObservation) {
    return null;
  }

  const readTitles = new Set(
    allObservations
      .filter((observation) => observation.tool === "read_thread")
      .flatMap((observation) => observation.artifacts.map((artifact) => artifact.title))
      .map(normalizeThreadLookupText)
      .filter((title) => title.length > 0)
  );
  const titles = extractListedThreadTitles(listObservation.content ?? "").filter(
    (title) => !readTitles.has(normalizeThreadLookupText(title))
  );
  if (titles.length === 0) {
    return null;
  }

  return rankListedThreadTitles(question, titles)[0] ?? null;
}

/** True when the question asks what a post or the instructor actually said. */
export function questionNeedsThreadContent(question: string): boolean {
  const asksAboutCoursePost =
    /\b(announcements?|discussions?|threads?|posts?|repl(?:y|ies))\b/i.test(question);
  const asksForPostDetail =
    /\b(clarif(?:y|ied|ication)|instructor|prof(?:essor)?|said|says?|mention(?:ed)?|posted|details?|content|repl(?:y|ies)|response)\b/i.test(
      question
    ) || /\bwhat\s+(?:did|does)\b/i.test(question);

  return (
    asksForPostDetail &&
    (asksAboutCoursePost || /\bprof(?:essor)?\b/i.test(question))
  );
}

/**
 * For a multi-source question grounded in exactly one relevant artifact: the
 * unread breadcrumb artifact that could supply the other side.
 */
export function selectComplementaryRecoveryReadArtifactId(
  question: string,
  currentTurnObservations: Observation[],
  allObservations: Observation[] = currentTurnObservations
): string | null {
  if (!questionNeedsMultipleSources(question)) {
    return null;
  }

  const groundedCurrentTurn = currentTurnObservations.filter((observation) =>
    isGroundedContentObservation(observation)
  );
  const relevantGrounded = selectRelevantObservations(groundedCurrentTurn, question, 3);
  if (relevantGrounded.length === 0) {
    return null;
  }

  if (collectObservationArtifactIds(relevantGrounded).size >= 2) {
    return null;
  }

  const groundedArtifactIds = collectObservationArtifactIds(groundedCurrentTurn);
  const failedArtifactIds = collectFailedReadArtifactIds(allObservations);
  const breadcrumbs = selectRelevantSearchBreadcrumbObservations(
    question,
    currentTurnObservations,
    { coveredArtifactIds: groundedArtifactIds, failedArtifactIds }
  );

  for (const observation of breadcrumbs) {
    for (const artifact of observation.artifacts) {
      if (
        groundedArtifactIds.has(artifact.artifactId) ||
        failedArtifactIds.has(artifact.artifactId)
      ) {
        continue;
      }
      return artifact.artifactId;
    }
  }

  return null;
}

/**
 * For a multi-source question grounded in exactly one relevant artifact with
 * no breadcrumb to read next: one search per scope so a complementary read
 * becomes possible.
 */
export function selectComplementarySearchToolCalls(
  question: string,
  availableToolNames: string[],
  currentTurnObservations: Observation[],
  allObservations: Observation[] = currentTurnObservations
): RecoveryToolCall[] {
  if (!questionNeedsMultipleSources(question)) {
    return [];
  }

  const groundedCurrentTurn = currentTurnObservations.filter((observation) =>
    isGroundedContentObservation(observation)
  );
  const relevantGrounded = selectRelevantObservations(groundedCurrentTurn, question, 3);
  if (relevantGrounded.length === 0) {
    return [];
  }

  if (collectObservationArtifactIds(relevantGrounded).size >= 2) {
    return [];
  }

  if (
    selectComplementaryRecoveryReadArtifactId(
      question,
      currentTurnObservations,
      allObservations
    )
  ) {
    return [];
  }

  const available = new Set(availableToolNames);
  const query = buildNoInfoRecoverySearchQuery(question);
  const calls: RecoveryToolCall[] = [];

  if (
    available.has("search_workspace") &&
    !searchToolWasTried("search_workspace", query, currentTurnObservations)
  ) {
    calls.push({ name: "search_workspace", input: { query } });
  }

  if (
    available.has("search_course") &&
    !searchToolWasTried("search_course", query, currentTurnObservations)
  ) {
    calls.push({ name: "search_course", input: { query } });
  }

  return calls;
}

export function shouldContinueToolLoopAfterGateRead(
  question: string,
  observation: Observation,
  allObservations: Observation[] = [observation]
): boolean {
  if (!isGroundedContentObservation(observation)) {
    return true;
  }

  if (!questionNeedsMultipleSources(question)) {
    return false;
  }

  const relevantGrounded = selectRelevantObservations(
    allObservations.filter((entry) => isGroundedContentObservation(entry)),
    question,
    2
  );
  return relevantGrounded.length < 2;
}

export function selectArtifactSupportObservations(
  observations: Observation[],
  artifactIds: string[]
): Observation[] {
  const uniqueArtifactIds = [...new Set(artifactIds)];
  const selected: Observation[] = [];

  for (const artifactId of uniqueArtifactIds) {
    const best = findBestObservationForArtifact(observations, artifactId);
    if (best) {
      selected.push(best);
    }
  }

  return selected;
}

/**
 * Final answer text for the turn. When the loop produced nothing, say so and,
 * if the caller passes the verification's `checkedSources` trail, name what
 * was checked so the student knows how far the search went.
 */
export function finalizeAnswerText(
  answer: string,
  missing: string[],
  checkedSources?: string | null
): string {
  const trimmed = answer.trim();
  if (!trimmed) {
    const trail = checkedSources?.trim();
    return trail
      ? `I wasn't able to find a clear answer after checking: ${trail}.`
      : "I wasn't able to find a clear answer.";
  }
  return trimmed;
}

function canObservationSupportAnswerRecovery(
  observation: Observation
): boolean {
  if (isGroundedContentObservation(observation)) {
    return true;
  }

  if (observation.status !== "ok") {
    return false;
  }

  return (
    observation.artifacts.length > 0 ||
    (typeof observation.content === "string" &&
      observation.content.trim().length > 0)
  );
}

function isSuccessfulSearchBreadcrumbObservation(
  observation: Observation
): boolean {
  return (
    observation.status === "ok" &&
    observation.artifacts.length > 0 &&
    !observation.content &&
    (observation.tool === "search_workspace" ||
      observation.tool === "search_course")
  );
}

/** A date, time, or multi-digit figure in the answer that the question did not supply. */
function answerStatesCheckableFigure(answer: string, question: string): boolean {
  return findUnsupportedAnswerClaims(answer, "", question).length > 0;
}

/**
 * The answer names the unread search hit (its filename stem) or reproduces a
 * run of words from its snippet, which is how a snippet-only answer looks.
 */
function answerEchoesBreadcrumb(
  answer: string,
  breadcrumbs: Observation[],
  artifactId: string
): boolean {
  const normalizedAnswer = normalizeRecoverySearchText(answer);
  if (!normalizedAnswer) {
    return false;
  }
  for (const breadcrumb of breadcrumbs) {
    const artifact = breadcrumb.artifacts.find((entry) => entry.artifactId === artifactId);
    if (!artifact) {
      continue;
    }
    const basename = artifact.title.split("/").pop() ?? artifact.title;
    const stem = normalizeRecoverySearchText(basename).replace(
      /\s+(?:pdf|docx?|pptx?|xlsx?|txt|md|zip|html?)$/,
      ""
    );
    if (stem.length >= 4 && normalizedAnswer.includes(stem)) {
      return true;
    }
    const excerptWords = normalizeRecoverySearchText(artifact.excerpt ?? "").split(" ");
    for (let start = 0; start + ECHO_WORD_RUN <= excerptWords.length; start += 1) {
      const run = excerptWords.slice(start, start + ECHO_WORD_RUN).join(" ");
      if (normalizedAnswer.includes(run)) {
        return true;
      }
    }
  }
  return false;
}

const ECHO_WORD_RUN = 5;

const NO_INFO_RECOVERY_QUERY_STOP_WORDS = new Set([
  "about", "after", "again", "also", "and", "any", "are", "between", "both",
  "can", "change", "changed", "compare", "comparison", "could", "did",
  "difference", "different", "does", "each", "for", "from", "have", "how",
  "instructor", "into", "is", "it", "me", "mention", "my", "of", "on", "or",
  "please", "prof", "professor", "say", "says", "said", "should", "that",
  "the", "this", "to", "was", "were", "what", "when", "where", "which",
  "with", "versus",
]);

/** The question's first four content words, for a broad recovery search. */
function buildNoInfoRecoverySearchQuery(question: string): string {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of question
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)) {
    if (!token || seen.has(token) || NO_INFO_RECOVERY_QUERY_STOP_WORDS.has(token)) {
      continue;
    }
    if (token.length < 3 && !/^\d+$/.test(token)) {
      continue;
    }
    seen.add(token);
    tokens.push(token);
  }

  const query = tokens.slice(0, 4).join(" ");
  return query || question.trim().replace(/\s+/g, " ").slice(0, 80);
}

function questionLooksLikeAssignmentListQuestion(question: string): boolean {
  return /\b(assignments?|labs?|homeworks?|projects?|quizzes?|work|todo|to-do|due|deadlines?|upcoming|submit|submission)\b/i.test(
    question
  );
}

function toolWasTried(toolName: string, observations: Observation[]): boolean {
  return observations.some((observation) => observation.tool === toolName);
}

/** True when this search tool already ran with (a summary that contains) this query. */
function searchToolWasTried(
  toolName: string,
  query: string,
  observations: Observation[]
): boolean {
  const normalizedQuery = normalizeRecoverySearchText(query);
  return observations.some((observation) => {
    if (observation.tool !== toolName) {
      return false;
    }
    if (!normalizedQuery) {
      return true;
    }
    return normalizeRecoverySearchText(observation.summary).includes(normalizedQuery);
  });
}

function normalizeRecoverySearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const THREAD_LIST_ROW_PATTERN = /^\s*\[[AD]\]\s+\S/m;

function isSuccessfulThreadListObservation(observation: Observation): boolean {
  return (
    observation.tool === "list_announcements" &&
    observation.status === "ok" &&
    THREAD_LIST_ROW_PATTERN.test(observation.content ?? "")
  );
}

/** Titles from "[A] Title — author — course — age" rows, in listing order. */
function extractListedThreadTitles(content: string): string[] {
  const titles: string[] = [];
  const seen = new Set<string>();
  for (const line of content.split("\n")) {
    const match = line.match(/^\s*\[[AD]\]\s+(.+?)(?:\s+—\s+|$)/);
    const title = match?.[1]?.trim();
    if (!title) {
      continue;
    }
    const key = normalizeThreadLookupText(title);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    titles.push(title);
  }
  return titles;
}

function rankListedThreadTitles(question: string, titles: string[]): string[] {
  const questionText = normalizeThreadLookupText(question);
  const questionTokens = new Set(tokenizeThreadLookupText(questionText));
  return titles
    .map((title, index) => {
      const titleText = normalizeThreadLookupText(title);
      let score = questionText.includes(titleText) ? 12 : 0;
      for (const token of tokenizeThreadLookupText(titleText)) {
        if (questionTokens.has(token)) {
          score += 3;
        }
      }
      return { title, index, score };
    })
    .sort((left, right) =>
      right.score !== left.score ? right.score - left.score : left.index - right.index
    )
    .map((entry) => entry.title);
}

function normalizeThreadLookupText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeThreadLookupText(value: string): string[] {
  return value.split(/\s+/).filter((token) => token.length > 2);
}

function findBestObservationForArtifact(
  observations: Observation[],
  artifactId: string
): Observation | null {
  let fallback: Observation | null = null;

  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const observation = observations[index]!;
    if (
      !observation.artifacts.some((artifact) => artifact.artifactId === artifactId)
    ) {
      continue;
    }

    if (!fallback) {
      fallback = observation;
    }

    if (isGroundedContentObservation(observation)) {
      return observation;
    }
  }

  return fallback;
}
