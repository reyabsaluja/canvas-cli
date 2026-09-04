import type {
  CanvasRubricAssessment,
  CanvasRubricCriterion,
  CanvasSubmissionComment,
} from "../canvas/types.js";

/**
 * A piece of rich text (HTML) found somewhere other than a page body or
 * assignment description: rubric criterion and rating details, grader
 * comments on the student's submission, and rubric-assessment comments.
 * Each is labelled so a downloaded file or captured link can say where it
 * came from ("linked in submission feedback by TA Linus").
 */
export interface RichTextSource {
  label: string;
  html: string;
}

/** Rubric criterion descriptions, long descriptions, and rating details. */
export function collectAssignmentRubricHtmlSources(assignment: {
  rubric?: CanvasRubricCriterion[] | null;
}): RichTextSource[] {
  const sources: RichTextSource[] = [];

  for (const criterion of assignment.rubric ?? []) {
    const criterionLabel = normalizeLabel(criterion.description, `criterion ${criterion.id}`);
    addSource(sources, `rubric criterion "${criterionLabel}" description`, criterion.description);
    addSource(sources, `rubric criterion "${criterionLabel}" details`, criterion.long_description);

    for (const rating of criterion.ratings ?? []) {
      const ratingLabel = normalizeLabel(rating.description, "rating");
      addSource(
        sources,
        `rubric rating "${ratingLabel}" in criterion "${criterionLabel}"`,
        rating.long_description
      );
    }
  }

  return sources;
}

/** Grader comment bodies (HTML when Canvas provides it, else the plain text). */
export function collectAssignmentSubmissionCommentHtmlSources(assignment: {
  submission?: {
    submission_comments?: CanvasSubmissionComment[] | null;
  } | null;
}): RichTextSource[] {
  const sources: RichTextSource[] = [];

  for (const comment of assignment.submission?.submission_comments ?? []) {
    const author = normalizeLabel(comment.author_name, "someone");
    const label = `submission feedback by ${author}`;
    addSource(sources, label, comment.html_comment);
    if (comment.html_comment !== comment.comment) {
      addSource(sources, label, comment.comment);
    }
  }

  return sources;
}

/** Per-criterion comments the grader left on the rubric assessment. */
export function collectAssignmentSubmissionRubricAssessmentHtmlSources(assignment: {
  rubric?: CanvasRubricCriterion[] | null;
  submission?: {
    rubric_assessment?: CanvasRubricAssessment | null;
  } | null;
}): RichTextSource[] {
  const sources: RichTextSource[] = [];
  const assessment = assignment.submission?.rubric_assessment;
  if (!assessment || typeof assessment !== "object") {
    return sources;
  }

  const criterionLabelById = new Map<string, string>();
  for (const criterion of assignment.rubric ?? []) {
    criterionLabelById.set(
      String(criterion.id),
      normalizeLabel(criterion.description, `criterion ${criterion.id}`)
    );
  }

  for (const [criterionId, row] of Object.entries(assessment)) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const criterionLabel = criterionLabelById.get(criterionId) ?? `criterion ${criterionId}`;
    addSource(sources, `rubric assessment comment for "${criterionLabel}"`, row.comments);
  }

  return sources;
}

/**
 * Everything the grader wrote about the student's submission: comment bodies
 * and rubric-assessment comments. Used to seed the page crawl, Canvas-file
 * selection, and external-link capture from feedback text.
 */
export function collectAssignmentFeedbackHtmlSources(assignment: {
  rubric?: CanvasRubricCriterion[] | null;
  submission?: {
    submission_comments?: CanvasSubmissionComment[] | null;
    rubric_assessment?: CanvasRubricAssessment | null;
  } | null;
}): RichTextSource[] {
  return [
    ...collectAssignmentSubmissionCommentHtmlSources(assignment),
    ...collectAssignmentSubmissionRubricAssessmentHtmlSources(assignment),
  ];
}

function addSource(
  sources: RichTextSource[],
  label: string,
  html: string | null | undefined
): void {
  if (typeof html !== "string" || html.trim().length === 0) {
    return;
  }
  sources.push({ label, html });
}

function normalizeLabel(value: string | null | undefined, fallback: string): string {
  const normalized = (value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || fallback;
}
