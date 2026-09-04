export function questionExplicitlyComparesSources(question: string): boolean {
  const normalized = question.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    /\b(compare|comparison|versus|vs\.?|differ|difference|different|conflict|conflicts|contradict|contradiction|reconcile|consistent|inconsistent|disagree|disagreement)\b/i.test(
      normalized
    ) ||
    /\bcompare\b[\s\S]*\bto\b/i.test(normalized) ||
    /\bbetween\b[\s\S]*\band\b/i.test(normalized) ||
    /\bdo\b[\s\S]*\bagree\b/i.test(normalized) ||
    /\bwhich is correct\b/i.test(normalized) ||
    /\bsame or different\b/i.test(normalized)
  );
}

export function questionNeedsMultipleSources(question: string): boolean {
  const normalized = question.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    questionExplicitlyComparesSources(normalized) ||
    /\b(changed|change since|what changed)\b/i.test(normalized) ||
    questionAsksAboutMultipleTopics(normalized) ||
    questionAsksBroadPreparationQuestion(normalized)
  );
}

/**
 * Multi-part questions ("when is it due and how is it graded?") are rarely
 * answered by one section of one document. Detecting them makes the loop
 * ask for a second grounded read instead of stopping at the first.
 */
function questionAsksAboutMultipleTopics(normalized: string): boolean {
  const multiPartPatterns = [
    /\b(?:what|how|where|when|explain|describe|tell)\b[^?]*\band\s+(?:what|how|where|when|also|explain|describe|tell)\b/i,
    /\b(?:both|each of)\b/i,
    /\?\s*(?:also|and)\b/i,
  ];
  return (
    multiPartPatterns.some((pattern) => pattern.test(normalized)) ||
    questionMentionsMultipleEvidenceTopics(normalized)
  );
}

/**
 * Two distinct evidence topics (due date, submission, grading, late policy,
 * requirements, resources) with a joiner sitting between them: "and",
 * "plus", "as well as", "along with", "also", "both … and", or a comma or
 * semicolon. The joiner must separate the two mentions; a comma anywhere
 * else ("Hey, what's the late penalty in points?") or an "and" inside one
 * topic ("the due date and time") is not a second question.
 */
function questionMentionsMultipleEvidenceTopics(normalized: string): boolean {
  const mentions = collectEvidenceTopicMentions(normalized);
  for (let i = 0; i < mentions.length; i += 1) {
    for (let j = i + 1; j < mentions.length; j += 1) {
      const left = mentions[i]!;
      const right = mentions[j]!;
      if (left.topic === right.topic) {
        continue;
      }
      const between = normalized.slice(left.end, right.start);
      if (TOPIC_JOINER_PATTERN.test(between)) {
        return true;
      }
    }
  }
  return false;
}

const TOPIC_JOINER_PATTERN =
  /\b(?:and|also|plus|as\s+well\s+as|along\s+with)\b|[,;]/i;

const EVIDENCE_TOPIC_PATTERNS = [
  /\b(?:due|deadline|date|time|when|locks?|unlocks?|available|opens?|closes?)\b/gi,
  /\b(?:submit|submission|upload|format|files?|deliverables?|turn\s+in|hand\s+in|pdf|zip)\b/gi,
  /\b(?:grading?|graded|rubric|points?|pts?|marks?|score|percent(?:age)?|worth|weight(?:ed|s)?)\b/gi,
  /\b(?:late|extensions?|penalt(?:y|ies)|grace|accommodations?)\b/gi,
  /\b(?:requirements?|instructions?|spec(?:ification)?|criteria|steps?|parts?|tasks?|milestones?)\b/gi,
  /\b(?:resources?|attachments?|pages?|modules?|lectures?|slides?|videos?)\b/gi,
];

interface EvidenceTopicMention {
  topic: number;
  start: number;
  end: number;
}

/** Every topic word in the question with its position, in reading order. */
function collectEvidenceTopicMentions(normalized: string): EvidenceTopicMention[] {
  const mentions: EvidenceTopicMention[] = [];
  EVIDENCE_TOPIC_PATTERNS.forEach((pattern, topic) => {
    for (const match of normalized.matchAll(pattern)) {
      mentions.push({ topic, start: match.index, end: match.index + match[0].length });
    }
  });
  return mentions.sort((left, right) => left.start - right.start);
}

/**
 * "What should I know before starting?" spans the handout, the syllabus and
 * the announcements; treat it as multi-source unless it names one fact.
 */
function questionAsksBroadPreparationQuestion(normalized: string): boolean {
  if (questionHasNarrowFactTarget(normalized)) {
    return false;
  }

  return (
    /\bwhat\s+(?:do|should|would|can)\s+i\s+(?:need\s+to\s+)?(?:know|review|study|read|prepare|look\s+at)\b/i.test(
      normalized
    ) ||
    /\bwhat\s+(?:should|would|can)\s+i\s+(?:review|study|read|look\s+at)\b/i.test(
      normalized
    ) ||
    /\bhow\s+should\s+i\s+(?:prepare|study|review)\b/i.test(normalized) ||
    /\b(?:prep|prepare|study|review)\s+(?:for|before)\b/i.test(normalized)
  );
}

function questionHasNarrowFactTarget(normalized: string): boolean {
  return /\b(?:submit|submission|upload|turn\s+in|hand\s+in|due|deadline|date|time|points?|pts?|marks?|grade|score|percent(?:age)?|worth|late|extensions?|penalt(?:y|ies)|format|file\s+type)\b/i.test(
    normalized
  );
}
