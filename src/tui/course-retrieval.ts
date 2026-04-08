import type { CourseCache } from "../enrich/cache-loader.js";
import {
  loadArtifactIndex,
  readArtifactContent,
  searchArtifacts,
  type ArtifactKind,
} from "../knowledge/artifact-index.js";

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

  const index = await loadArtifactIndex({ cache });
  const results = searchArtifacts(index, trimmed, {
    scope: "course",
    kinds: COURSE_ARTIFACT_KINDS,
    limit: 8,
  });
  if (results.length === 0) {
    return `No course material matched "${query}".`;
  }

  return results
    .map(({ artifact }) => {
      const summary = artifact.excerpt ? ` — ${artifact.excerpt}` : "";
      return `[${artifact.kind}] ${artifact.title}${summary}`;
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

  const index = await loadArtifactIndex({ cache });
  const best = searchArtifacts(index, trimmed, {
    scope: "course",
    kinds: COURSE_READABLE_KINDS,
    limit: 1,
  })[0]?.artifact;
  if (!best) {
    return `Could not find a course document matching "${name}".`;
  }

  if (!best.contentPath) {
    return `Matched ${best.title}, but only metadata is available. Open a workspace or refresh to load richer content.`;
  }

  const text = await readArtifactContent(index, best.id);
  if (!text) {
    return `Matched ${best.title}, but the cached extracted text is missing. Refresh the course cache to rebuild it.`;
  }

  return text.length > 18000 ? text.slice(0, 18000) + "\n[...truncated]" : text;
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
