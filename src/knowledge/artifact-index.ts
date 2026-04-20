import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { LoadedWorkspace } from "../ask/types.js";
import type { CourseCache } from "../enrich/cache-loader.js";
import {
  getExtractedAssignmentPath,
  getExtractedAnnouncementPath,
  getExtractedAttachmentPath,
  getExtractedDiscussionPath,
  getExtractedFrontPagePath,
  getExtractedPagePath,
  getExtractedSyllabusPath,
} from "../enrich/course-documents.js";

export type ArtifactScope = "course" | "workspace";

export type ArtifactKind =
  | "assignment"
  | "module"
  | "file"
  | "page"
  | "announcement"
  | "discussion"
  | "attachment"
  | "syllabus"
  | "front_page"
  | "workup"
  | "plan"
  | "notes"
  | "extracted";

export interface ArtifactRecord {
  id: string;
  scope: ArtifactScope;
  kind: ArtifactKind;
  title: string;
  source: string;
  location: string;
  excerpt: string;
  searchText: string;
  titleTokens: string[];
  bodyTokens: string[];
  contentPath?: string;
  metadata: Record<string, unknown>;
  scoreBoost: number;
}

export interface ArtifactSection {
  id: string;
  artifactId: string;
  scope: ArtifactScope;
  kind: ArtifactKind;
  source: string;
  section: string;
  text: string;
  excerpt: string;
  tokens: string[];
  scoreBoost: number;
}

export interface ArtifactIndex {
  key: string;
  courseKey: string | null;
  workspaceKey: string | null;
  artifacts: ArtifactRecord[];
  sections: ArtifactSection[];
  artifactsById: Map<string, ArtifactRecord>;
  sectionsById: Map<string, ArtifactSection>;
}

interface ArtifactIndexInternal extends ArtifactIndex {
  _contentCache: Map<string, string | null>;
  _loaders: Map<string, () => Promise<string | null>>;
}

export interface ArtifactIndexOptions {
  cache?: CourseCache | null;
  workspace?: LoadedWorkspace | null;
}

export interface RankedArtifact {
  artifact: ArtifactRecord;
  score: number;
}

export interface RankedArtifactSection {
  section: ArtifactSection;
  score: number;
}

const artifactIndexCache = new Map<string, Promise<ArtifactIndexInternal>>();

export function formatArtifactLabel(
  artifact: Pick<ArtifactRecord, "kind" | "title">
): string {
  return `[${artifact.kind}] ${artifact.title}`;
}

export async function getCourseArtifactSetKey(
  cache: CourseCache | null
): Promise<string | null> {
  if (!cache) return null;
  const extractedPathSignatures = await Promise.all([
    getFileSignature(getExtractedSyllabusPath(cache.coursePath)),
    getFileSignature(getExtractedFrontPagePath(cache.coursePath)),
    ...cache.assignments.map((assignment) =>
      getFileSignature(
        getExtractedAssignmentPath(cache.coursePath, assignment.id)
      )
    ),
    ...cache.pages.map((page) =>
      getFileSignature(getExtractedPagePath(cache.coursePath, page.pageId))
    ),
    ...(cache.announcements ?? []).map((announcement) =>
      getFileSignature(
        getExtractedAnnouncementPath(cache.coursePath, announcement.id)
      )
    ),
    ...(cache.discussions ?? []).map((discussion) =>
      getFileSignature(
        getExtractedDiscussionPath(cache.coursePath, discussion.id)
      )
    ),
    ...cache.attachments.map((attachment) =>
      getFileSignature(
        getExtractedAttachmentPath(cache.coursePath, attachment.localPath)
      )
    ),
  ]);
  return hashKey(
    "course",
    JSON.stringify({
      coursePath: cache.coursePath,
      courseId: cache.courseId,
      ingestedAt: cache.ingestion?.ingestedAt ?? null,
      assignments: cache.assignments.map((assignment) => ({
        id: assignment.id,
        name: assignment.name,
        dueAt: assignment.dueAt,
        unlockAt: assignment.unlockAt,
        lockAt: assignment.lockAt,
        pointsPossible: assignment.pointsPossible,
        gradingType: assignment.gradingType,
        submissionTypes: assignment.submissionTypes,
        htmlUrl: assignment.htmlUrl,
        hasDescription: assignment.hasDescription,
        descriptionLinkCount: assignment.descriptionLinkCount,
      })),
      modules: cache.modules.map((module) => ({
        id: module.id,
        name: module.name,
        position: module.position,
        itemCount: module.itemCount,
        items: module.items.map((item) => ({
          id: item.id,
          title: item.title,
          type: item.type,
          position: item.position,
          contentId: item.contentId,
          pageUrl: item.pageUrl,
        })),
      })),
      files: cache.files.map((file) => ({
        id: file.id,
        displayName: file.displayName,
        filename: file.filename,
        contentType: file.contentType,
        size: file.size,
        updatedAt: file.updatedAt,
      })),
      pages: cache.pages.map((page) => ({
        pageId: page.pageId,
        title: page.title,
        updatedAt: page.updatedAt,
        hasBody: page.hasBody,
      })),
      announcements: (cache.announcements ?? []).map((announcement) => ({
        id: announcement.id,
        title: announcement.title,
        postedAt: announcement.postedAt,
        htmlUrl: announcement.htmlUrl,
        hasMessage: announcement.hasMessage,
        messageFileLinkCount: announcement.messageFileLinkCount,
      })),
      discussions: (cache.discussions ?? []).map((discussion) => ({
        id: discussion.id,
        title: discussion.title,
        postedAt: discussion.postedAt,
        lastReplyAt: discussion.lastReplyAt,
        htmlUrl: discussion.htmlUrl,
        hasMessage: discussion.hasMessage,
        threadEntryCount: discussion.threadEntryCount,
        participantCount: discussion.participantCount,
        messageFileLinkCount: discussion.messageFileLinkCount,
        replyFileLinkCount: discussion.replyFileLinkCount,
      })),
      attachments: cache.attachments.map((attachment) => ({
        canvasFileId: attachment.canvasFileId,
        originalFilename: attachment.originalFilename,
        localPath: attachment.localPath,
        contentType: attachment.contentType,
        size: attachment.size,
        status: attachment.status,
        sourceType: attachment.sourceType,
        reason: attachment.reason,
      })),
      extractedPathSignatures,
    })
  );
}

export async function getWorkspaceArtifactSetKey(
  workspace: LoadedWorkspace | null
): Promise<string | null> {
  if (!workspace) return null;
  const extractedPathSignatures = await Promise.all(
    workspace.extractedFiles.map((file) =>
      getFileSignature(path.join(workspace.path, file.relativePath))
    )
  );
  return hashKey(
    "workspace",
    JSON.stringify({
      path: workspace.path,
      sessionSlug: workspace.sessionSlug,
      preparedAt: workspace.preparedAt,
      workspaceState: workspace.workspaceState,
      assignmentMd: workspace.assignmentMd,
      planMd: workspace.planMd,
      notesMd: workspace.notesMd,
      workupJson: workspace.workupJson,
      extractedFiles: workspace.extractedFiles.map((file, index) => ({
        name: file.name,
        relativePath: file.relativePath,
        signature: extractedPathSignatures[index] ?? "missing",
      })),
    })
  );
}

export async function getArtifactIndexKey(
  options: ArtifactIndexOptions
): Promise<string> {
  const parts = [
    await getCourseArtifactSetKey(options.cache ?? null),
    await getWorkspaceArtifactSetKey(options.workspace ?? null),
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join("|") : "artifact-index:empty";
}

export async function loadArtifactIndex(
  options: ArtifactIndexOptions
): Promise<ArtifactIndex> {
  const keys = await resolveArtifactIndexKeys(options);
  const key = keys.key;
  let cached = artifactIndexCache.get(key);
  if (!cached) {
    cached = buildArtifactIndexInternal(options, keys).catch((error) => {
      artifactIndexCache.delete(key);
      throw error;
    });
    artifactIndexCache.set(key, cached);
  }
  return cached;
}

export async function buildArtifactIndex(
  options: ArtifactIndexOptions
): Promise<ArtifactIndex> {
  return buildArtifactIndexInternal(options, await resolveArtifactIndexKeys(options));
}

export function clearArtifactIndexCache(key?: string): void {
  if (key) {
    artifactIndexCache.delete(key);
    return;
  }
  artifactIndexCache.clear();
}

export async function readArtifactContent(
  index: ArtifactIndex,
  artifactId: string
): Promise<string | null> {
  const internal = index as ArtifactIndexInternal;
  if (internal._contentCache.has(artifactId)) {
    return internal._contentCache.get(artifactId) ?? null;
  }

  const loader = internal._loaders.get(artifactId);
  if (!loader) {
    return null;
  }

  const content = await loader();
  internal._contentCache.set(artifactId, content);
  return content;
}

export function searchArtifacts(
  index: ArtifactIndex,
  query: string,
  options?: {
    scope?: ArtifactScope;
    kinds?: ArtifactKind[];
    limit?: number;
  }
): RankedArtifact[] {
  const normalizedQuery = normalizeText(query);
  const queryTokens = tokenize(normalizedQuery);
  if (queryTokens.length === 0) return [];

  const allowedKinds = options?.kinds ? new Set(options.kinds) : null;
  const candidates = index.artifacts.filter((artifact) => {
    if (options?.scope && artifact.scope !== options.scope) return false;
    if (allowedKinds && !allowedKinds.has(artifact.kind)) return false;
    return true;
  });

  const scored: RankedArtifact[] = [];
  for (const artifact of candidates) {
    const titleNormalized = normalizeText(artifact.title);
    let score = 0;
    let matchedTokens = 0;

    if (titleNormalized.includes(normalizedQuery)) {
      score += 25;
    }
    if (artifact.searchText.includes(normalizedQuery)) {
      score += 10;
    }

    for (const token of queryTokens) {
      if (artifact.titleTokens.includes(token)) {
        score += 8;
        matchedTokens += 1;
      } else if (artifact.bodyTokens.includes(token)) {
        score += 3;
        matchedTokens += 1;
      }
    }

    if (matchedTokens === queryTokens.length) {
      score += 12;
    }

    score *= artifact.scoreBoost;

    if (score > 0) {
      scored.push({ artifact, score });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.artifact.title.localeCompare(b.artifact.title);
  });

  return scored.slice(0, options?.limit ?? scored.length);
}

export function searchArtifactSections(
  index: ArtifactIndex,
  query: string,
  options?: {
    scope?: ArtifactScope;
    kinds?: ArtifactKind[];
    limit?: number;
  }
): RankedArtifactSection[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const allowedKinds = options?.kinds ? new Set(options.kinds) : null;
  const sections = index.sections.filter((section) => {
    if (options?.scope && section.scope !== options.scope) return false;
    if (allowedKinds && !allowedKinds.has(section.kind)) return false;
    return true;
  });

  const docCount = sections.length;
  const df = new Map<string, number>();
  for (const section of sections) {
    const tokenSet = new Set(section.tokens);
    for (const token of queryTokens) {
      if (tokenSet.has(token)) {
        df.set(token, (df.get(token) ?? 0) + 1);
      }
    }
  }

  const averageLength = Math.max(
    1,
    sections.reduce((sum, section) => sum + section.text.length, 0) /
      Math.max(1, sections.length)
  );

  const scored = sections
    .map((section) => {
      const tokenSet = new Set(section.tokens);
      let score = 0;

      for (const token of queryTokens) {
        if (!tokenSet.has(token)) continue;

        const termFrequency = section.tokens.filter(
          (candidate) => candidate === token
        ).length;
        const documentFrequency = df.get(token) ?? 1;
        const inverseDocumentFrequency = Math.log(
          (docCount + 1) / (documentFrequency + 0.5)
        );
        const normalization =
          1 - 0.75 + 0.75 * (section.text.length / averageLength);
        score +=
          inverseDocumentFrequency *
          ((termFrequency * 2.5) / (termFrequency + 1.5 * normalization));
      }

      score *= section.scoreBoost;
      return { section, score };
    })
    .filter((entry) => entry.score > 0);

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.section.source !== b.section.source) {
      return a.section.source.localeCompare(b.section.source);
    }
    return a.section.section.localeCompare(b.section.section);
  });

  return scored.slice(0, options?.limit ?? scored.length);
}

async function buildArtifactIndexInternal(
  options: ArtifactIndexOptions,
  keys: ResolvedArtifactIndexKeys
): Promise<ArtifactIndexInternal> {
  const artifacts: ArtifactRecord[] = [];
  const sections: ArtifactSection[] = [];
  const artifactsById = new Map<string, ArtifactRecord>();
  const sectionsById = new Map<string, ArtifactSection>();
  const contentCache = new Map<string, string | null>();
  const loaders = new Map<string, () => Promise<string | null>>();

  const registerArtifact = (artifact: ArtifactRecord): void => {
    artifacts.push(artifact);
    artifactsById.set(artifact.id, artifact);
  };

  const registerSection = (section: ArtifactSection): void => {
    sections.push(section);
    sectionsById.set(section.id, section);
  };

  if (options.cache) {
    await addCourseArtifacts(
      options.cache,
      registerArtifact,
      registerSection,
      contentCache,
      loaders
    );
  }

  if (options.workspace) {
    await addWorkspaceArtifacts(
      options.workspace,
      registerArtifact,
      registerSection,
      contentCache,
      loaders
    );
  }

  return {
    key: keys.key,
    courseKey: keys.courseKey,
    workspaceKey: keys.workspaceKey,
    artifacts,
    sections,
    artifactsById,
    sectionsById,
    _contentCache: contentCache,
    _loaders: loaders,
  };
}

interface ResolvedArtifactIndexKeys {
  key: string;
  courseKey: string | null;
  workspaceKey: string | null;
}

async function resolveArtifactIndexKeys(
  options: ArtifactIndexOptions
): Promise<ResolvedArtifactIndexKeys> {
  const [courseKey, workspaceKey] = await Promise.all([
    getCourseArtifactSetKey(options.cache ?? null),
    getWorkspaceArtifactSetKey(options.workspace ?? null),
  ]);
  const parts = [courseKey, workspaceKey].filter(
    (part): part is string => Boolean(part)
  );
  return {
    key: parts.length > 0 ? parts.join("|") : "artifact-index:empty",
    courseKey,
    workspaceKey,
  };
}

async function addCourseArtifacts(
  cache: CourseCache,
  registerArtifact: (artifact: ArtifactRecord) => void,
  registerSection: (section: ArtifactSection) => void,
  contentCache: Map<string, string | null>,
  loaders: Map<string, () => Promise<string | null>>
): Promise<void> {
  for (const assignment of cache.assignments) {
    const assignmentPath = getExtractedAssignmentPath(
      cache.coursePath,
      assignment.id
    );
    const fallbackText = [
      assignment.name,
      assignment.dueAt ?? "no due date",
      assignment.pointsPossible !== null
        ? `${assignment.pointsPossible} points`
        : "points not specified",
      assignment.gradingType,
      assignment.submissionTypes.join(" "),
    ].join(" ");
    await registerCourseTextArtifact(
      {
        id: `course:assignment:${assignment.id}`,
        kind: "assignment",
        title: assignment.name,
        source: assignment.name,
        location: "assignment",
        fallbackText,
        contentPath: assignmentPath,
        scoreBoost: 1.05,
        metadata: {
          assignmentId: assignment.id,
          dueAt: assignment.dueAt,
          pointsPossible: assignment.pointsPossible,
          gradingType: assignment.gradingType,
          submissionTypes: assignment.submissionTypes,
        },
      },
      registerArtifact,
      registerSection,
      contentCache,
      loaders
    );
  }

  for (const module of cache.modules) {
    const body = module.items
      .map((item) => `${item.type} ${item.title}`)
      .join(" ");
    const artifact = createArtifact({
      id: `course:module:${module.id}`,
      scope: "course",
      kind: "module",
      title: module.name,
      source: module.name,
      location: "module",
      body,
      scoreBoost: 1,
      metadata: { moduleId: module.id },
    });
    registerArtifact(artifact);
    registerSection(
      createSectionFromText(artifact, "Metadata", body, artifact.scoreBoost)
    );
  }

  for (const file of cache.files) {
    const body = [file.filename, file.contentType, String(file.size)].join(" ");
    const artifact = createArtifact({
      id: `course:file:${file.id}`,
      scope: "course",
      kind: "file",
      title: file.displayName,
      source: file.displayName,
      location: "file",
      body,
      scoreBoost: 1,
      metadata: { fileId: file.id },
    });
    registerArtifact(artifact);
    registerSection(
      createSectionFromText(artifact, "Metadata", body, artifact.scoreBoost)
    );
  }

  const syllabusPath = getExtractedSyllabusPath(cache.coursePath);
  await registerCourseTextArtifact(
    {
      id: "course:syllabus:body",
      kind: "syllabus",
      title: "Course syllabus",
      source: "Course syllabus",
      location: "syllabus",
      fallbackText: "Course syllabus",
      contentPath: syllabusPath,
      scoreBoost: 1.1,
      metadata: {},
      skipIfMissingContent: true,
    },
    registerArtifact,
    registerSection,
    contentCache,
    loaders
  );

  const frontPagePath = getExtractedFrontPagePath(cache.coursePath);
  await registerCourseTextArtifact(
    {
      id: "course:front_page:home",
      kind: "front_page",
      title: "Course front page",
      source: "Course front page",
      location: "front_page",
      fallbackText: "Course front page",
      contentPath: frontPagePath,
      scoreBoost: 1,
      metadata: {},
      skipIfMissingContent: true,
    },
    registerArtifact,
    registerSection,
    contentCache,
    loaders
  );

  for (const page of cache.pages) {
    const pagePath = getExtractedPagePath(cache.coursePath, page.pageId);
    await registerCourseTextArtifact(
      {
        id: `course:page:${page.pageId}`,
        kind: "page",
        title: page.title,
        source: page.title,
        location: "page",
        fallbackText: page.pageId,
        contentPath: pagePath,
        scoreBoost: 1,
        metadata: { pageId: page.pageId },
      },
      registerArtifact,
      registerSection,
      contentCache,
      loaders
    );
  }

  for (const announcement of cache.announcements ?? []) {
    const announcementPath = getExtractedAnnouncementPath(
      cache.coursePath,
      announcement.id
    );
    await registerCourseTextArtifact(
      {
        id: `course:announcement:${announcement.id}`,
        kind: "announcement",
        title: announcement.title,
        source: announcement.title,
        location: "announcement",
        fallbackText: announcement.title,
        contentPath: announcementPath,
        scoreBoost: 1,
        metadata: {
          announcementId: announcement.id,
          postedAt: announcement.postedAt,
        },
        skipIfMissingContent: true,
      },
      registerArtifact,
      registerSection,
      contentCache,
      loaders
    );
  }

  for (const discussion of cache.discussions ?? []) {
    const discussionPath = getExtractedDiscussionPath(
      cache.coursePath,
      discussion.id
    );
    await registerCourseTextArtifact(
      {
        id: `course:discussion:${discussion.id}`,
        kind: "discussion",
        title: discussion.title,
        source: discussion.title,
        location: "discussion",
        fallbackText: discussion.title,
        contentPath: discussionPath,
        scoreBoost: 1,
        metadata: {
          discussionId: discussion.id,
          postedAt: discussion.postedAt,
          lastReplyAt: discussion.lastReplyAt,
          participantCount: discussion.participantCount,
          threadEntryCount: discussion.threadEntryCount,
        },
        skipIfMissingContent: true,
      },
      registerArtifact,
      registerSection,
      contentCache,
      loaders
    );
  }

  for (const attachment of cache.attachments) {
    const extractedPath = getExtractedAttachmentPath(
      cache.coursePath,
      attachment.localPath
    );
    await registerCourseTextArtifact(
      {
        id: `course:attachment:${attachment.localPath}:${attachment.originalFilename}`,
        kind: "attachment",
        title: attachment.originalFilename,
        source: attachment.originalFilename,
        location: attachment.localPath,
        fallbackText: attachment.reason,
        contentPath: extractedPath,
        scoreBoost: 1.05,
        metadata: {
          localPath: attachment.localPath,
          status: attachment.status,
        },
      },
      registerArtifact,
      registerSection,
      contentCache,
      loaders
    );
  }
}

async function addWorkspaceArtifacts(
  workspace: LoadedWorkspace,
  registerArtifact: (artifact: ArtifactRecord) => void,
  registerSection: (section: ArtifactSection) => void,
  contentCache: Map<string, string | null>,
  loaders: Map<string, () => Promise<string | null>>
): Promise<void> {
  if (workspace.workupJson) {
    const artifact = createArtifact({
      id: "workspace:workup:workup.json",
      scope: "workspace",
      kind: "workup",
      title: "workup.json",
      source: "workup.json",
      location: path.join(workspace.path, "workup.json"),
      body: JSON.stringify(workspace.workupJson, null, 2),
      scoreBoost: 1.2,
      metadata: {},
    });
    registerArtifact(artifact);
    contentCache.set(artifact.id, JSON.stringify(workspace.workupJson, null, 2));
    loaders.set(artifact.id, async () => JSON.stringify(workspace.workupJson, null, 2));

    for (const section of buildWorkupSections(artifact, workspace.workupJson)) {
      registerSection(section);
    }
  }

  registerWorkspaceMarkdownArtifact(
    workspace,
    {
      id: "workspace:assignment:assignment.md",
      kind: "assignment",
      title: "assignment.md",
      source: "assignment.md",
      body: workspace.assignmentMd,
      contentPath: path.join(workspace.path, "assignment.md"),
      scoreBoost: 1,
    },
    registerArtifact,
    registerSection,
    contentCache,
    loaders
  );

  registerWorkspaceMarkdownArtifact(
    workspace,
    {
      id: "workspace:plan:plan.md",
      kind: "plan",
      title: "plan.md",
      source: "plan.md",
      body: workspace.planMd,
      contentPath: path.join(workspace.path, "plan.md"),
      scoreBoost: 1,
    },
    registerArtifact,
    registerSection,
    contentCache,
    loaders
  );

  if (workspace.notesMd && workspace.notesMd.trim().length > 30) {
    registerWorkspaceMarkdownArtifact(
      workspace,
      {
        id: "workspace:notes:notes.md",
        kind: "notes",
        title: "notes.md",
        source: "notes.md",
        body: workspace.notesMd,
        contentPath: path.join(workspace.path, "notes.md"),
        scoreBoost: 0.9,
      },
      registerArtifact,
      registerSection,
      contentCache,
      loaders
    );
  }

  for (const extractedFile of workspace.extractedFiles) {
    const absolutePath = path.join(workspace.path, extractedFile.relativePath);
    const cachedContent =
      workspace.extractedFileCache?.get(extractedFile.name) ?? null;
    const loader = async () =>
      cachedContent ?? (await readTextSafe(absolutePath));
    const content = await loader();
    const artifact = createArtifact({
      id: `workspace:extracted:${extractedFile.name}`,
      scope: "workspace",
      kind: "extracted",
      title: extractedFile.name,
      source: `extracted/${extractedFile.name}`,
      location: absolutePath,
      body: content ?? "",
      contentPath: absolutePath,
      scoreBoost: 1,
      metadata: { relativePath: extractedFile.relativePath },
    });
    registerArtifact(artifact);
    contentCache.set(artifact.id, content);
    loaders.set(artifact.id, loader);

    const text = content ?? "";
    if (text.length === 0) continue;

    if (text.length > 3000) {
      const parts = splitByParagraphs(text, 2500);
      for (let index = 0; index < parts.length; index += 1) {
        registerSection(
          createSectionFromText(
            artifact,
            `Part ${index + 1}`,
            parts[index] ?? "",
            artifact.scoreBoost
          )
        );
      }
    } else {
      registerSection(
        createSectionFromText(artifact, "Full text", text, artifact.scoreBoost)
      );
    }
  }
}

async function registerCourseTextArtifact(
  options: {
    id: string;
    kind: ArtifactKind;
    title: string;
    source: string;
    location: string;
    fallbackText: string;
    contentPath: string;
    scoreBoost: number;
    metadata: Record<string, unknown>;
    skipIfMissingContent?: boolean;
  },
  registerArtifact: (artifact: ArtifactRecord) => void,
  registerSection: (section: ArtifactSection) => void,
  contentCache: Map<string, string | null>,
  loaders: Map<string, () => Promise<string | null>>
): Promise<void> {
  const loader = async () => readTextSafe(options.contentPath);
  const content = await loader();
  if (!content && options.skipIfMissingContent) {
    return;
  }
  const body = content ?? options.fallbackText;
  const artifact = createArtifact({
    id: options.id,
    scope: "course",
    kind: options.kind,
    title: options.title,
    source: options.source,
    location: options.location,
    body,
    contentPath: options.contentPath,
    scoreBoost: options.scoreBoost,
    metadata: options.metadata,
  });

  registerArtifact(artifact);
  contentCache.set(artifact.id, content);
  loaders.set(artifact.id, loader);

  registerSection(
    createSectionFromText(
      artifact,
      content ? "Full text" : "Summary",
      body,
      artifact.scoreBoost
    )
  );
}

function registerWorkspaceMarkdownArtifact(
  workspace: LoadedWorkspace,
  options: {
    id: string;
    kind: ArtifactKind;
    title: string;
    source: string;
    body: string | null;
    contentPath: string;
    scoreBoost: number;
  },
  registerArtifact: (artifact: ArtifactRecord) => void,
  registerSection: (section: ArtifactSection) => void,
  contentCache: Map<string, string | null>,
  loaders: Map<string, () => Promise<string | null>>
): void {
  if (!options.body) return;

  const artifact = createArtifact({
    id: options.id,
    scope: "workspace",
    kind: options.kind,
    title: options.title,
    source: options.source,
    location: options.contentPath,
    body: options.body,
    contentPath: options.contentPath,
    scoreBoost: options.scoreBoost,
    metadata: { workspacePath: workspace.path },
  });

  registerArtifact(artifact);
  contentCache.set(artifact.id, options.body);
  loaders.set(artifact.id, async () => options.body);

  for (const section of splitMarkdownIntoSections(
    artifact,
    options.body,
    artifact.scoreBoost
  )) {
    registerSection(section);
  }
}

function buildWorkupSections(
  artifact: ArtifactRecord,
  workupJson: Record<string, unknown>
): ArtifactSection[] {
  const sections: ArtifactSection[] = [];
  const push = (section: string, text: string): void => {
    if (!text || text.trim().length === 0) return;
    sections.push(createSectionFromText(artifact, section, text, artifact.scoreBoost));
  };

  if (typeof workupJson.overview === "string") {
    push("Overview", workupJson.overview);
  }

  const deliverables = asStringArray(workupJson.deliverables);
  if (deliverables.length > 0) {
    push("Deliverables", deliverables.join("\n"));
  }

  const constraints = asStringArray(workupJson.constraints);
  if (constraints.length > 0) {
    push("Constraints", constraints.join("\n"));
  }

  const readOrder = asStringArray(
    workupJson.recommendedReadOrder ?? workupJson.recommended_read_order
  );
  if (readOrder.length > 0) {
    push("Recommended read order", readOrder.join("\n"));
  }

  const uncertainties = asStringArray(workupJson.uncertainties);
  if (uncertainties.length > 0) {
    push("Uncertainties", uncertainties.join("\n"));
  }

  const actionPlan = asObjectArray(
    workupJson.actionPlan ?? workupJson.action_plan
  );
  if (actionPlan.length > 0) {
    push(
      "Action plan",
      actionPlan
        .map((step, index) => {
          const number =
            typeof step.step === "number" ? step.step : index + 1;
          const action =
            typeof step.action === "string" ? step.action : "";
          const detail =
            typeof step.detail === "string" ? ` — ${step.detail}` : "";
          return `Step ${number}: ${action}${detail}`;
        })
        .join("\n")
    );
  }

  const resources = asObjectArray(
    workupJson.relevantResources ?? workupJson.relevant_resources
  );
  if (resources.length > 0) {
    push(
      "Relevant resources",
      resources
        .map((resource) => {
          const title =
            typeof resource.title === "string" ? resource.title : "";
          const type = typeof resource.type === "string" ? resource.type : "file";
          const why = typeof resource.why === "string" ? resource.why : "";
          return `${title} (${type}) — ${why}`;
        })
        .join("\n")
    );
  }

  const trace = asObjectArray(workupJson.sourceTrace ?? workupJson.source_trace);
  if (trace.length > 0) {
    push(
      "Source trace",
      trace
        .map((entry) => {
          const conclusion =
            typeof entry.conclusion === "string" ? entry.conclusion : "";
          const source = typeof entry.source === "string" ? entry.source : "";
          return `${conclusion} — source: ${source}`;
        })
        .join("\n")
    );
  }

  const dueDate =
    typeof workupJson.dueDate === "string"
      ? workupJson.dueDate
      : typeof workupJson.due_date === "string"
        ? workupJson.due_date
        : null;
  if (dueDate) {
    push("Due date", `Due date: ${dueDate}`);
  }

  return sections;
}

function createArtifact(options: {
  id: string;
  scope: ArtifactScope;
  kind: ArtifactKind;
  title: string;
  source: string;
  location: string;
  body: string;
  contentPath?: string;
  metadata: Record<string, unknown>;
  scoreBoost: number;
}): ArtifactRecord {
  const normalizedBody = normalizeText(options.body);
  return {
    id: options.id,
    scope: options.scope,
    kind: options.kind,
    title: options.title,
    source: options.source,
    location: options.location,
    excerpt: buildExcerpt(options.body),
    searchText: normalizedBody,
    titleTokens: tokenize(options.title),
    bodyTokens: tokenize(normalizedBody),
    contentPath: options.contentPath,
    metadata: options.metadata,
    scoreBoost: options.scoreBoost,
  };
}

function createSectionFromText(
  artifact: ArtifactRecord,
  section: string,
  text: string,
  scoreBoost: number
): ArtifactSection {
  return {
    id: `${artifact.id}#${hashKey("section", `${section}:${text.slice(0, 160)}`)}`,
    artifactId: artifact.id,
    scope: artifact.scope,
    kind: artifact.kind,
    source: artifact.source,
    section,
    text,
    excerpt: buildExcerpt(text),
    tokens: tokenize(`${artifact.title} ${section} ${text}`),
    scoreBoost,
  };
}

function splitMarkdownIntoSections(
  artifact: ArtifactRecord,
  markdown: string,
  scoreBoost: number
): ArtifactSection[] {
  const sections: ArtifactSection[] = [];
  const lines = markdown.split("\n");
  let currentSection = "Top";
  let currentText: string[] = [];

  const flush = () => {
    const text = currentText.join("\n").trim();
    if (text.length > 10) {
      sections.push(
        createSectionFromText(artifact, currentSection, text, scoreBoost)
      );
    }
  };

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch) {
      flush();
      currentSection = headingMatch[1] ?? "Top";
      currentText = [];
      continue;
    }
    currentText.push(line);
  }

  flush();
  return sections;
}

function splitByParagraphs(text: string, maxChunkLength: number): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (
      current.length + paragraph.length > maxChunkLength &&
      current.length > 0
    ) {
      chunks.push(current.trim());
      current = "";
    }
    current += `${paragraph}\n\n`;
  }

  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  return chunks;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function asObjectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null && typeof entry === "object"
      )
    : [];
}

function buildExcerpt(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 140) return cleaned;
  return `${cleaned.slice(0, 137)}...`;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
}

function hashKey(prefix: string, value: string): string {
  return `${prefix}:${createHash("sha1").update(value).digest("hex")}`;
}

async function getFileSignature(filePath: string): Promise<string> {
  try {
    const stat = await fs.stat(filePath);
    return `${filePath}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return `${filePath}:missing`;
  }
}

async function readTextSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}
