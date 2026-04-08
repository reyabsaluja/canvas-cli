import type { AssignmentDetail } from "../domain/models.js";
import type { EnrichmentSummary } from "../enrich/types.js";
import type { CourseCache } from "../enrich/cache-loader.js";
import { htmlToText } from "../format/html-to-text.js";
import {
  formatArtifactLabel,
  loadArtifactIndex,
  readArtifactContent,
  searchArtifacts,
  type ArtifactIndex,
  type ArtifactKind,
  type ArtifactRecord,
} from "../knowledge/artifact-index.js";

/**
 * Assembled context bundle for the AI model.
 * Includes Canvas metadata plus source documents selected from the shared artifact graph.
 */
export interface ContextBundle {
  assignmentName: string;
  courseName: string;
  dueDate: string | null;
  pointsPossible: number | null;
  gradingType: string;
  submissionTypes: string[];
  canvasDescriptionText: string | null;
  enrichmentFlags: {
    hasWeakCanvasDescription: boolean;
    missingDueDate: boolean;
    likelySubmissionShell: boolean;
  };
  /** Compact module structure for context. */
  moduleStructure: string | null;
  /** Full course assignment list for cross-referencing. */
  assignmentList: string | null;
  /** Shared-store source documents selected for overview grounding. */
  extractedTexts: ContextSourceText[];
}

export interface ContextSourceText {
  artifactId: string;
  kind: ArtifactKind;
  source: string;
  selectionReason: string;
  content: string;
}

interface ContextSourceCandidate {
  artifactId: string;
  priority: number;
  selectionReason: string;
  order: number;
}

interface CourseArtifactLookup {
  readableArtifacts: ArtifactRecord[];
  syllabus: ArtifactRecord | null;
  frontPage: ArtifactRecord | null;
  attachmentsByLocalPath: Map<string, ArtifactRecord>;
  attachmentsByTitle: Map<string, ArtifactRecord>;
  pagesById: Map<string, ArtifactRecord>;
  pagesByTitle: Map<string, ArtifactRecord>;
}

/** Per-source text limit. Generous enough for real instructions. */
const MAX_TEXT_PER_SOURCE = 8000;
/** Max total extracted text across all sources to keep prompt reasonable. */
const MAX_TOTAL_TEXT = 30000;
/** Keep the overview source list compact and intentionally prioritized. */
const MAX_CONTEXT_SOURCES = 6;
const OVERVIEW_SOURCE_KINDS: ArtifactKind[] = [
  "syllabus",
  "front_page",
  "page",
  "attachment",
];

/**
 * Build a rich context bundle for the AI from assignment detail,
 * enrichment data, and the course cache.
 *
 * Source documents are selected from the shared artifact graph so overview
 * generation, course search, and workspace retrieval all read from the same
 * underlying course artifact set.
 */
export async function buildContextBundle(
  detail: AssignmentDetail,
  enrichment: EnrichmentSummary | null,
  cache: CourseCache | null
): Promise<ContextBundle> {
  const canvasText = detail.description
    ? htmlToText(detail.description).trim()
    : null;

  const bundle: ContextBundle = {
    assignmentName: detail.name,
    courseName: detail.courseName,
    dueDate: detail.dueAt?.toISOString() ?? null,
    pointsPossible: detail.pointsPossible,
    gradingType: detail.gradingType,
    submissionTypes: detail.submissionTypes,
    canvasDescriptionText: canvasText && canvasText.length > 0 ? canvasText : null,
    enrichmentFlags: enrichment?.flags ?? {
      hasWeakCanvasDescription: !canvasText || canvasText.length < 30,
      missingDueDate: detail.dueAt === null,
      likelySubmissionShell: false,
    },
    moduleStructure: null,
    assignmentList: null,
    extractedTexts: [],
  };

  if (!cache) return bundle;

  bundle.moduleStructure = buildModuleStructure(cache);
  bundle.assignmentList = buildAssignmentList(cache);
  bundle.extractedTexts = await buildOverviewContextSources(
    detail,
    enrichment,
    cache
  );

  return bundle;
}

export async function buildOverviewContextSources(
  detail: AssignmentDetail,
  enrichment: EnrichmentSummary | null,
  cache: CourseCache | null
): Promise<ContextSourceText[]> {
  if (!cache) return [];

  const artifactIndex = await loadArtifactIndex({ cache });
  const candidates = selectOverviewArtifactCandidates(
    artifactIndex,
    detail,
    enrichment
  );

  const selected: ContextSourceText[] = [];
  let totalTextLoaded = 0;
  for (const candidate of candidates) {
    if (
      selected.length >= MAX_CONTEXT_SOURCES ||
      totalTextLoaded >= MAX_TOTAL_TEXT
    ) {
      break;
    }

    const artifact = artifactIndex.artifactsById.get(candidate.artifactId);
    if (!artifact) continue;

    const text = await readArtifactContent(artifactIndex, artifact.id);
    if (!text || text.length <= 20 || text.startsWith("[")) {
      continue;
    }

    const remainingBudget = MAX_TOTAL_TEXT - totalTextLoaded;
    if (remainingBudget <= 0) break;

    const content = truncate(
      text,
      Math.min(MAX_TEXT_PER_SOURCE, remainingBudget)
    );
    selected.push({
      artifactId: artifact.id,
      kind: artifact.kind,
      source: formatArtifactLabel(artifact),
      selectionReason: candidate.selectionReason,
      content,
    });
    totalTextLoaded += content.length;
  }

  return selected;
}

function selectOverviewArtifactCandidates(
  artifactIndex: ArtifactIndex,
  detail: AssignmentDetail,
  enrichment: EnrichmentSummary | null
): ContextSourceCandidate[] {
  const lookup = buildCourseArtifactLookup(artifactIndex);
  const candidates = new Map<string, ContextSourceCandidate>();
  let order = 0;

  const addCandidate = (
    artifact: ArtifactRecord | null | undefined,
    priority: number,
    selectionReason: string
  ): void => {
    if (!artifact) return;
    const existing = candidates.get(artifact.id);
    const candidate: ContextSourceCandidate = {
      artifactId: artifact.id,
      priority,
      selectionReason,
      order: order,
    };
    order += 1;

    if (
      !existing ||
      existing.priority < candidate.priority ||
      (existing.priority === candidate.priority &&
        existing.order > candidate.order)
    ) {
      candidates.set(artifact.id, candidate);
    }
  };

  addCandidate(lookup.syllabus, 120, "course syllabus");

  for (const attachment of detail.attachments) {
    addCandidate(
      lookup.attachmentsByTitle.get(normalizeLookupKey(attachment.displayName)),
      110,
      "assignment attachment"
    );
    addCandidate(
      lookup.attachmentsByTitle.get(normalizeLookupKey(attachment.filename)),
      110,
      "assignment attachment"
    );
  }

  if (enrichment) {
    for (const attachment of enrichment.relatedAttachments ?? []) {
      addCandidate(
        lookup.attachmentsByLocalPath.get(attachment.localPath) ??
          lookup.attachmentsByTitle.get(normalizeLookupKey(attachment.filename)),
        105,
        "enrichment-related attachment"
      );
    }

    for (const page of enrichment.relatedPages ?? []) {
      addCandidate(
        lookup.pagesById.get(page.pageId) ??
          lookup.pagesByTitle.get(normalizeLookupKey(page.title)),
        100,
        "enrichment-related page"
      );
    }

    for (const hint of enrichment.likelyInstructionSources ?? []) {
      if (hint.type === "attachment" || hint.type === "file") {
        addCandidate(
          (hint.localPath
            ? lookup.attachmentsByLocalPath.get(hint.localPath)
            : null) ??
            lookup.attachmentsByTitle.get(normalizeLookupKey(hint.title)),
          96,
          `likely instruction source: ${hint.reason}`
        );
      }

      if (hint.type === "page") {
        addCandidate(
          lookup.pagesByTitle.get(normalizeLookupKey(hint.title)),
          96,
          `likely instruction source: ${hint.reason}`
        );
      }
    }
  }

  addCandidate(lookup.frontPage, 92, "course front page");

  const assignmentNameMatches = searchArtifacts(artifactIndex, detail.name, {
    scope: "course",
    kinds: OVERVIEW_SOURCE_KINDS,
    limit: MAX_CONTEXT_SOURCES,
  });
  for (let index = 0; index < assignmentNameMatches.length; index += 1) {
    const match = assignmentNameMatches[index];
    addCandidate(
      match?.artifact,
      80 - index,
      "assignment-name search match"
    );
  }

  for (const artifact of lookup.readableArtifacts) {
    addCandidate(artifact, 20, "fallback readable course source");
  }

  return [...candidates.values()].sort((left, right) => {
    if (right.priority !== left.priority) {
      return right.priority - left.priority;
    }
    if (left.order !== right.order) {
      return left.order - right.order;
    }
    return left.artifactId.localeCompare(right.artifactId);
  });
}

function buildCourseArtifactLookup(artifactIndex: ArtifactIndex): CourseArtifactLookup {
  const readableArtifacts = artifactIndex.artifacts.filter(
    (artifact) =>
      artifact.scope === "course" &&
      OVERVIEW_SOURCE_KINDS.includes(artifact.kind)
  );

  const attachmentsByLocalPath = new Map<string, ArtifactRecord>();
  const attachmentsByTitle = new Map<string, ArtifactRecord>();
  const pagesById = new Map<string, ArtifactRecord>();
  const pagesByTitle = new Map<string, ArtifactRecord>();
  let syllabus: ArtifactRecord | null = null;
  let frontPage: ArtifactRecord | null = null;

  for (const artifact of readableArtifacts) {
    if (artifact.kind === "syllabus") {
      syllabus = artifact;
      continue;
    }

    if (artifact.kind === "front_page") {
      frontPage = artifact;
      continue;
    }

    if (artifact.kind === "attachment") {
      const localPath =
        typeof artifact.metadata.localPath === "string"
          ? artifact.metadata.localPath
          : null;
      if (localPath) {
        attachmentsByLocalPath.set(localPath, artifact);
      }
      attachmentsByTitle.set(normalizeLookupKey(artifact.title), artifact);
    }

    if (artifact.kind === "page") {
      const pageId =
        typeof artifact.metadata.pageId === "string"
          ? artifact.metadata.pageId
          : null;
      if (pageId) {
        pagesById.set(pageId, artifact);
      }
      pagesByTitle.set(normalizeLookupKey(artifact.title), artifact);
    }
  }

  return {
    readableArtifacts,
    syllabus,
    frontPage,
    attachmentsByLocalPath,
    attachmentsByTitle,
    pagesById,
    pagesByTitle,
  };
}

function buildModuleStructure(cache: CourseCache): string | null {
  if (cache.modules.length === 0) return null;

  const lines: string[] = [];
  for (const mod of cache.modules) {
    lines.push(`Module: ${mod.name}`);
    for (const item of mod.items) {
      lines.push(`  - [${item.type}] ${item.title}`);
    }
  }
  return lines.join("\n");
}

function buildAssignmentList(cache: CourseCache): string | null {
  if (cache.assignments.length === 0) return null;

  const lines: string[] = [];
  for (const assignment of cache.assignments) {
    const due = assignment.dueAt
      ? new Date(assignment.dueAt).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "no due date";
    const points =
      assignment.pointsPossible !== null ? `${assignment.pointsPossible}pts` : "";
    lines.push(`- ${assignment.name} — ${due} ${points}`.trim());
  }
  return lines.join("\n");
}

function normalizeLookupKey(value: string): string {
  return value.trim().toLowerCase();
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "\n[...truncated]";
}
