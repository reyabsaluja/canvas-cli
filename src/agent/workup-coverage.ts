export type WorkupCoverageKind =
  | "due_date"
  | "deliverables"
  | "constraints"
  | "overview"
  | "plan"
  | null;

export function workupExplicitlySupportsQuestion(
  question: string,
  workup: Record<string, unknown> | null | undefined
): boolean {
  if (!workup) {
    return false;
  }

  const coverage = classifyWorkupCoverage(question);

  if (coverage === "due_date") {
    return Boolean(getWorkupDueDate(workup));
  }

  if (coverage === "deliverables") {
    return hasNonEmptyStringArray(workup.deliverables);
  }

  if (coverage === "constraints") {
    return hasNonEmptyStringArray(workup.constraints);
  }

  if (coverage === "overview") {
    return typeof workup.overview === "string" && workup.overview.trim().length > 0;
  }

  if (coverage === "plan") {
    return (
      hasNonEmptyStringArray(
        workup.recommendedReadOrder ?? workup.recommended_read_order
      ) ||
      hasNonEmptyArray(workup.actionPlan ?? workup.action_plan)
    );
  }

  return false;
}

export function classifyWorkupCoverage(question: string): WorkupCoverageKind {
  if (isDueDateQuestion(question)) {
    return "due_date";
  }

  if (/\b(deliverable|submit|submission|turn in|hand in)\b/i.test(question)) {
    return "deliverables";
  }

  if (/\b(constraint|restriction|format|rubric|grading|policy|policies)\b/i.test(question)) {
    return "constraints";
  }

  if (/\b(start|first|approach|read order|plan)\b/i.test(question)) {
    return "plan";
  }

  if (/\b(overvi?ew|summary|goal|purpose|expected|what is this assignment about|what is this about)\b/i.test(question)) {
    return "overview";
  }

  return null;
}

export function asksForDirectDocumentReading(question: string): boolean {
  return /\b(exact|quote|quoted|section|document|pdf|file|spec|read|detail|in depth|deep dive|requirement)\b/i.test(
    question
  );
}

function isDueDateQuestion(question: string): boolean {
  return /\b(due|deadline)\b/i.test(question);
}

function getWorkupDueDate(workup: Record<string, unknown>): string | null {
  const dueDate = workup.dueDate ?? workup.due_date;
  return typeof dueDate === "string" && dueDate.trim().length > 0
    ? dueDate
    : null;
}

function hasNonEmptyStringArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((entry) => typeof entry === "string" && entry.trim().length > 0)
  );
}

function hasNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}
