import fs from "node:fs/promises";
import path from "node:path";
import type { LoadedWorkspace } from "../ask/types.js";
import type { CourseCache } from "../enrich/cache-loader.js";
import {
  clearArtifactIndexCache,
  formatArtifactLabel,
  loadArtifactIndex,
  readArtifactContent,
  searchArtifacts,
  searchArtifactSections,
  type ArtifactIndex,
  type ArtifactKind,
  type ArtifactRecord,
  type ArtifactSection,
  type ArtifactScope,
} from "../knowledge/artifact-index.js";

export interface WorkspaceChatSearchMatch {
  artifact: ArtifactRecord;
  section: ArtifactSection;
  score: number;
  header: string;
  preview: string;
}

export interface WorkspaceChatFileEntry {
  artifactId: string;
  scope: ArtifactScope;
  kind: ArtifactKind;
  label: string;
  hint: string | null;
}

export interface WorkspaceChatFileList {
  workspaceFiles: WorkspaceChatFileEntry[];
  extractedDocuments: WorkspaceChatFileEntry[];
  courseDocuments: WorkspaceChatFileEntry[];
}

export type WorkspaceChatReadResult =
  | {
      status: "ok";
      artifact: ArtifactRecord;
      content: string;
      truncated: boolean;
    }
  | {
      status: "empty_query" | "not_found" | "missing_text";
      artifact?: ArtifactRecord;
    };

interface ArtifactLookupCandidate {
  artifact: ArtifactRecord;
  score: number;
}

const WORKSPACE_READABLE_KINDS: ArtifactKind[] = [
  "assignment",
  "plan",
  "notes",
  "workup",
  "extracted",
];

const COURSE_READABLE_KINDS: ArtifactKind[] = [
  "page",
  "attachment",
  "syllabus",
  "front_page",
];

const CHAT_READABLE_KINDS: ArtifactKind[] = [
  ...WORKSPACE_READABLE_KINDS,
  ...COURSE_READABLE_KINDS,
];

export async function searchWorkspaceKnowledge(
  workspace: LoadedWorkspace,
  cache: CourseCache | null,
  query: string,
  limit: number = 5
): Promise<WorkspaceChatSearchMatch[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const index = await loadArtifactIndex({ workspace, cache });
  const ranked = searchArtifactSections(index, trimmed, {
    scope: "workspace",
    limit,
  });

  return ranked
    .map(({ section, score }) => {
      const artifact = index.artifactsById.get(section.artifactId);
      if (!artifact) return null;
      return {
        artifact,
        section,
        score,
        header: buildSearchHeader(artifact, section),
        preview: section.text.slice(0, 2000),
      };
    })
    .filter((match): match is WorkspaceChatSearchMatch => Boolean(match));
}

export async function readWorkspaceKnowledgeArtifact(
  workspace: LoadedWorkspace,
  cache: CourseCache | null,
  query: string,
  maxLength: number
): Promise<WorkspaceChatReadResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { status: "empty_query" };
  }

  const index = await loadArtifactIndex({ workspace, cache });
  const artifact = findReadableArtifact(index, trimmed);
  if (!artifact) {
    return { status: "not_found" };
  }

  const content = await readArtifactContent(index, artifact.id);
  if (!content) {
    return { status: "missing_text", artifact };
  }

  const truncated = content.length > maxLength;
  return {
    status: "ok",
    artifact,
    content: truncated ? content.slice(0, maxLength) + "\n[...truncated]" : content,
    truncated,
  };
}

export async function readWorkspaceKnowledgeArtifactById(
  workspace: LoadedWorkspace,
  cache: CourseCache | null,
  artifactId: string,
  maxLength: number
): Promise<WorkspaceChatReadResult> {
  const trimmed = artifactId.trim();
  if (!trimmed) {
    return { status: "empty_query" };
  }

  const index = await loadArtifactIndex({ workspace, cache });
  const artifact = index.artifactsById.get(trimmed);
  if (!artifact || !CHAT_READABLE_KINDS.includes(artifact.kind)) {
    return { status: "not_found" };
  }

  const content = await readArtifactContent(index, artifact.id);
  if (!content) {
    return { status: "missing_text", artifact };
  }

  const truncated = content.length > maxLength;
  return {
    status: "ok",
    artifact,
    content: truncated ? content.slice(0, maxLength) + "\n[...truncated]" : content,
    truncated,
  };
}

export async function listWorkspaceKnowledgeArtifacts(
  workspace: LoadedWorkspace,
  cache: CourseCache | null
): Promise<WorkspaceChatFileList> {
  const index = await loadArtifactIndex({ workspace, cache });
  const artifacts = index.artifacts.filter((artifact) =>
    CHAT_READABLE_KINDS.includes(artifact.kind)
  );

  return {
    workspaceFiles: artifacts
      .filter(
        (artifact) =>
          artifact.scope === "workspace" &&
          artifact.kind !== "extracted"
      )
      .sort(compareArtifacts)
      .map((artifact) => createFileEntry(artifact)),
    extractedDocuments: artifacts
      .filter(
        (artifact) =>
          artifact.scope === "workspace" && artifact.kind === "extracted"
      )
      .sort(compareArtifacts)
      .map((artifact) => createFileEntry(artifact)),
    courseDocuments: artifacts
      .filter((artifact) => artifact.scope === "course")
      .sort(compareArtifacts)
      .map((artifact) => createFileEntry(artifact)),
  };
}

export async function registerDownloadedCourseAttachment(
  cache: CourseCache | null,
  attachment: {
    canvasFileId: number | null;
    originalFilename: string;
    localPath: string;
    contentType: string | null;
    size: number | null;
    downloadUrl: string;
    reason: string;
    sourceType: "module_linked" | "assignment_linked" | "important_file" | "syllabus_file";
  }
) : Promise<void> {
  if (!cache) return;

  const nextEntry = {
    ...attachment,
    status: "downloaded" as const,
  };
  const existingIndex = cache.attachments.findIndex(
    (candidate) =>
      (candidate.canvasFileId !== null &&
        nextEntry.canvasFileId !== null &&
        candidate.canvasFileId === nextEntry.canvasFileId) ||
      candidate.localPath === nextEntry.localPath
  );

  if (existingIndex >= 0) {
    cache.attachments[existingIndex] = nextEntry;
  } else {
    cache.attachments.push(nextEntry);
  }

  clearArtifactIndexCache();
  await persistCourseAttachments(cache);
}

function findReadableArtifact(
  index: ArtifactIndex,
  query: string
): ArtifactRecord | null {
  const normalizedQuery = normalizeLookupValue(query);
  const queryVariants = [...new Set([normalizedQuery, stripTxtSuffix(normalizedQuery)])]
    .filter((value) => value.length > 0);

  const baseScores = new Map<string, number>();
  for (const variant of queryVariants) {
    const ranked = searchArtifacts(index, variant, {
      kinds: CHAT_READABLE_KINDS,
      limit: Math.max(index.artifacts.length, 12),
    });
    for (const result of ranked) {
      const nextScore = Math.max(
        baseScores.get(result.artifact.id) ?? 0,
        result.score
      );
      baseScores.set(result.artifact.id, nextScore);
    }
  }

  const candidates: ArtifactLookupCandidate[] = index.artifacts
    .filter((artifact) => CHAT_READABLE_KINDS.includes(artifact.kind))
    .map((artifact) => {
      let score = baseScores.get(artifact.id) ?? 0;
      for (const variant of queryVariants) {
        score += getLookupBoost(artifact, variant);
      }
      return { artifact, score };
    })
    .filter((candidate) => candidate.score > 0);

  candidates.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (left.artifact.scope !== right.artifact.scope) {
      return left.artifact.scope === "workspace" ? -1 : 1;
    }
    return left.artifact.title.localeCompare(right.artifact.title);
  });

  return candidates[0]?.artifact ?? null;
}

function getLookupBoost(artifact: ArtifactRecord, query: string): number {
  const lookupKeys = getArtifactLookupKeys(artifact);
  let score = artifact.scope === "workspace" ? 10 : 0;

  for (const key of lookupKeys) {
    if (key === query) {
      score += 500;
      continue;
    }
    if (path.basename(key) === query) {
      score += 420;
      continue;
    }
    if (stripTxtSuffix(key) === query) {
      score += 360;
      continue;
    }
    if (key.includes(query)) {
      score += 180;
      continue;
    }
  }

  if (artifact.searchText.includes(query)) {
    score += 40;
  }

  return score;
}

function getArtifactLookupKeys(artifact: ArtifactRecord): string[] {
  return [...new Set(
    [
      artifact.title,
      artifact.source,
      artifact.location,
      path.basename(artifact.location),
      path.basename(artifact.source),
    ]
      .map((value) => normalizeLookupValue(value))
      .filter((value) => value.length > 0)
  )];
}

function buildSearchHeader(
  artifact: ArtifactRecord,
  section: ArtifactSection
): string {
  const sectionLabel =
    !section.section || section.section === "Full text" || section.section === "Top"
      ? formatArtifactLabel(artifact)
      : `${formatArtifactLabel(artifact)} — ${section.section}`;
  return `--- ${sectionLabel} ---`;
}

function createFileEntry(artifact: ArtifactRecord): WorkspaceChatFileEntry {
  const isZip = artifact.title.endsWith(".zip") || artifact.title.endsWith(".zip.txt");
  const attachmentSourceType =
    artifact.scope === "course" &&
    artifact.kind === "attachment" &&
    typeof artifact.metadata.sourceType === "string"
      ? artifact.metadata.sourceType
      : null;
  const hint = isZip
    ? "contains extracted files — PDFs inside are readable"
    : attachmentSourceType;

  return {
    artifactId: artifact.id,
    scope: artifact.scope,
    kind: artifact.kind,
    label:
      artifact.scope === "course" ? formatArtifactLabel(artifact) : artifact.title,
    hint,
  };
}

function compareArtifacts(left: ArtifactRecord, right: ArtifactRecord): number {
  if (left.kind !== right.kind) {
    return left.kind.localeCompare(right.kind);
  }
  return left.title.localeCompare(right.title);
}

function normalizeLookupValue(value: string): string {
  return value.trim().toLowerCase();
}

function stripTxtSuffix(value: string): string {
  return value.endsWith(".txt") ? value.slice(0, -4) : value;
}

async function persistCourseAttachments(cache: CourseCache): Promise<void> {
  const attachmentsPath = path.join(cache.coursePath, "attachments.json");
  const tempPath = `${attachmentsPath}.tmp`;
  const content = JSON.stringify(cache.attachments, null, 2) + "\n";
  await fs.writeFile(tempPath, content, "utf-8");
  await fs.rename(tempPath, attachmentsPath);
}
