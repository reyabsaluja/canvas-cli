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

export async function searchCourseIndex(
  cache: CourseCache | null,
  query: string
): Promise<string> {
  if (!cache) {
    return "Course cache is not available yet. Open a workspace or refresh the course first.";
  }

  const trimmed = query.trim();
  if (!trimmed) {
    return "Enter a keyword to search the course cache.";
  }

  const results = await searchCourseArtifacts(cache, trimmed);
  if (results.length === 0) {
    return `No course material matched "${query}".`;
  }

  return results
    .map(({ artifact }) => {
      const summary = artifact.excerpt ? ` — ${artifact.excerpt}` : "";
      return `${formatArtifactLabel(artifact)}${summary}`;
    })
    .join("\n");
}

export async function readCourseDocumentFromIndex(
  cache: CourseCache | null,
  name: string
): Promise<string> {
  if (!cache) {
    return "Could not read course documents because the course cache is missing.";
  }

  const trimmed = name.trim();
  if (!trimmed) {
    return "Provide a document name or title to read from the course cache.";
  }

  const result = await readCourseDocument(cache, trimmed);
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
  "attachment",
  "syllabus",
  "front_page",
];

const COURSE_READABLE_KINDS: ArtifactKind[] = [
  "page",
  "attachment",
  "syllabus",
  "front_page",
];
