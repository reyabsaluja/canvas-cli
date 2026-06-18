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

function questionMentionsMultipleEvidenceTopics(normalized: string): boolean {
  const hasTopicJoiner =
    /\b(?:and|also|plus|as well as|along with|both|each of)\b/i.test(
      normalized
    ) || /[,;]/.test(normalized);
  if (!hasTopicJoiner) {
    return false;
  }

  const topicPatterns = [
    /\b(?:due|deadline|date|time|when|locks?|unlocks?|available|opens?|closes?)\b/i,
    /\b(?:submit|submission|upload|format|files?|deliverables?|turn\s+in|hand\s+in|pdf|zip)\b/i,
    /\b(?:grading?|rubric|points?|pts?|marks?|score|percent(?:age)?|worth|weight(?:ed)?)\b/i,
    /\b(?:late|extensions?|penalt(?:y|ies)|grace|accommodations?)\b/i,
    /\b(?:requirements?|instructions?|spec(?:ification)?|criteria|steps?|parts?|tasks?|milestones?)\b/i,
    /\b(?:resources?|attachments?|pages?|modules?|lectures?|slides?|videos?)\b/i,
  ];

  let matchedTopicCount = 0;
  for (const pattern of topicPatterns) {
    if (pattern.test(normalized)) {
      matchedTopicCount += 1;
    }
  }

  return matchedTopicCount >= 2;
}

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
