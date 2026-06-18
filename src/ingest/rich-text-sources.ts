import type {
  CanvasRubricAssessment,
  CanvasRubricCriterion,
  CanvasSubmissionComment,
} from "../canvas/types.js";

export interface AssignmentRubricHtmlSource {
  label: string;
  html: string;
}

export function collectAssignmentRubricHtmlSources(assignment: {
  rubric?: CanvasRubricCriterion[] | null;
}): AssignmentRubricHtmlSource[] {
  const sources: AssignmentRubricHtmlSource[] = [];

  for (const criterion of assignment.rubric ?? []) {
    const criterionLabel = normalizeRubricLabel(
      criterion.description,
      `criterion ${criterion.id}`
    );
    addRubricHtmlSource(
      sources,
      `rubric criterion "${criterionLabel}" description`,
      criterion.description
    );
    addRubricHtmlSource(
      sources,
      `rubric criterion "${criterionLabel}" details`,
      criterion.long_description
    );

    for (const rating of criterion.ratings ?? []) {
      const ratingLabel = normalizeRubricLabel(
        rating.description,
        "rating"
      );
      addRubricHtmlSource(
        sources,
        `rubric rating "${ratingLabel}" in criterion "${criterionLabel}"`,
        rating.long_description
      );
    }
  }

  return sources;
}

export function collectAssignmentSubmissionCommentHtmlSources(assignment: {
  submission?: {
    submission_comments?: CanvasSubmissionComment[] | null;
  } | null;
}): AssignmentRubricHtmlSource[] {
  const sources: AssignmentRubricHtmlSource[] = [];
  const comments = assignment.submission?.submission_comments ?? [];

  for (const comment of comments) {
    const author = normalizeRubricLabel(comment.author_name, "someone");
    const label = `submission feedback by ${author}`;
    addRubricHtmlSource(sources, label, comment.html_comment);
    if (comment.html_comment !== comment.comment) {
      addRubricHtmlSource(sources, label, comment.comment);
    }
  }

  return sources;
}

export function collectAssignmentSubmissionRubricAssessmentHtmlSources(assignment: {
  rubric?: CanvasRubricCriterion[] | null;
  submission?: {
    rubric_assessment?: CanvasRubricAssessment | null;
  } | null;
}): AssignmentRubricHtmlSource[] {
  const sources: AssignmentRubricHtmlSource[] = [];
  const assessment = assignment.submission?.rubric_assessment;
  if (!assessment || typeof assessment !== "object") {
    return sources;
  }

  const criterionLabelById = new Map<string, string>();
  for (const criterion of assignment.rubric ?? []) {
    criterionLabelById.set(
      String(criterion.id),
      normalizeRubricLabel(criterion.description, `criterion ${criterion.id}`)
    );
  }

  for (const [criterionId, row] of Object.entries(assessment)) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const criterionLabel =
      criterionLabelById.get(criterionId) ?? `criterion ${criterionId}`;
    addRubricHtmlSource(
      sources,
      `rubric assessment comment for "${criterionLabel}"`,
      row.comments
    );
  }

  return sources;
}

function addRubricHtmlSource(
  sources: AssignmentRubricHtmlSource[],
  label: string,
  html: string | null | undefined
): void {
  if (typeof html !== "string" || html.trim().length === 0) {
    return;
  }
  sources.push({ label, html });
}

function normalizeRubricLabel(
  value: string | null | undefined,
  fallback: string
): string {
  const normalized = (value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || fallback;
}
