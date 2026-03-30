import fs from "node:fs/promises";
import path from "node:path";
import type { CourseCache } from "../enrich/cache-loader.js";
import {
  getExtractedAttachmentPath,
  getExtractedFrontPagePath,
  getExtractedPagePath,
  getExtractedSyllabusPath,
} from "../enrich/course-documents.js";

type RetrievalDocKind =
  | "assignment"
  | "module"
  | "file"
  | "page"
  | "attachment"
  | "syllabus"
  | "front_page";

interface RetrievalDocument {
  id: string;
  kind: RetrievalDocKind;
  title: string;
  location: string;
  titleTokens: string[];
  bodyTokens: string[];
  excerpt: string;
  contentPath?: string;
}

interface CourseRetrievalIndex {
  documents: RetrievalDocument[];
  tokenToDocIds: Map<string, Set<string>>;
  docsById: Map<string, RetrievalDocument>;
}

const indexCache = new Map<string, Promise<CourseRetrievalIndex>>();

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

  const index = await loadCourseRetrievalIndex(cache);
  const results = rankDocuments(index, trimmed);
  if (results.length === 0) {
    return `No course material matched "${query}".`;
  }

  return results
    .slice(0, 8)
    .map(({ doc }) => {
      const summary = doc.excerpt ? ` — ${doc.excerpt}` : "";
      return `[${doc.kind}] ${doc.title}${summary}`;
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

  const index = await loadCourseRetrievalIndex(cache);
  const ranked = rankDocuments(index, trimmed);
  const best = ranked[0]?.doc;
  if (!best) {
    return `Could not find a course document matching "${name}".`;
  }

  if (!best.contentPath) {
    return `Matched ${best.title}, but only metadata is available. Open a workspace or refresh to load richer content.`;
  }

  const text = await readTextSafe(best.contentPath);
  if (!text) {
    return `Matched ${best.title}, but the cached extracted text is missing. Refresh the course cache to rebuild it.`;
  }

  return text.length > 18000 ? text.slice(0, 18000) + "\n[...truncated]" : text;
}

async function loadCourseRetrievalIndex(
  cache: CourseCache
): Promise<CourseRetrievalIndex> {
  const key = `${cache.coursePath}:${cache.ingestion?.ingestedAt ?? "missing"}`;
  let existing = indexCache.get(key);
  if (!existing) {
    existing = buildCourseRetrievalIndex(cache);
    indexCache.set(key, existing);
  }
  return existing;
}

async function buildCourseRetrievalIndex(
  cache: CourseCache
): Promise<CourseRetrievalIndex> {
  const documents: RetrievalDocument[] = [];
  const tokenToDocIds = new Map<string, Set<string>>();
  const docsById = new Map<string, RetrievalDocument>();

  const register = (doc: RetrievalDocument) => {
    documents.push(doc);
    docsById.set(doc.id, doc);
    for (const token of new Set([...doc.titleTokens, ...doc.bodyTokens])) {
      let ids = tokenToDocIds.get(token);
      if (!ids) {
        ids = new Set<string>();
        tokenToDocIds.set(token, ids);
      }
      ids.add(doc.id);
    }
  };

  for (const assignment of cache.assignments) {
    const body = [
      assignment.name,
      assignment.dueAt ?? "no due date",
      assignment.gradingType,
      assignment.submissionTypes.join(" "),
    ].join(" ");
    register(createDocument("assignment", String(assignment.id), assignment.name, "assignment", body));
  }

  for (const module of cache.modules) {
    const body = module.items
      .map((item) => `${item.type} ${item.title}`)
      .join(" ");
    register(createDocument("module", String(module.id), module.name, "module", body));
  }

  for (const file of cache.files) {
    const body = [file.filename, file.contentType, String(file.size)].join(" ");
    register(
      createDocument("file", String(file.id), file.displayName, "file", body)
    );
  }

  const syllabusPath = getExtractedSyllabusPath(cache.coursePath);
  const syllabusText = await readTextSafe(syllabusPath);
  if (syllabusText) {
    register(
      createDocument(
        "syllabus",
        "syllabus-body",
        "Course syllabus",
        "syllabus",
        syllabusText,
        syllabusPath
      )
    );
  }

  const frontPagePath = getExtractedFrontPagePath(cache.coursePath);
  const frontPageText = await readTextSafe(frontPagePath);
  if (frontPageText) {
    register(
      createDocument(
        "front_page",
        "front-page",
        "Course front page",
        "front_page",
        frontPageText,
        frontPagePath
      )
    );
  }

  for (const page of cache.pages) {
    const pagePath = getExtractedPagePath(cache.coursePath, page.pageId);
    const pageText = await readTextSafe(pagePath);
    register(
      createDocument(
        "page",
        page.pageId,
        page.title,
        "page",
        pageText ?? page.pageId,
        pageText ? pagePath : undefined
      )
    );
  }

  for (const attachment of cache.attachments) {
    const extractedPath = getExtractedAttachmentPath(
      cache.coursePath,
      attachment.localPath
    );
    const attachmentText = await readTextSafe(extractedPath);
    register(
      createDocument(
        "attachment",
        `${attachment.localPath}:${attachment.originalFilename}`,
        attachment.originalFilename,
        "attachment",
        attachmentText ?? attachment.reason,
        attachmentText ? extractedPath : undefined
      )
    );
  }

  return { documents, tokenToDocIds, docsById };
}

function createDocument(
  kind: RetrievalDocKind,
  id: string,
  title: string,
  location: string,
  body: string,
  contentPath?: string
): RetrievalDocument {
  const normalizedBody = normalizeText(body);
  return {
    id: `${kind}:${id}`,
    kind,
    title,
    location,
    titleTokens: tokenize(title),
    bodyTokens: tokenize(normalizedBody),
    excerpt: buildExcerpt(normalizedBody),
    contentPath,
  };
}

function rankDocuments(
  index: CourseRetrievalIndex,
  query: string
): Array<{ doc: RetrievalDocument; score: number }> {
  const normalizedQuery = normalizeText(query);
  const queryTokens = tokenize(normalizedQuery);
  if (queryTokens.length === 0) return [];

  const candidateIds = new Set<string>();
  for (const token of queryTokens) {
    for (const id of index.tokenToDocIds.get(token) ?? []) {
      candidateIds.add(id);
    }
  }

  const scored: Array<{ doc: RetrievalDocument; score: number }> = [];
  for (const id of candidateIds) {
    const doc = index.docsById.get(id);
    if (!doc) continue;

    let score = 0;
    const titleNormalized = normalizeText(doc.title);
    if (titleNormalized.includes(normalizedQuery)) {
      score += 25;
    }
    if (doc.excerpt.toLowerCase().includes(normalizedQuery)) {
      score += 10;
    }

    let matchedTokens = 0;
    for (const token of queryTokens) {
      if (doc.titleTokens.includes(token)) {
        score += 8;
        matchedTokens += 1;
      } else if (doc.bodyTokens.includes(token)) {
        score += 3;
        matchedTokens += 1;
      }
    }

    if (matchedTokens === queryTokens.length) {
      score += 12;
    }

    if (score > 0) {
      scored.push({ doc, score });
    }
  }

  return scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.doc.title.localeCompare(b.doc.title);
  });
}

function buildExcerpt(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 140) return cleaned;
  return cleaned.slice(0, 137) + "...";
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
}

async function readTextSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}
