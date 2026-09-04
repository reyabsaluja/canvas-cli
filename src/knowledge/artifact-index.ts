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
  getExtractedExternalLinkPath,
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
  | "external_link"
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
    ...(cache.externalLinks ?? []).map((externalLink) =>
      getFileSignature(
        getExtractedExternalLinkPath(cache.coursePath, externalLink.id)
      )
    ),
    ...cache.attachments.map((attachment) =>
      getFileSignature(
        getExtractedAttachmentPath(cache.coursePath, attachment.localPath)
      )
    ),
    ...cache.attachments.flatMap((attachment) =>
      (attachment.zipEntries ?? []).map((entry) =>
        entry.extractedTextPath
          ? getFileSignature(path.join(cache.coursePath, entry.extractedTextPath))
          : Promise.resolve(`${entry.localPath}:no-extract`)
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
      externalLinks: (cache.externalLinks ?? []).map((externalLink) => ({
        id: externalLink.id,
        title: externalLink.title,
        url: externalLink.url,
        resolvedUrl: externalLink.resolvedUrl,
        sourceCount: externalLink.sourceCount,
        contentType: externalLink.contentType,
        contentStatus: externalLink.contentStatus,
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
        zipEntries: (attachment.zipEntries ?? []).map((entry) => ({
          entryName: entry.entryName,
          filename: entry.filename,
          localPath: entry.localPath,
          extractedTextPath: entry.extractedTextPath,
          size: entry.size,
        })),
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
  const { tokens: queryTokens, phrases, expansions } = analyzeSearchQuery(query);
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

    if (phrases.some((phrase) => titleNormalized.includes(phrase))) {
      score += 25;
    }
    if (phrases.some((phrase) => artifact.searchText.includes(phrase))) {
      score += 10;
    }

    for (const token of queryTokens) {
      if (artifact.titleTokens.includes(token)) {
        score += 8;
        matchedTokens += 1;
      } else if (artifact.bodyTokens.includes(token)) {
        score += 3;
        matchedTokens += 1;
      } else {
        const synonyms = expansions.get(token) ?? [];
        if (synonyms.some((synonym) => artifact.titleTokens.includes(synonym))) {
          score += 8 * SYNONYM_MATCH_WEIGHT;
          matchedTokens += 1;
        } else if (synonyms.some((synonym) => artifact.bodyTokens.includes(synonym))) {
          score += 3 * SYNONYM_MATCH_WEIGHT;
          matchedTokens += 1;
        }
      }
    }

    if (matchedTokens === queryTokens.length) {
      score += 12;
    }

    score *= artifact.scoreBoost * recencyMultiplier(artifact);

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
  const { tokens: queryTokens, phrases, expansions } = analyzeSearchQuery(query);
  if (queryTokens.length === 0) return [];
  const scoringTokens = [
    ...queryTokens,
    ...[...expansions.values()].flat(),
  ];

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
    for (const token of scoringTokens) {
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
      const sectionLabel = normalizeText(section.section);
      const sectionLabelTokens = tokenize(section.section);
      const sourceLabel = normalizeText(section.source);
      const sourceLabelTokens = tokenize(section.source);
      const hasSpecificSectionLabel = isSpecificSectionLabel(section.section);
      let score = 0;
      let matchedSectionLabelTokens = 0;
      let matchedSourceLabelTokens = 0;

      if (
        hasSpecificSectionLabel &&
        phrases.some((phrase) => sectionLabel.includes(phrase))
      ) {
        score += 14;
      }
      if (phrases.some((phrase) => sourceLabel.includes(phrase))) {
        score += 6;
      }

      const bm25 = (token: string): number => {
        const termFrequency = section.tokens.filter(
          (candidate) => candidate === token
        ).length;
        const documentFrequency = df.get(token) ?? 1;
        const inverseDocumentFrequency = Math.log(
          (docCount + 1) / (documentFrequency + 0.5)
        );
        const normalization =
          1 - 0.75 + 0.75 * (section.text.length / averageLength);
        return (
          inverseDocumentFrequency *
          ((termFrequency * 2.5) / (termFrequency + 1.5 * normalization))
        );
      };

      for (const token of queryTokens) {
        const synonyms = expansions.get(token) ?? [];
        const labelHit = hasSpecificSectionLabel && sectionLabelTokens.includes(token);
        const labelSynonymHit =
          !labelHit &&
          hasSpecificSectionLabel &&
          synonyms.some((synonym) => sectionLabelTokens.includes(synonym));
        if (labelHit) {
          score += 4;
          matchedSectionLabelTokens += 1;
        } else if (labelSynonymHit) {
          score += 4 * SYNONYM_MATCH_WEIGHT;
          matchedSectionLabelTokens += 1;
        }
        if (sourceLabelTokens.includes(token)) {
          score += 2;
          matchedSourceLabelTokens += 1;
        } else if (synonyms.some((synonym) => sourceLabelTokens.includes(synonym))) {
          score += 2 * SYNONYM_MATCH_WEIGHT;
          matchedSourceLabelTokens += 1;
        }

        if (tokenSet.has(token)) {
          score += bm25(token);
          continue;
        }
        // No direct hit: the best synonym counts as a weaker match.
        let bestSynonym = 0;
        for (const synonym of synonyms) {
          if (tokenSet.has(synonym)) {
            bestSynonym = Math.max(bestSynonym, bm25(synonym));
          }
        }
        score += bestSynonym * SYNONYM_MATCH_WEIGHT;
      }

      if (
        hasSpecificSectionLabel &&
        matchedSectionLabelTokens === queryTokens.length
      ) {
        score += 8;
      }
      if (matchedSourceLabelTokens === queryTokens.length) {
        score += 4;
      }

      score *=
        section.scoreBoost *
        recencyMultiplier(index.artifactsById.get(section.artifactId));
      return { section, score };
    })
    .filter((entry) => entry.score > 0);

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.section.text.length !== b.section.text.length) {
      return a.section.text.length - b.section.text.length;
    }
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

  const moduleNamesById = new Map(cache.modules.map((module) => [module.id, module.name]));
  for (const module of cache.modules) {
    const body = [
      module.items.map((item) => `${item.type} ${item.title}`).join(" "),
      describeModuleRequirements(module, moduleNamesById),
    ]
      .filter(Boolean)
      .join("\n");
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

  for (const externalLink of cache.externalLinks ?? []) {
    const externalLinkPath = getExtractedExternalLinkPath(
      cache.coursePath,
      externalLink.id
    );
    await registerCourseTextArtifact(
      {
        id: `course:external_link:${externalLink.id}`,
        kind: "external_link",
        title: externalLink.title,
        source: externalLink.title,
        location: externalLink.resolvedUrl ?? externalLink.url,
        fallbackText: [
          externalLink.url,
          externalLink.resolvedUrl ?? "",
          ...externalLink.sources,
        ]
          .filter((value) => value.length > 0)
          .join(" "),
        contentPath: externalLinkPath,
        scoreBoost: 1.02,
        metadata: {
          url: externalLink.url,
          resolvedUrl: externalLink.resolvedUrl,
          sourceCount: externalLink.sourceCount,
          contentStatus: externalLink.contentStatus,
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
          canvasFileId: attachment.canvasFileId,
        },
      },
      registerArtifact,
      registerSection,
      contentCache,
      loaders
    );

    for (const zipEntry of attachment.zipEntries ?? []) {
      if (!zipEntry.extractedTextPath) {
        continue;
      }
      const entryContentPath = path.join(
        cache.coursePath,
        zipEntry.extractedTextPath
      );
      await registerCourseTextArtifact(
        {
          id: `course:attachment:${attachment.localPath}:zip:${zipEntry.entryName}`,
          kind: "attachment",
          title: zipEntry.filename,
          source: zipEntry.filename,
          location: zipEntry.localPath,
          fallbackText: `Inside ${attachment.originalFilename}: ${zipEntry.entryName}`,
          contentPath: entryContentPath,
          scoreBoost: 1.05,
          metadata: {
            localPath: zipEntry.localPath,
            status: attachment.status,
            zipParent: attachment.localPath,
            zipEntryName: zipEntry.entryName,
          },
          skipIfMissingContent: true,
        },
        registerArtifact,
        registerSection,
        contentCache,
        loaders
      );
    }
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

    // Extracted documents carry markdown headings from extraction ("## Page 12",
    // DOCX/PPTX headings, "## Deadlines"); split on them exactly like course
    // documents so each heading is a searchable, citable section. Long
    // heading-less text still falls back to paragraph parts.
    const headingSections = buildCourseTextSections(
      artifact,
      text,
      "Full text",
      artifact.scoreBoost
    );
    if (headingSections.length > 1 || text.length <= 3000) {
      for (const section of headingSections) {
        registerSection(section);
      }
      continue;
    }

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

  for (const section of buildCourseTextSections(
    artifact,
    body,
    content ? "Full text" : "Summary",
    artifact.scoreBoost
  )) {
    registerSection(section);
  }
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
    const headingMatch = line.match(/^#{1,4}\s+(.+)/);
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

function buildCourseTextSections(
  artifact: ArtifactRecord,
  text: string,
  fallbackSection: string,
  scoreBoost: number
): ArtifactSection[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const markdownSections = splitMarkdownIntoSections(artifact, trimmed, scoreBoost);
  if (markdownSections.length > 1) {
    return expandLongSections(
      normalizeRedundantCourseSectionLabels(
        artifact,
        markdownSections,
        fallbackSection,
        scoreBoost
      ),
      scoreBoost
    );
  }

  if (markdownSections.length === 1) {
    const [onlySection] = normalizeRedundantCourseSectionLabels(
      artifact,
      markdownSections,
      fallbackSection,
      scoreBoost
    );
    if (onlySection && onlySection.section !== "Top") {
      return expandLongSections([onlySection], scoreBoost);
    }
  }

  if (trimmed.length > 3000) {
    return splitByParagraphs(trimmed, 2500).map((part, index) =>
      createSectionFromText(
        artifact,
        index === 0 ? fallbackSection : `${fallbackSection} (Part ${index + 1})`,
        part,
        scoreBoost
      )
    );
  }

  return [createSectionFromText(artifact, fallbackSection, trimmed, scoreBoost)];
}

function normalizeRedundantCourseSectionLabels(
  artifact: ArtifactRecord,
  sections: ArtifactSection[],
  fallbackSection: string,
  scoreBoost: number
): ArtifactSection[] {
  const normalizedTitle = normalizeText(artifact.title);
  return sections.map((section) => {
    if (normalizeText(section.section) !== normalizedTitle) {
      return section;
    }
    return createSectionFromText(
      artifact,
      fallbackSection,
      section.text,
      scoreBoost
    );
  });
}

function expandLongSections(
  sections: ArtifactSection[],
  scoreBoost: number
): ArtifactSection[] {
  const expanded: ArtifactSection[] = [];

  for (const section of sections) {
    if (section.text.length <= 3000) {
      expanded.push(section);
      continue;
    }

    const parts = splitByParagraphs(section.text, 2500);
    if (parts.length <= 1) {
      expanded.push(section);
      continue;
    }

    for (let index = 0; index < parts.length; index += 1) {
      expanded.push(
        createSectionFromText(
          {
            ...sectionToArtifact(section),
            scoreBoost,
          },
          `${section.section} (Part ${index + 1})`,
          parts[index] ?? "",
          scoreBoost
        )
      );
    }
  }

  return expanded;
}

function sectionToArtifact(section: ArtifactSection): ArtifactRecord {
  return {
    id: section.artifactId,
    scope: section.scope,
    kind: section.kind,
    title: section.source,
    source: section.source,
    location: section.source,
    excerpt: section.excerpt,
    searchText: normalizeText(section.text),
    titleTokens: tokenize(section.source),
    bodyTokens: section.tokens,
    metadata: {},
    scoreBoost: section.scoreBoost,
  };
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

interface MatchExcerptHit {
  start: number;
  end: number;
  token: string;
}

/**
 * Excerpt of `text` centred on the passage that matches `query` best: the
 * window of `maxLength` characters covering the most distinct query terms
 * (ties broken by total hits, then by earliest position). Falls back to the
 * head of the text when no query term occurs. Whitespace is collapsed and
 * the window is snapped to word boundaries, with "..." marking cut edges.
 */
export function buildMatchExcerpt(
  text: string,
  query: string,
  maxLength: number = 240
): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;

  const queryTokens = new Set(analyzeSearchQuery(query).tokens);
  const hits: MatchExcerptHit[] = [];
  if (queryTokens.size > 0) {
    const lowered = cleaned.toLowerCase();
    const wordPattern = /[a-z0-9]+/g;
    let match: RegExpExecArray | null;
    while ((match = wordPattern.exec(lowered)) !== null) {
      const word = match[0];
      if (word.length < 2) continue;
      const stem = stemSearchToken(word);
      if (queryTokens.has(stem)) {
        hits.push({ start: match.index, end: match.index + word.length, token: stem });
      }
    }
  }

  if (hits.length === 0) {
    return `${trimToWordBoundary(cleaned.slice(0, maxLength - 3), "end")}...`;
  }

  let best = { distinct: 0, count: 0, first: 0, last: 0 };
  for (let anchor = 0; anchor < hits.length; anchor += 1) {
    const windowStart = hits[anchor]!.start;
    const seen = new Set<string>();
    let count = 0;
    let lastEnd = hits[anchor]!.end;
    for (let index = anchor; index < hits.length; index += 1) {
      const hit = hits[index]!;
      if (hit.end - windowStart > maxLength) break;
      seen.add(hit.token);
      count += 1;
      lastEnd = hit.end;
    }
    if (
      seen.size > best.distinct ||
      (seen.size === best.distinct && count > best.count)
    ) {
      best = { distinct: seen.size, count, first: windowStart, last: lastEnd };
    }
  }

  const clusterLength = best.last - best.first;
  // The answer usually follows its keyword ("Late policy: 10% per day"), so
  // give the window more room after the cluster than before it.
  const spare = Math.max(0, maxLength - clusterLength);
  const padding = Math.floor(spare * 0.3);
  let start = Math.max(0, best.first - padding);
  let end = Math.min(cleaned.length, start + maxLength);
  // Always keep some text after the last keyword hit, even when the cluster
  // itself fills the window: that is where "Late policy: 10% per day" lives.
  const tailRoom = Math.min(240, Math.floor(maxLength * 0.25));
  const wantedEnd = Math.min(cleaned.length, best.last + tailRoom);
  if (wantedEnd > end) {
    end = wantedEnd;
    start = Math.max(0, end - maxLength);
  }
  if (end - start < maxLength) {
    start = Math.max(0, end - maxLength);
  }

  const prefix = start > 0 ? "..." : "";
  const suffix = end < cleaned.length ? "..." : "";
  let window = cleaned.slice(start, end);
  if (prefix) window = trimToWordBoundary(window, "start");
  if (suffix) window = trimToWordBoundary(window, "end");
  return `${prefix}${window.trim()}${suffix}`;
}

function trimToWordBoundary(value: string, edge: "start" | "end"): string {
  if (edge === "start") {
    const firstSpace = value.indexOf(" ");
    return firstSpace > 0 && firstSpace < 24 ? value.slice(firstSpace + 1) : value;
  }
  const lastSpace = value.lastIndexOf(" ");
  return lastSpace > 0 && value.length - lastSpace < 24
    ? value.slice(0, lastSpace)
    : value;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function isSpecificSectionLabel(value: string): boolean {
  const normalized = normalizeText(value);
  return normalized.length > 0 && normalized !== "full text" && normalized !== "top";
}

/**
 * Words that carry no retrieval signal on their own: articles, pronouns,
 * auxiliaries, and the scaffolding of a natural-language question
 * ("what should I ...", "explain ...", "tell me about ..."). They are dropped
 * from queries only; indexed text keeps every token so exact-phrase and label
 * matching still work.
 */
const QUERY_STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "so", "of", "to", "in",
  "on", "at", "by", "for", "from", "with", "without", "about", "into", "onto",
  "over", "under", "as", "is", "are", "was", "were", "be", "been", "being",
  "am", "do", "does", "did", "done", "have", "has", "had", "having", "can",
  "could", "should", "would", "will", "shall", "may", "might", "must", "not",
  "no", "nor", "it", "its", "this", "that", "these", "those", "there", "here",
  "i", "me", "my", "mine", "we", "us", "our", "ours", "you", "your", "yours",
  "he", "she", "they", "them", "their", "his", "her", "him", "who", "whom",
  "whose", "what", "which", "when", "where", "why", "how", "any", "some",
  "all", "each", "every", "either", "neither", "both", "few", "more", "most",
  "much", "many", "such", "than", "too", "very", "just", "also", "only",
  "ever", "never", "always", "again", "further", "once", "own", "same",
  "other", "another", "please", "tell", "explain", "describe", "say", "says",
  "said", "give", "show", "need", "needs", "want", "wants", "know", "knows",
  "mean", "means", "still", "yet", "already", "like", "get", "got", "let",
  "lets", "vs", "versus", "regarding", "something", "anything", "everything",
  "thing", "things", "well", "really", "actually", "exactly", "sure",
]);

interface SearchQueryAnalysis {
  /** Stemmed content tokens used for token/TF-IDF matching. */
  tokens: string[];
  /**
   * Course-vocabulary synonyms per query token (stemmed): "due" → ["deadline"],
   * "rubric" → ["grading", "marking", ...]. A synonym hit counts as a weaker
   * match so "when is it due" still finds the "Deadline" section.
   */
  expansions: Map<string, string[]>;
  /**
   * Phrases to try for substring matches against titles, labels, and bodies:
   * the raw normalized query first, then the query with scaffolding words
   * removed ("what is the late policy" -> "late policy").
   */
  phrases: string[];
}

export function analyzeSearchQuery(query: string): SearchQueryAnalysis {
  const normalizedQuery = normalizeText(query);
  const rawWords = normalizedQuery
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
  const contentWords = rawWords.filter((word) => !QUERY_STOP_WORDS.has(word));
  const contentPhrase = contentWords.join(" ");

  const contentTokens = contentWords
    .filter((word) => word.length >= 2)
    .map(stemSearchToken);
  // A query made only of scaffolding ("what is it?") still needs to match
  // something, so fall back to the full token list in that case.
  const tokens = contentTokens.length > 0 ? contentTokens : tokenize(normalizedQuery);

  const phrases = [normalizedQuery, contentPhrase].filter(
    (phrase, position, list) =>
      phrase.length > 0 && list.indexOf(phrase) === position
  );

  const expansions = new Map<string, string[]>();
  for (const token of tokens) {
    const synonyms = QUERY_SYNONYMS.get(token);
    if (synonyms) {
      expansions.set(token, synonyms.filter((synonym) => !tokens.includes(synonym)));
    }
  }

  return { tokens, phrases, expansions };
}

/**
 * Posts age: when two announcements or threads match equally, the newer one
 * is almost always the one the student means ("did the prof say anything
 * about the extension?"). Up to +20% for a post from today, fading to
 * nothing at 90 days. Other artifact kinds are unaffected.
 */
const RECENCY_MAX_BOOST = 0.2;
const RECENCY_HORIZON_DAYS = 90;
const RECENCY_KINDS = new Set<ArtifactKind>(["announcement", "discussion"]);

export function recencyMultiplier(
  artifact: Pick<ArtifactRecord, "kind" | "metadata"> | undefined,
  now: number = Date.now()
): number {
  if (!artifact || !RECENCY_KINDS.has(artifact.kind)) return 1;
  const stamp = artifact.metadata.lastReplyAt ?? artifact.metadata.postedAt;
  if (typeof stamp !== "string") return 1;
  const posted = Date.parse(stamp);
  if (!Number.isFinite(posted)) return 1;
  const ageDays = Math.max(0, (now - posted) / 86_400_000);
  if (ageDays >= RECENCY_HORIZON_DAYS) return 1;
  return 1 + RECENCY_MAX_BOOST * (1 - ageDays / RECENCY_HORIZON_DAYS);
}

const COMPLETION_REQUIREMENT_LABELS: Record<string, string> = {
  must_view: "view",
  must_submit: "submit",
  must_contribute: "post a contribution to",
  must_mark_done: "mark as done",
  min_score: "score at least",
};

/**
 * "Requirements: unlocks after Week 1: Getting Started; items must be done in
 * order; to complete: submit Lab 1, score at least 8 on Quiz 1." Answers
 * "what do I need to do to unlock module 3". Exported for tests.
 */
export function describeModuleRequirements(
  module: {
    unlockAt?: string | null;
    requireSequentialProgress?: boolean;
    prerequisiteModuleIds?: number[];
    items: Array<{ title: string; completionRequirement?: { type: string; minScore: number | null } | null }>;
  },
  moduleNamesById: Map<number, string>
): string {
  const parts: string[] = [];
  const prerequisites = (module.prerequisiteModuleIds ?? [])
    .map((id) => moduleNamesById.get(id) ?? `module ${id}`);
  if (prerequisites.length > 0) {
    parts.push(`unlocks after completing ${prerequisites.join(" and ")}`);
  }
  if (module.unlockAt) {
    parts.push(`opens on ${module.unlockAt}`);
  }
  if (module.requireSequentialProgress) {
    parts.push("items must be completed in order");
  }
  const completions = module.items
    .filter((item) => item.completionRequirement)
    .map((item) => {
      const requirement = item.completionRequirement!;
      const verb = COMPLETION_REQUIREMENT_LABELS[requirement.type] ?? requirement.type.replace(/_/g, " ");
      const score = requirement.type === "min_score" && requirement.minScore !== null ? ` ${requirement.minScore} on` : "";
      return `${verb}${score} ${item.title}`;
    });
  if (completions.length > 0) {
    parts.push(`to complete this module: ${completions.join(", ")}`);
  }
  return parts.length > 0 ? `Requirements: ${parts.join("; ")}.` : "";
}

/** Weight of a match through a synonym relative to a direct token match. */
export const SYNONYM_MATCH_WEIGHT = 0.6;

/**
 * Words students and instructors use interchangeably. Each group maps every
 * member to the others (after stemming). Kept deliberately narrow: only
 * course-logistics vocabulary where a miss is common and costly.
 */
const SYNONYM_GROUPS: string[][] = [
  ["due", "deadline", "deadlines"],
  ["rubric", "grading", "marking", "criteria", "breakdown"],
  ["late", "penalty", "penalties", "extension", "extensions"],
  ["submit", "submission", "submissions", "upload", "handin"],
  ["exam", "midterm", "final", "test"],
  ["quiz", "quizzes", "test"],
  ["lecture", "lectures", "slides", "deck", "recording", "recordings"],
  ["lab", "labs", "practical", "practicals"],
  ["assignment", "assignments", "homework", "hw", "pset", "problemset"],
  ["syllabus", "outline"],
  ["textbook", "reading", "readings", "chapter"],
  ["grade", "grades", "mark", "marks", "score", "weight", "weighting"],
  ["policy", "policies", "rules"],
  ["tutorial", "tutorials", "section", "recitation"],
  ["office", "officehours"],
  ["group", "team", "partner", "partners"],
  ["plagiarism", "integrity", "collaboration"],
];

const QUERY_SYNONYMS: Map<string, string[]> = (() => {
  const map = new Map<string, Set<string>>();
  for (const group of SYNONYM_GROUPS) {
    const stemmed = [...new Set(group.map((word) => stemSearchToken(word)))];
    for (const word of stemmed) {
      const set = map.get(word) ?? new Set<string>();
      for (const other of stemmed) {
        if (other !== word) set.add(other);
      }
      map.set(word, set);
    }
  }
  return new Map([...map.entries()].map(([word, set]) => [word, [...set]]));
})();

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2)
    .map(stemSearchToken);
}

/**
 * Conservative English stemmer so plural and inflected forms match their base
 * form ("hazards"/"hazard", "graded"/"grading"/"grade", "policies"/"policy").
 * It is applied identically to indexed text and queries, so the only
 * requirement is consistency rather than linguistic accuracy. Tokens with
 * digits (lab4, 2026) are left untouched.
 */
export function stemSearchToken(token: string): string {
  if (token.length < 4 || /\d/.test(token)) {
    return token;
  }

  let stem = token;

  if (stem.endsWith("ies") && stem.length > 4) {
    stem = `${stem.slice(0, -3)}y`;
  } else if (stem.endsWith("sses")) {
    stem = stem.slice(0, -2);
  } else if (
    stem.endsWith("ss") ||
    stem.endsWith("us") ||
    stem.endsWith("is")
  ) {
    // class, syllabus, analysis: not plurals.
  } else if (stem.endsWith("es") && /(?:[sxz]|[cs]h)es$/.test(stem)) {
    stem = stem.slice(0, -2);
  } else if (stem.endsWith("s")) {
    stem = stem.slice(0, -1);
  }

  if (stem.endsWith("ing") && stem.length - 3 >= 4) {
    stem = undoubleFinalConsonant(stem.slice(0, -3));
  } else if (stem.endsWith("ed") && stem.length - 2 >= 4) {
    stem = undoubleFinalConsonant(stem.slice(0, -2));
  } else if (stem.endsWith("ly") && stem.length - 2 >= 4) {
    stem = stem.slice(0, -2);
  }

  if (stem.endsWith("e") && stem.length >= 5) {
    stem = stem.slice(0, -1);
  }

  return stem;
}

function undoubleFinalConsonant(value: string): string {
  const last = value.at(-1);
  const previous = value.at(-2);
  if (
    last &&
    last === previous &&
    !/[aeiouls]/.test(last)
  ) {
    return value.slice(0, -1);
  }
  return value;
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
