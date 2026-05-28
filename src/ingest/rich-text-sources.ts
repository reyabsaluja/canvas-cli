import type { CanvasRubricCriterion } from "../canvas/types.js";

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
