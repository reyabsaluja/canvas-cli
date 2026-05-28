import type { CourseCache } from "../enrich/cache-loader.js";
import {
  buildQueryMatchedExcerpt,
  formatArtifactLabel,
  formatArtifactSectionLabel,
  loadArtifactIndex,
  readArtifactContent,
  searchArtifacts,
  searchArtifactSections,
  type ArtifactKind,
  type ArtifactRecord,
  type ArtifactSection,
  type RankedArtifact,
} from "../knowledge/artifact-index.js";

export interface CourseArtifactMatch {
  artifact: ArtifactRecord;
  section?: ArtifactSection;
  score: number;
  excerpt: string;
}

export type CourseArtifactSearchResult =
  | {
      status: "ok";
      matches: CourseArtifactMatch[];
    }
  | {
      status: "missing_cache" | "empty_query" | "not_found";
    };

export interface CourseDocumentMatch {
  artifact: ArtifactRecord;
  content: string;
  truncated: boolean;
}

export type CourseDocumentLookupResult =
  | {
      status: "ok";
      document: CourseDocumentMatch;
    }
  | {
      status: "missing_cache" | "empty_query" | "not_found" | "missing_text";
      artifact?: ArtifactRecord;
    };

const COURSE_SEARCH_LOOKAHEAD_MULTIPLIER = 4;
const MIN_COURSE_SEARCH_CANDIDATES = 12;
const SAME_ARTIFACT_SECTION_RATIO = 1.35;
const MAX_HIGH_VALUE_SECTIONS_PER_ARTIFACT = 2;

export async function searchCourseArtifacts(
  cache: CourseCache | null,
  query: string,
  options?: {
    kinds?: ArtifactKind[];
    limit?: number;
  }
): Promise<CourseArtifactMatch[]> {
  if (!cache) {
    return [];
  }

  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const index = await loadArtifactIndex({ cache });
  const limit = options?.limit ?? 8;
  const kinds = options?.kinds ?? COURSE_ARTIFACT_KINDS;
  const sectionResults = searchArtifactSections(index, trimmed, {
    scope: "course",
    kinds,
    limit: Math.max(
      limit * COURSE_SEARCH_LOOKAHEAD_MULTIPLIER,
      MIN_COURSE_SEARCH_CANDIDATES
    ),
  });

  const sectionMatches: CourseArtifactMatch[] = [];
  for (const { section, score } of sectionResults) {
    const artifact = index.artifactsById.get(section.artifactId);
    if (!artifact) continue;
    sectionMatches.push({
      artifact,
      section,
      score,
      excerpt: buildQueryMatchedExcerpt(section.text, trimmed, {
        maxLength: 320,
      }),
    });
  }

  const diverseSectionMatches = selectDiverseCourseMatches(
    sectionMatches,
    limit
  );
  if (diverseSectionMatches.length > 0) {
    return diverseSectionMatches;
  }

  const results = searchArtifacts(index, trimmed, {
    scope: "course",
    kinds,
    limit,
  });

  return results.map((result) => mapCourseArtifactMatch(result, trimmed));
}

export async function searchCourseKnowledge(
  cache: CourseCache | null,
  query: string,
  options?: {
    kinds?: ArtifactKind[];
    limit?: number;
  }
): Promise<CourseArtifactSearchResult> {
  if (!cache) {
    return { status: "missing_cache" };
  }

  const trimmed = query.trim();
  if (!trimmed) {
    return { status: "empty_query" };
  }

  const matches = await searchCourseArtifacts(cache, trimmed, options);
  if (matches.length === 0) {
    return { status: "not_found" };
  }

  return {
    status: "ok",
    matches,
  };
}

export async function readCourseDocument(
  cache: CourseCache | null,
  name: string,
  maxLength: number = 18000
): Promise<CourseDocumentLookupResult> {
  if (!cache) {
    return { status: "missing_cache" };
  }

  const trimmed = name.trim();
  if (!trimmed) {
    return { status: "empty_query" };
  }

  const index = await loadArtifactIndex({ cache });
  const best = searchArtifacts(index, trimmed, {
    scope: "course",
    kinds: COURSE_READABLE_KINDS,
    limit: 1,
  })[0]?.artifact;
  if (!best) {
    return { status: "not_found" };
  }
  if (!best.contentPath) {
    return { status: "missing_text", artifact: best };
  }

  const text = await readArtifactContent(index, best.id);
  if (!text) {
    return { status: "missing_text", artifact: best };
  }

  const truncated = text.length > maxLength;
  return {
    status: "ok",
    document: {
      artifact: best,
      content:
        truncated ? text.slice(0, maxLength) + "\n[...truncated]" : text,
      truncated,
    },
  };
}

export function renderCourseArtifactSearchResult(
  result: CourseArtifactSearchResult,
  query: string
): string {
  switch (result.status) {
    case "missing_cache":
      return "Course cache is not available yet. Open a workspace or refresh the course first.";
    case "empty_query":
      return "Enter a keyword to search the course cache.";
    case "not_found":
      return `No course material matched "${query}".`;
    case "ok":
      return result.matches
        .map((match) => {
          const sectionLabel = formatCourseSectionLabel(match.section);
          const excerpt = match.excerpt;
          const summary = excerpt ? ` — ${excerpt}` : "";
          return `${formatArtifactLabel(match.artifact)}${sectionLabel}${summary}`;
        })
        .join("\n");
    default:
      return `No course material matched "${query}".`;
  }
}

export function renderCourseDocumentLookupResult(
  result: CourseDocumentLookupResult,
  name: string
): string {
  switch (result.status) {
    case "ok":
      return result.document.content;
    case "missing_cache":
      return "Could not read course documents because the course cache is missing.";
    case "empty_query":
      return "Provide a document name or title to read from the course cache.";
    case "missing_text":
      return result.artifact
        ? `Matched ${result.artifact.title}, but the cached extracted text is missing. Refresh the course cache to rebuild it.`
        : `Could not find a course document matching "${name}".`;
    case "not_found":
    default:
      return `Could not find a course document matching "${name}".`;
  }
}

function mapCourseArtifactMatch(
  result: RankedArtifact,
  query: string
): CourseArtifactMatch {
  return {
    artifact: result.artifact,
    score: result.score,
    excerpt: buildQueryMatchedExcerpt(result.artifact.excerpt, query, {
      maxLength: 320,
    }),
  };
}

function selectDiverseCourseMatches(
  matches: CourseArtifactMatch[],
  limit: number
): CourseArtifactMatch[] {
  if (matches.length <= limit) {
    return matches;
  }

  const selected: CourseArtifactMatch[] = [];
  const selectedArtifactIds = new Set<string>();
  const selectedSectionIds = new Set<string>();
  const selectedCountsByArtifactId = new Map<string, number>();

  for (const match of matches) {
    if (selected.length >= limit) {
      return selected;
    }
    const selectedArtifactCount =
      selectedCountsByArtifactId.get(match.artifact.id) ?? 0;
    if (
      selectedArtifactCount > 0 &&
      !shouldSelectAdditionalSection(
        match,
        matches,
        selectedArtifactIds,
        selectedArtifactCount
      )
    ) {
      continue;
    }
    selected.push(match);
    selectedArtifactIds.add(match.artifact.id);
    if (match.section) {
      selectedSectionIds.add(match.section.id);
    }
    selectedCountsByArtifactId.set(
      match.artifact.id,
      selectedArtifactCount + 1
    );
  }

  for (const match of matches) {
    if (selected.length >= limit) {
      break;
    }
    if (match.section && selectedSectionIds.has(match.section.id)) {
      continue;
    }
    selected.push(match);
    if (match.section) {
      selectedSectionIds.add(match.section.id);
    }
  }

  return selected;
}

function shouldSelectAdditionalSection(
  match: CourseArtifactMatch,
  matches: CourseArtifactMatch[],
  selectedArtifactIds: Set<string>,
  selectedArtifactCount: number
): boolean {
  if (!match.section) {
    return false;
  }
  if (selectedArtifactCount >= MAX_HIGH_VALUE_SECTIONS_PER_ARTIFACT) {
    return false;
  }

  const bestUnselectedArtifactScore =
    matches.find((candidate) => !selectedArtifactIds.has(candidate.artifact.id))
      ?.score ?? 0;
  return (
    bestUnselectedArtifactScore === 0 ||
    match.score >= bestUnselectedArtifactScore * SAME_ARTIFACT_SECTION_RATIO
  );
}

function formatCourseSectionLabel(section: ArtifactSection | undefined): string {
  const label = formatArtifactSectionLabel(section);
  if (
    label.length === 0 ||
    label === "Full text" ||
    label === "Top" ||
    label === "Summary" ||
    label === "Metadata"
  ) {
    return "";
  }
  return ` — ${label}`;
}

const COURSE_ARTIFACT_KINDS: ArtifactKind[] = [
  "assignment",
  "module",
  "file",
  "page",
  "quiz",
  "calendar_event",
  "announcement",
  "discussion",
  "external_link",
  "attachment",
  "grading",
  "syllabus",
  "front_page",
];

const COURSE_READABLE_KINDS: ArtifactKind[] = [
  "assignment",
  "page",
  "quiz",
  "calendar_event",
  "announcement",
  "discussion",
  "external_link",
  "attachment",
  "grading",
  "syllabus",
  "front_page",
];
