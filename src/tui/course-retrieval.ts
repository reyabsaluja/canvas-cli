import type { CourseCache } from "../enrich/cache-loader.js";
import {
  formatArtifactLabel,
  loadArtifactIndex,
  readArtifactContent,
  searchArtifacts,
  type ArtifactKind,
  type ArtifactRecord,
  type RankedArtifact,
} from "../knowledge/artifact-index.js";

export interface CourseArtifactMatch {
  artifact: ArtifactRecord;
  score: number;
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
  const results = searchArtifacts(index, trimmed, {
    scope: "course",
    kinds: options?.kinds ?? COURSE_ARTIFACT_KINDS,
    limit: options?.limit ?? 8,
  });

  return results.map(mapCourseArtifactMatch);
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
        .map(({ artifact }) => {
          const summary = artifact.excerpt ? ` — ${artifact.excerpt}` : "";
          return `${formatArtifactLabel(artifact)}${summary}`;
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

function mapCourseArtifactMatch(result: RankedArtifact): CourseArtifactMatch {
  return {
    artifact: result.artifact,
    score: result.score,
  };
}

const COURSE_ARTIFACT_KINDS: ArtifactKind[] = [
  "assignment",
  "module",
  "file",
  "page",
  "announcement",
  "discussion",
  "attachment",
  "syllabus",
  "front_page",
];

const COURSE_READABLE_KINDS: ArtifactKind[] = [
  "assignment",
  "page",
  "announcement",
  "discussion",
  "attachment",
  "syllabus",
  "front_page",
];
