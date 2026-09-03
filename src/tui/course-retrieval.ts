import type { CourseCache } from "../enrich/cache-loader.js";
import {
  buildMatchExcerpt,
  formatArtifactLabel,
  loadArtifactIndex,
  readArtifactContent,
  searchArtifacts,
  searchArtifactSections,
  type ArtifactIndex,
  type ArtifactKind,
  type ArtifactRecord,
  type ArtifactSection,
  type RankedArtifact,
} from "../knowledge/artifact-index.js";

/**
 * The best-matching passage inside a matched course document: which section
 * it came from (a "Page 57" heading, a "Late policy" heading, ...) and an
 * excerpt centred on the query terms rather than the document's first line.
 */
export interface CoursePassage {
  sectionId: string;
  /** Section heading, or null for unlabelled sections (full text / top). */
  section: string | null;
  excerpt: string;
  score: number;
}

export interface CourseArtifactMatch {
  artifact: ArtifactRecord;
  score: number;
  passage: CoursePassage | null;
}

const PASSAGE_EXCERPT_LENGTH = 240;
const GENERIC_SECTION_LABELS = new Set(["full text", "top", "summary", "metadata"]);

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
  const kinds = options?.kinds ?? COURSE_ARTIFACT_KINDS;
  const limit = options?.limit ?? 8;
  // Over-fetch so that dropping Files-tab duplicates below cannot leave the
  // caller with fewer than `limit` distinct documents.
  const results = searchArtifacts(index, trimmed, {
    scope: "course",
    kinds,
    limit: limit * 2,
  });

  const deduped = dropExtractedFileDuplicates(index, results);
  const bestSections = findBestSectionsByArtifact(index, trimmed, kinds);

  return deduped
    .slice(0, limit)
    .map((result) =>
      mapCourseArtifactMatch(result, trimmed, bestSections.get(result.artifact.id))
    );
}

/**
 * A file crawled from the Files tab and also downloaded as an attachment is
 * indexed twice: once as a bare `file` entry (name, type, size) and once as
 * the `attachment` that carries the extracted text. Only the attachment is
 * readable, so when both exist the bare entry is noise that sends the model
 * to download_course_file for a file it can already read_file.
 */
function dropExtractedFileDuplicates(
  index: ArtifactIndex,
  results: RankedArtifact[]
): RankedArtifact[] {
  const extractedFileIds = new Set<number>();
  for (const artifact of index.artifacts) {
    if (artifact.scope !== "course" || artifact.kind !== "attachment") continue;
    if (artifact.metadata.status !== "downloaded") continue;
    const canvasFileId = artifact.metadata.canvasFileId;
    if (typeof canvasFileId === "number") {
      extractedFileIds.add(canvasFileId);
    }
  }
  if (extractedFileIds.size === 0) {
    return results;
  }
  return results.filter((result) => {
    if (result.artifact.kind !== "file") return true;
    const fileId = result.artifact.metadata.fileId;
    return !(typeof fileId === "number" && extractedFileIds.has(fileId));
  });
}

function findBestSectionsByArtifact(
  index: ArtifactIndex,
  query: string,
  kinds: ArtifactKind[]
): Map<string, { section: ArtifactSection; score: number }> {
  const best = new Map<string, { section: ArtifactSection; score: number }>();
  const ranked = searchArtifactSections(index, query, { scope: "course", kinds });
  for (const entry of ranked) {
    if (!best.has(entry.section.artifactId)) {
      best.set(entry.section.artifactId, entry);
    }
  }
  return best;
}

function buildCoursePassage(
  query: string,
  hit: { section: ArtifactSection; score: number } | undefined
): CoursePassage | null {
  if (!hit) return null;
  const label = hit.section.section.trim();
  return {
    sectionId: hit.section.id,
    section:
      label.length > 0 && !GENERIC_SECTION_LABELS.has(label.toLowerCase())
        ? label
        : null,
    excerpt: buildMatchExcerpt(hit.section.text, query, PASSAGE_EXCERPT_LENGTH),
    score: hit.score,
  };
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
        .map((match) => formatCourseArtifactMatchLine(match))
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

/**
 * One search-result line as the model sees it:
 * `[attachment] lecture-notes.pdf — Page 57: ...the MESI protocol keeps...`.
 * Falls back to the document head when no passage matched.
 */
export function formatCourseArtifactMatchLine(
  match: Pick<CourseArtifactMatch, "artifact" | "passage">
): string {
  const label = formatArtifactLabel(match.artifact);
  const passage = match.passage;
  if (passage && passage.excerpt.length > 0) {
    const prefix = passage.section ? `${passage.section}: ` : "";
    return `${label} — ${prefix}${passage.excerpt}`;
  }
  const summary = match.artifact.excerpt ? ` — ${match.artifact.excerpt}` : "";
  return `${label}${summary}`;
}

function mapCourseArtifactMatch(
  result: RankedArtifact,
  query: string,
  bestSection: { section: ArtifactSection; score: number } | undefined
): CourseArtifactMatch {
  return {
    artifact: result.artifact,
    score: result.score,
    passage: buildCoursePassage(query, bestSection),
  };
}

const COURSE_ARTIFACT_KINDS: ArtifactKind[] = [
  "assignment",
  "module",
  "file",
  "page",
  "announcement",
  "discussion",
  "external_link",
  "attachment",
  "syllabus",
  "front_page",
];

const COURSE_READABLE_KINDS: ArtifactKind[] = [
  "assignment",
  "page",
  "announcement",
  "discussion",
  "external_link",
  "attachment",
  "syllabus",
  "front_page",
];
