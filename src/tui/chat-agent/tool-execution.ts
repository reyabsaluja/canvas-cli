import fs from "node:fs/promises";
import path from "node:path";
import type { LoadedWorkspace } from "../../ask/types.js";
import type { ToolExecutionResult, ArtifactRef } from "../../agent/observation.js";
import { isGroundedContentObservation } from "../../agent/observation-relevance.js";
import type { ArtifactRecord } from "../../knowledge/artifact-index.js";
import { clearArtifactIndexCache } from "../../knowledge/artifact-index.js";
import { extractSingleAttachment } from "../../ingest/attachment-extraction.js";
import type { DownloadedAttachmentEntry } from "../../ingest/types.js";
import { getExtractedAttachmentPath } from "../../enrich/course-documents.js";
import { handleOpenResourceQuery } from "../open-resources.js";
import { handleLectureQuery } from "../lecture-resources.js";
import {
  renderCourseArtifactSearchResult,
  searchCourseKnowledge,
} from "../course-retrieval.js";
import {
  formatRadarItems,
  resolveAndRenderThread,
} from "../radar-commands.js";
import type { RadarFilter } from "../services.js";
import {
  listWorkspaceKnowledgeArtifacts,
  persistCourseAttachmentUpdates,
  readWorkspaceKnowledgeArtifact,
  readWorkspaceKnowledgeArtifactById,
  registerDownloadedCourseAttachment,
  searchWorkspaceKnowledge,
} from "../workspace-knowledge.js";
import { buildArtifactExcerpt } from "./shared.js";
import type {
  ChatAgentContext,
  TurnToolCache,
  TurnToolExecutionResult,
} from "./types.js";
import { collectFailedReadArtifactIds } from "./verification.js";
import { splitDocumentIntoSections } from "../../agent/verify.js";
import { confineToDirectory, sanitizeFilename } from "../../sanitize.js";

/**
 * Characters handed to the model for a whole-document read. PDF sidecars can
 * run to 400k chars, so a whole read is a window onto the start of the
 * document; the cut-off note names the sections that were left out and the
 * model reaches them with `section` / `offset` on the next read_file call.
 * Never lower this: the read window is the model's only view of the source.
 */
export const MAX_DOC_TEXT = 120000;

/** Characters returned for a single section read (a whole page is far smaller). */
const MAX_SECTION_TEXT = MAX_DOC_TEXT;

/** Read-window controls parsed from a read_file call. */
export interface DocumentReadRequest {
  /** Section heading or page reference ("Page 57", "57", "Part 3: ...") to isolate. */
  section?: string | null;
  /** Zero-based char offset to start the window at (whole-document reads only). */
  offset?: number | null;
}

async function executeToolCallDetailed(
  name: string,
  input: Record<string, unknown>,
  ctx: ChatAgentContext
): Promise<ToolExecutionResult> {
  switch (name) {
    case "search_workspace":
      return await searchWorkspace(input.query as string, ctx);
    case "read_file":
      return readFile(input.filename as string, ctx, parseDocumentReadRequest(input));
    case "list_files":
      return listFiles(ctx);
    case "search_course":
      return await searchCourse(input.query as string, ctx);
    case "download_course_file":
      return downloadCourseFile(input.title as string, ctx);
    case "open_resource":
      return openResource(input.query as string, ctx);
    case "open_lecture":
      return openLecture(input.query as string, ctx);
    case "list_assignments":
      return listAssignments(ctx);
    case "list_announcements":
      return listAnnouncements(
        (input.filter as RadarFilter | undefined) ?? "all",
        (input.query as string | undefined) ?? "",
        ctx
      );
    case "read_thread":
      return readThread(input.topic as string, ctx);
    default:
      return {
        observation: {
          tool: name,
          status: "error",
          summary: `Unknown tool: ${name}`,
          artifacts: [],
        },
        modelText: `Unknown tool: ${name}`,
        uiText: `Unknown tool: ${name}`,
      };
  }
}

export async function executeToolCallForTurn(
  turnToolCache: TurnToolCache,
  name: string,
  input: Record<string, unknown>,
  ctx: ChatAgentContext
): Promise<TurnToolExecutionResult> {
  const cacheKey = buildTurnToolCacheKey(name, input);
  const cached = turnToolCache.get(cacheKey);
  if (cached) {
    return { result: cached, deduped: true };
  }

  for (const aliasKey of buildSemanticTurnToolAliasKeys(name, input)) {
    const aliasCached = turnToolCache.get(aliasKey);
    if (aliasCached) {
      return { result: aliasCached, deduped: true };
    }
  }

  const semanticCached = findSemanticTurnToolCacheHit(turnToolCache, name, input);
  if (semanticCached) {
    return { result: semanticCached, deduped: true };
  }

  const result = await executeToolCallDetailed(name, input, ctx);
  seedTurnToolCacheEntry(turnToolCache, name, input, result);
  return { result, deduped: false };
}

export function buildTurnToolCacheKey(
  name: string,
  input: Record<string, unknown>
): string {
  return `${name}:${normalizeToolInput(input)}`;
}

export function seedTurnToolCacheEntry(
  turnToolCache: TurnToolCache,
  name: string,
  input: Record<string, unknown>,
  result: ToolExecutionResult
): void {
  turnToolCache.set(buildTurnToolCacheKey(name, input), result);
  if (isGroundedContentObservation(result.observation)) {
    return;
  }
  for (const aliasKey of buildSemanticTurnToolAliasKeys(name, input)) {
    turnToolCache.set(aliasKey, result);
  }
}

export async function readArtifactForGate(
  artifactId: string,
  ctx: ChatAgentContext
): Promise<ToolExecutionResult> {
  const artifact = await readWorkspaceKnowledgeArtifactById(
    ctx.loaded,
    ctx.cache,
    artifactId,
    Number.MAX_SAFE_INTEGER
  );
  switch (artifact.status) {
    case "ok":
      return buildDocumentReadResult(
        "read_file",
        toArtifactRef(artifact.artifact),
        artifact.content,
        {}
      );
    case "missing_text": {
      const recovered = await recoverMissingAttachmentRead(
        artifact.artifact,
        ctx,
        "read_file"
      );
      if (recovered) {
        return recovered;
      }
      const message = `Matched ${artifact.artifact?.title ?? artifactId}, but readable text is missing.`;
      return {
        observation: {
          tool: "read_file",
          status: "missing_text",
          summary: message,
          artifacts: artifact.artifact ? [toArtifactRef(artifact.artifact)] : [],
        },
        modelText: message,
        uiText: message,
      };
    }
    case "empty_query":
    case "not_found":
    default:
      return {
        observation: {
          tool: "read_file",
          status: "not_found",
          summary: `Could not read artifact "${artifactId}" from the workspace knowledge store.`,
          artifacts: [],
        },
        modelText: `Could not read artifact "${artifactId}" from the workspace knowledge store.`,
        uiText: `Could not read artifact "${artifactId}" from the workspace knowledge store.`,
      };
  }
}

async function searchWorkspace(
  query: string,
  ctx: ChatAgentContext
): Promise<ToolExecutionResult> {
  const relevant = preferViableSearchMatches(
    await searchWorkspaceKnowledge(ctx.loaded, ctx.cache, query, 5),
    collectFailedReadArtifactIds(ctx.runState.observations)
  );
  if (relevant.length === 0) {
    return {
      observation: {
        tool: "search_workspace",
        status: "not_found",
        summary: `No relevant workspace content found for "${query}".`,
        artifacts: [],
      },
      modelText: "No relevant content found for that query.",
      uiText: "No relevant content found for that query.",
    };
  }
  const results: string[] = [];
  for (const match of relevant) {
    results.push(match.header);
    results.push(match.preview);
    results.push("");
  }
  const rendered = results.join("\n");
  return {
    observation: {
      tool: "search_workspace",
      status: "ok",
      summary: `Found ${relevant.length} relevant workspace matches for "${query}".`,
      artifacts: relevant.map((match) => ({
        artifactId: match.artifact.id,
        title: match.artifact.title,
        kind: match.artifact.kind,
        excerpt: match.section.excerpt,
        sectionIds: [match.section.id],
        sectionLabel: normalizeSourceSectionLabel(match.section.section),
      })),
    },
    modelText: `${rendered}\n${buildWorkspaceSearchGuidance(relevant)}`,
    uiText: rendered,
  };
}

async function searchCourse(
  query: string,
  ctx: ChatAgentContext
): Promise<ToolExecutionResult> {
  const result = await searchCourseKnowledge(ctx.cache, query);
  const failedArtifactIds = collectFailedReadArtifactIds(ctx.runState.observations);
  const filteredResult =
    result.status === "ok"
      ? {
          status: "ok" as const,
          matches: preferViableSearchMatches(result.matches, failedArtifactIds),
        }
      : result;
  const uiText = renderCourseArtifactSearchResult(filteredResult, query);
  if (filteredResult.status !== "ok") {
    return {
      observation: {
        tool: "search_course",
        status:
          filteredResult.status === "not_found" ||
          filteredResult.status === "empty_query"
            ? "not_found"
            : "error",
        summary: uiText,
        artifacts: [],
      },
      modelText: uiText,
      uiText,
    };
  }
  return {
    observation: {
      tool: "search_course",
      status: "ok",
      summary: `Found ${filteredResult.matches.length} course matches for "${query}".`,
      // Cite the matched passage, not the document head, so a search hit on
      // "Page 57" or "Late Penalty" can be attributed to that section.
      artifacts: filteredResult.matches.map(({ artifact, passage }) => ({
        artifactId: artifact.id,
        title: artifact.title,
        kind: artifact.kind,
        excerpt: passage?.excerpt || artifact.excerpt,
        ...(passage ? { sectionIds: [passage.sectionId] } : {}),
        sectionLabel: normalizeSourceSectionLabel(passage?.section),
      })),
    },
    modelText: `${uiText}\n${buildCourseSearchGuidance(filteredResult.matches, Boolean(ctx.client))}`,
    uiText,
  };
}

function preferViableSearchMatches<T extends { artifact: ArtifactRecord }>(
  matches: T[],
  failedArtifactIds: Set<string>
): T[] {
  if (matches.length === 0 || failedArtifactIds.size === 0) {
    return matches;
  }

  const viable = matches.filter(
    (match) => !failedArtifactIds.has(match.artifact.id)
  );
  return viable.length > 0 ? viable : matches;
}

async function readFile(
  filename: string,
  ctx: ChatAgentContext,
  request: DocumentReadRequest = {}
): Promise<ToolExecutionResult> {
  const trimmedFilename = (filename ?? "").trim();
  if (!trimmedFilename) {
    return {
      observation: {
        tool: "read_file",
        status: "not_found",
        summary: "Provide a file name to read from the workspace or course cache.",
        artifacts: [],
      },
      modelText: "Provide a file name to read from the workspace or course cache.",
      uiText: "Provide a file name to read from the workspace or course cache.",
    };
  }

  // A section or offset read is a different window onto the document than an
  // earlier whole-document read (which may have been cut off before the
  // requested section), so it always goes back to the source text.
  const reusedObservation = isWindowedReadRequest(request)
    ? null
    : findReusableReadObservation(trimmedFilename, ctx.runState.observations);
  if (reusedObservation) {
    const title = reusedObservation.artifacts[0]?.title ?? trimmedFilename;
    return {
      observation: {
        tool: "read_file",
        status: "ok",
        summary: `Reused previously read ${title}.`,
        artifacts: reusedObservation.artifacts,
        content: reusedObservation.content,
      },
      modelText: buildReadModelText(
        reusedObservation.artifacts[0],
        reusedObservation.content ?? ""
      ),
      uiText: reusedObservation.content ?? "",
    };
  }

  const artifact = await readWorkspaceKnowledgeArtifact(
    ctx.loaded,
    ctx.cache,
    trimmedFilename,
    Number.MAX_SAFE_INTEGER
  );
  switch (artifact.status) {
    case "ok":
      return buildDocumentReadResult(
        "read_file",
        toArtifactRef(artifact.artifact),
        artifact.content,
        request
      );
    case "empty_query":
      return {
        observation: {
          tool: "read_file",
          status: "not_found",
          summary: "Provide a file name to read from the workspace or course cache.",
          artifacts: [],
        },
        modelText: "Provide a file name to read from the workspace or course cache.",
        uiText: "Provide a file name to read from the workspace or course cache.",
      };
    case "missing_text": {
      const recovered = await recoverMissingAttachmentRead(
        artifact.artifact,
        ctx,
        "read_file"
      );
      if (recovered) {
        return recovered;
      }
      const message = renderWorkspaceArtifactLookupFailure(trimmedFilename, artifact);
      return {
        observation: {
          tool: "read_file",
          status: "missing_text",
          summary: message,
          artifacts: artifact.artifact ? [toArtifactRef(artifact.artifact)] : [],
        },
        modelText: message,
        uiText: message,
      };
    }
    case "not_found":
    default:
      return {
        observation: {
          tool: "read_file",
          status: "not_found",
          summary: `File "${trimmedFilename}" not found. Use list_files to see available files.`,
          artifacts: [],
        },
        modelText: `File "${trimmedFilename}" not found. Use list_files to see available files.`,
        uiText: `File "${trimmedFilename}" not found. Use list_files to see available files.`,
      };
  }
}

async function listFiles(ctx: ChatAgentContext): Promise<ToolExecutionResult> {
  const fileList = await listWorkspaceKnowledgeArtifacts(ctx.loaded, ctx.cache);
  const lines: string[] = [];
  lines.push("Workspace files:");
  if (fileList.workspaceFiles.length === 0) {
    lines.push("  - No workspace documents indexed yet.");
  } else {
    for (const entry of fileList.workspaceFiles) {
      lines.push(`  - ${entry.label}`);
    }
  }
  if (fileList.extractedDocuments.length > 0) {
    lines.push("\nExtracted documents (use read_file to access):");
    for (const entry of fileList.extractedDocuments) {
      lines.push(`  - ${entry.label}${entry.hint ? ` (${entry.hint})` : ""}`);
    }
  }
  if (fileList.courseDocuments.length > 0) {
    lines.push("\nCourse documents (shared knowledge store):");
    for (const entry of fileList.courseDocuments) {
      lines.push(`  - ${entry.label}${entry.hint ? ` (${entry.hint})` : ""}`);
    }
  } else if (ctx.cache) {
    lines.push("\nCourse documents (shared knowledge store):");
    lines.push("  - No readable course documents indexed yet.");
  }
  const rendered = lines.join("\n");
  return {
    observation: {
      tool: "list_files",
      status: "ok",
      summary: "Listed workspace and course files available to chat.",
      artifacts: [],
    },
    modelText: rendered,
    uiText: rendered,
  };
}

async function downloadCourseFile(
  title: string,
  ctx: ChatAgentContext
): Promise<ToolExecutionResult> {
  if (!ctx.cache) {
    return {
      observation: {
        tool: "download_course_file",
        status: "error",
        summary: "Cannot download files — no course cache available.",
        artifacts: [],
      },
      modelText: "Cannot download files — no course cache available.",
      uiText: "Cannot download files — no course cache available.",
    };
  }
  let foundItem = null;
  let bestMatchScore = 0;
  for (const mod of ctx.cache.modules) {
    for (const item of mod.items) {
      if (item.type !== "File") {
        continue;
      }
      const matchScore = scoreFileLookupMatch(title, item.title);
      if (matchScore > bestMatchScore) {
        bestMatchScore = matchScore;
        foundItem = item;
      }
      if (matchScore >= 100) {
        break;
      }
    }
    if (bestMatchScore >= 100) {
      break;
    }
  }
  if (!foundItem || !foundItem.contentId || bestMatchScore <= 0) {
    return {
      observation: {
        tool: "download_course_file",
        status: "not_found",
        summary: `No downloadable file matching "${title}" found.`,
        artifacts: [],
      },
      modelText: `No downloadable file matching "${title}" found.`,
      uiText: `No downloadable file matching "${title}" found.`,
    };
  }

  const cachedAttachment = ctx.cache.attachments.find(
    (attachment) => attachment.canvasFileId === foundItem!.contentId
  );
  if (cachedAttachment) {
    const reused = await reuseCachedAttachmentContent(
      ctx.cache.coursePath,
      ctx.loaded,
      ctx.cache,
      cachedAttachment.localPath,
      cachedAttachment.originalFilename
    );
    if (reused) {
      return reused;
    }
  }

  if (!ctx.client) {
    return {
      observation: {
        tool: "download_course_file",
        status: "error",
        summary: `Cannot fetch "${foundItem.title}" from Canvas because no client is available, and no reusable local text was found.`,
        artifacts: cachedAttachment
          ? [
              createCourseAttachmentArtifactRef(
                cachedAttachment.localPath,
                cachedAttachment.originalFilename
              ),
            ]
          : [],
      },
      modelText: `Cannot fetch "${foundItem.title}" from Canvas because no client is available, and no reusable local text was found.`,
      uiText: `Cannot fetch "${foundItem.title}" from Canvas because no client is available, and no reusable local text was found.`,
    };
  }

  const fileMeta = await ctx.client.getFileSafe(foundItem.contentId);
  if (!fileMeta) {
    return {
      observation: {
        tool: "download_course_file",
        status: "error",
        summary: `Could not access file "${title}" from Canvas.`,
        artifacts: [],
      },
      modelText: `Could not access file "${title}" from Canvas.`,
      uiText: `Could not access file "${title}" from Canvas.`,
    };
  }
  const buffer = await ctx.client.downloadFile(fileMeta.url);
  if (!buffer) {
    return {
      observation: {
        tool: "download_course_file",
        status: "error",
        summary: `Failed to download "${fileMeta.display_name}".`,
        artifacts: [],
      },
      modelText: `Failed to download "${fileMeta.display_name}".`,
      uiText: `Failed to download "${fileMeta.display_name}".`,
    };
  }
  const downloadDir = path.join(ctx.cache.coursePath, "attachments", "modules");
  await fs.mkdir(downloadDir, { recursive: true });
  const localPath = confineToDirectory(
    downloadDir,
    sanitizeFilename(fileMeta.display_name)
  );
  await fs.writeFile(localPath, buffer);
  const relativeLocalPath = path.relative(ctx.cache.coursePath, localPath);
  await registerDownloadedCourseAttachment(ctx.cache, {
    canvasFileId: fileMeta.id,
    originalFilename: fileMeta.display_name,
    localPath: relativeLocalPath,
    contentType: fileMeta.content_type,
    size: fileMeta.size,
    downloadUrl: fileMeta.url,
    reason: `downloaded on demand from module item "${foundItem.title}"`,
    sourceType: "module_linked",
  });

  const registeredAttachment = ctx.cache.attachments.find(
    (entry) => entry.localPath === relativeLocalPath
  );
  const unpackedEntries = await runAttachmentExtraction(
    ctx.cache.coursePath,
    registeredAttachment ?? null
  );
  if (unpackedEntries.length > 0) {
    await persistCourseAttachmentUpdates(ctx.cache);
  } else {
    // Text extraction may have produced a sidecar even without unpack.
    clearArtifactIndexCache();
  }

  const extracted = await readExtractedSidecar(
    ctx.cache.coursePath,
    relativeLocalPath
  );
  if (extracted) {
    // Same windowed view as read_file: 120k cap, section outline, cut-off note.
    return buildDocumentReadResult(
      "download_course_file",
      createCourseAttachmentArtifactRef(
        relativeLocalPath,
        fileMeta.display_name,
        extracted
      ),
      extracted,
      {},
      unpackedEntries.length > 0
        ? `Downloaded, extracted, and unpacked ${fileMeta.display_name} (${unpackedEntries.length} inner files).`
        : `Downloaded and extracted ${fileMeta.display_name}.`
    );
  }

  if (unpackedEntries.length > 0) {
    const summary = `Downloaded and unpacked ${fileMeta.display_name} (${unpackedEntries.length} inner files). The zip itself has no text body; call read_file on a specific inner file by name.`;
    return {
      observation: {
        tool: "download_course_file",
        status: "ok",
        summary,
        artifacts: [
          createCourseAttachmentArtifactRef(
            relativeLocalPath,
            fileMeta.display_name
          ),
        ],
      },
      modelText: summary,
      uiText: summary,
    };
  }

  const message = `Downloaded "${fileMeta.display_name}", but extracted text is not available yet. Refresh the course cache to rebuild it.`;
  return {
    observation: {
      tool: "download_course_file",
      status: "missing_text",
      summary: message,
      artifacts: [
        createCourseAttachmentArtifactRef(
          relativeLocalPath,
          fileMeta.display_name
        ),
      ],
    },
    modelText: message,
    uiText: message,
  };
}

async function openResource(
  query: string,
  ctx: ChatAgentContext
): Promise<ToolExecutionResult> {
  const context = {
    loaded: ctx.loaded,
    cache: ctx.cache,
    lastExportedPdfPath: ctx.lastExportedPdfPath ?? null,
  };
  const result = await handleOpenResourceQuery(query, context, undefined, true);
  const success = result.status === "opened";
  return {
    observation: {
      tool: "open_resource",
      status: success ? "ok" : "not_found",
      summary: result.message,
      artifacts: [],
    },
    modelText: result.message,
    uiText: result.message,
  };
}

async function openLecture(
  query: string,
  ctx: ChatAgentContext
): Promise<ToolExecutionResult> {
  const result = await handleLectureQuery(
    query,
    ctx.cache,
    ctx.client,
    ctx.cache?.courseId ?? null
  );
  const success = result.status === "opened" || result.status === "listed";
  return {
    observation: {
      tool: "open_lecture",
      status: success ? "ok" : "not_found",
      summary: result.message,
      artifacts: [],
    },
    modelText: result.message,
    uiText: result.message,
  };
}

async function listAssignments(
  ctx: ChatAgentContext
): Promise<ToolExecutionResult> {
  const assignments = ctx.assignments ?? [];
  if (assignments.length === 0) {
    const message =
      "No assignments are available for this course in the current context.";
    return {
      observation: {
        tool: "list_assignments",
        status: "not_found",
        summary: message,
        artifacts: [],
      },
      modelText: message,
      uiText: message,
    };
  }
  const lines = assignments.slice(0, 40).map((assignment) => {
    const due = assignment.dueAt
      ? assignment.dueAt.toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "no due date";
    return `- ${assignment.name} — ${due}${assignment.submitted ? " — submitted" : ""}`;
  });
  const rendered = lines.join("\n");
  return {
    observation: {
      tool: "list_assignments",
      status: "ok",
      summary: `Listed ${assignments.length} assignment${assignments.length === 1 ? "" : "s"} for this course.`,
      artifacts: [],
    },
    modelText: rendered,
    uiText: rendered,
  };
}

async function listAnnouncements(
  filter: RadarFilter,
  query: string,
  ctx: ChatAgentContext
): Promise<ToolExecutionResult> {
  if (!ctx.radar || ctx.courseId == null) {
    const message =
      "Announcements are unavailable in this context (no course binding).";
    return {
      observation: {
        tool: "list_announcements",
        status: "error",
        summary: message,
        artifacts: [],
      },
      modelText: message,
      uiText: message,
    };
  }
  const courseName = ctx.courseName ?? ctx.loaded.courseName ?? "";
  const items = await ctx.radar.getRadarItems(
    ctx.courseId,
    courseName,
    filter,
    query || undefined
  );
  const rendered = formatRadarItems(items, filter, query);
  return {
    observation: {
      tool: "list_announcements",
      status: "ok",
      summary: `Listed ${items.length} announcement${items.length === 1 ? "" : "s"}${query ? ` matching "${query}"` : ""}.`,
      artifacts: [],
    },
    modelText: rendered,
    uiText: rendered,
  };
}

async function readThread(
  topic: string,
  ctx: ChatAgentContext
): Promise<ToolExecutionResult> {
  if (!ctx.radar || ctx.courseId == null) {
    const message =
      "Threads are unavailable in this context (no course binding).";
    return {
      observation: {
        tool: "read_thread",
        status: "error",
        summary: message,
        artifacts: [],
      },
      modelText: message,
      uiText: message,
    };
  }
  const courseName = ctx.courseName ?? ctx.loaded.courseName ?? "";
  const resolved = await resolveAndRenderThread(
    { radar: ctx.radar } as unknown as Parameters<typeof resolveAndRenderThread>[0],
    [{ id: ctx.courseId, name: courseName }],
    topic
  );
  return {
    observation: {
      tool: "read_thread",
      status: resolved.found ? "ok" : "not_found",
      summary: resolved.found
        ? `Read discussion thread for "${topic}".`
        : resolved.content,
      artifacts: [],
    },
    modelText: resolved.content,
    uiText: resolved.content,
  };
}

function normalizeToolInput(value: unknown): string {
  if (typeof value === "string") {
    return value.trim().replace(/\s+/g, " ").toLowerCase();
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => normalizeToolInput(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right)
    );
    return `{${entries
      .map(([key, entry]) => `${key}:${normalizeToolInput(entry)}`)
      .join(",")}}`;
  }

  return String(value ?? "");
}

/**
 * Outline entries shown after page runs have been compressed ("Page 1–60"
 * counts as one). Page-numbered decks therefore always list every page; only
 * documents with many distinct headings overflow, and those name how to reach
 * the rest.
 */
const MAX_OUTLINE_LABELS = 80;

const PAGE_LABEL_PATTERN = /^page\s+(\d+)$/i;
const SECTION_REQUEST_PAGE_PATTERN =
  /^(?:page|pages|pg\.?|p\.?|slide|slides)?\s*(\d+)\b/i;
const SECTION_REQUEST_STOP_WORDS = new Set([
  "a", "an", "and", "of", "on", "or", "section", "the", "to",
]);

/** One window onto a document: the text handed to the model plus its framing. */
export interface DocumentReadView {
  content: string;
  /** Label of the isolated section, or null for whole-document / offset reads. */
  sectionLabel: string | null;
  /** Every section label in the full document, in order. */
  labels: string[];
  /** Zero-based index of the isolated section among `labels`. */
  sectionIndex: number | null;
  /** Section labels that fall entirely after the window (whole-document reads). */
  omittedLabels: string[];
  /** Label the window was cut off inside, when it ends mid-section. */
  cutOffInside: string | null;
  /** Requested section that matched nothing, when the read fell back to the whole document. */
  unmatchedSection: string | null;
  /** Char offset the window starts at (null unless an offset read). */
  offset: number | null;
  /** Char offset where the rest of the document continues, when cut off. */
  nextOffset: number | null;
  totalLength: number;
  truncated: boolean;
}

export function parseDocumentReadRequest(
  input: Record<string, unknown>
): DocumentReadRequest {
  const section =
    typeof input.section === "string" && input.section.trim().length > 0
      ? input.section.trim()
      : typeof input.section === "number" && Number.isFinite(input.section)
        ? String(input.section)
        : typeof input.page === "number" && Number.isFinite(input.page)
          ? `Page ${input.page}`
          : typeof input.page === "string" && input.page.trim().length > 0
            ? input.page.trim()
            : null;
  const rawOffset =
    typeof input.offset === "number"
      ? input.offset
      : typeof input.offset === "string" && input.offset.trim().length > 0
        ? Number(input.offset)
        : null;
  const offset =
    rawOffset !== null && Number.isFinite(rawOffset) && rawOffset > 0
      ? Math.floor(rawOffset)
      : null;
  return { section, offset };
}

function isWindowedReadRequest(request: DocumentReadRequest): boolean {
  return Boolean(request.section) || (request.offset ?? 0) > 0;
}

/**
 * Choose the part of a document a read returns. Section reads isolate one
 * heading (fuzzy, case-insensitive, page numbers accepted) using the same
 * splitter answer verification cites with, so the label in the artifact ref
 * is exactly the label a citation will carry. Whole-document reads are cut at
 * `maxChars` and record which sections fell outside the window.
 */
export function buildDocumentReadView(
  content: string,
  request: DocumentReadRequest = {},
  maxChars: number = MAX_DOC_TEXT
): DocumentReadView {
  const sections = splitDocumentIntoSections(content);
  const labels = sections
    .map((section) => section.label)
    .filter((label): label is string => Boolean(label));
  const base: DocumentReadView = {
    content,
    sectionLabel: null,
    labels,
    sectionIndex: null,
    omittedLabels: [],
    cutOffInside: null,
    unmatchedSection: null,
    offset: null,
    nextOffset: null,
    totalLength: content.length,
    truncated: false,
  };

  const requestedSection = request.section?.trim() ?? "";
  if (requestedSection) {
    const matchIndex = resolveSectionRequest(requestedSection, labels);
    if (matchIndex !== null) {
      const label = labels[matchIndex]!;
      const section = sections.find((entry) => entry.label === label)!;
      const body = `${label}\n${section.text}`;
      const truncated = body.length > MAX_SECTION_TEXT;
      return {
        ...base,
        content: truncated
          ? `${body.slice(0, MAX_SECTION_TEXT)}\n[...truncated]`
          : body,
        sectionLabel: label,
        sectionIndex: matchIndex,
        truncated,
      };
    }
    base.unmatchedSection = requestedSection;
  }

  const offset =
    request.offset && request.offset > 0 && request.offset < content.length
      ? request.offset
      : null;
  const start = offset ?? 0;
  const windowed = content.slice(start, start + maxChars);
  const truncated = start + windowed.length < content.length;
  const windowLabels = truncated
    ? splitDocumentIntoSections(windowed)
        .map((section) => section.label)
        .filter((label): label is string => Boolean(label))
    : labels;

  let omittedLabels: string[] = [];
  let cutOffInside: string | null = null;
  if (truncated) {
    const lastShown = windowLabels[windowLabels.length - 1] ?? null;
    const lastShownIndex = lastShown ? labels.lastIndexOf(lastShown) : -1;
    if (lastShownIndex >= 0) {
      cutOffInside = lastShown;
      omittedLabels = labels.slice(lastShownIndex + 1);
    } else {
      omittedLabels = labels.slice(offset === null ? 0 : labels.length);
    }
  }

  return {
    ...base,
    content: truncated ? `${windowed}\n[...truncated]` : windowed,
    omittedLabels,
    cutOffInside,
    offset,
    nextOffset: truncated ? start + windowed.length : null,
    truncated,
  };
}

function normalizeSectionRequest(value: string): string {
  return value
    .toLowerCase()
    .replace(/[*_`#]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s:.\-–—]+|[\s:.\-–—]+$/g, "")
    .trim();
}

function tokenizeSectionRequest(value: string): string[] {
  return normalizeSectionRequest(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !SECTION_REQUEST_STOP_WORDS.has(token));
}

/**
 * Resolve a section reference against the document's labels. Accepts the
 * exact label, a page reference in any of the usual spellings ("57",
 * "page 57", "p. 57", "Page 57 (Part 2)"), a keyword + number ("Part 3"), a
 * fragment of the heading, or most of its words. Returns the label index.
 */
export function resolveSectionRequest(
  requested: string,
  labels: string[]
): number | null {
  const query = normalizeSectionRequest(requested);
  if (!query || labels.length === 0) {
    return null;
  }
  const normalizedLabels = labels.map((label) => normalizeSectionRequest(label));

  const exact = normalizedLabels.indexOf(query);
  if (exact >= 0) {
    return exact;
  }

  const pageMatch = query.match(SECTION_REQUEST_PAGE_PATTERN);
  if (pageMatch) {
    const number = pageMatch[1]!;
    const explicitPage = /^(?:page|pages|pg\.?|p\.?|slide|slides)\s*\d+/i.test(query);
    const pageIndex = normalizedLabels.findIndex(
      (label) => label === `page ${number}`
    );
    if (pageIndex >= 0) {
      return pageIndex;
    }
    const pagePrefixIndex = normalizedLabels.findIndex((label) =>
      new RegExp(`^page ${number}(?![0-9])`).test(label)
    );
    if (pagePrefixIndex >= 0) {
      return pagePrefixIndex;
    }
    if (explicitPage) {
      return null;
    }
    // "3" on a heading-based document: "Part 3", "Section 3", "3. Title", "3 Title".
    const keywordIndex = normalizedLabels.findIndex((label) =>
      new RegExp(`^(?:[a-z]+ )?${number}(?![0-9.])`).test(label)
    );
    if (keywordIndex >= 0 && /^\d+$/.test(query)) {
      return keywordIndex;
    }
  }

  const queryTokens = tokenizeSectionRequest(query);
  if (queryTokens.length === 0) {
    return null;
  }

  // Heading fragment: the shortest label that contains the whole request.
  let containing: number | null = null;
  normalizedLabels.forEach((label, index) => {
    if (!label.includes(query)) {
      return;
    }
    if (containing === null || label.length < normalizedLabels[containing]!.length) {
      containing = index;
    }
  });
  if (containing !== null) {
    return containing;
  }

  // Word overlap: every request word present, else most of them.
  let best: { index: number; ratio: number } | null = null;
  normalizedLabels.forEach((label, index) => {
    const labelTokens = new Set(tokenizeSectionRequest(label));
    if (labelTokens.size === 0) {
      return;
    }
    const matched = queryTokens.filter((token) => labelTokens.has(token)).length;
    const ratio = matched / queryTokens.length;
    if (ratio >= 0.6 && (best === null || ratio > best.ratio)) {
      best = { index, ratio };
    }
  });
  return best ? (best as { index: number }).index : null;
}

/**
 * Collapse consecutive page labels into ranges: ["Page 1", "Page 2", "Page 3",
 * "Appendix A", "Page 9"] → ["Page 1–3", "Appendix A", "Page 9"].
 */
export function compressSectionLabels(labels: string[]): string[] {
  const compressed: string[] = [];
  let runStart: number | null = null;
  let runEnd: number | null = null;

  const flush = (): void => {
    if (runStart === null || runEnd === null) {
      return;
    }
    compressed.push(
      runStart === runEnd ? `Page ${runStart}` : `Page ${runStart}–${runEnd}`
    );
    runStart = null;
    runEnd = null;
  };

  for (const label of labels) {
    const page = label.match(PAGE_LABEL_PATTERN);
    const number = page ? Number(page[1]) : null;
    if (number !== null && runEnd !== null && number === runEnd + 1) {
      runEnd = number;
      continue;
    }
    flush();
    if (number !== null) {
      runStart = number;
      runEnd = number;
      continue;
    }
    compressed.push(label);
  }
  flush();
  return compressed;
}

function formatCharCount(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * Frame a document read for the model: name the source (and the isolated
 * section, if any), list the section outline so the model can target its
 * next read and cite the specific section it draws from ("Lab4.pdf — Part 3:
 * Interrupts"), and spell out what fell outside the window. The UI keeps the
 * raw content; only the model-facing text is framed.
 */
export function buildReadModelText(
  artifact: Pick<ArtifactRef, "title" | "kind"> | undefined,
  content: string,
  view?: DocumentReadView
): string {
  if (!artifact || content.trim().length === 0) {
    return content;
  }

  const resolved =
    view ?? buildDocumentReadView(content, {}, Number.MAX_SAFE_INTEGER);
  const labels = resolved.labels;
  const sourceLabel = resolved.sectionLabel
    ? `[Source: ${artifact.title} (${artifact.kind}) — ${resolved.sectionLabel}]`
    : `[Source: ${artifact.title} (${artifact.kind})]`;
  const header = [sourceLabel];

  if (resolved.unmatchedSection) {
    header.push(
      `No section matching "${resolved.unmatchedSection}" in this document; showing the document from the start instead. Pick one of the sections listed below and call read_file again with it as section.`
    );
  }

  const outline = compressSectionLabels(labels);
  if (labels.length >= 2) {
    const shown = outline.slice(0, MAX_OUTLINE_LABELS);
    const overflow = outline.length - shown.length;
    header.push(
      `Sections in this document: ${shown.join(" | ")}${overflow > 0 ? ` | ... and ${overflow} more (call read_file with section to open any of them)` : ""}.`
    );
  }

  if (resolved.sectionLabel) {
    const index = resolved.sectionIndex ?? labels.indexOf(resolved.sectionLabel);
    const previous = index > 0 ? labels[index - 1] : null;
    const next = index >= 0 && index + 1 < labels.length ? labels[index + 1] : null;
    const neighbours = [
      previous ? `previous: "${previous}"` : null,
      next ? `next: "${next}"` : null,
    ].filter((part): part is string => Boolean(part));
    header.push(
      `Showing only the section "${resolved.sectionLabel}"${index >= 0 ? ` (${index + 1} of ${labels.length})` : ""}${neighbours.length > 0 ? `; ${neighbours.join(", ")}` : ""}. Call read_file again with a different section to read another part, or without section for the document from the start.`
    );
    if (resolved.truncated) {
      header.push(
        `This section alone is longer than ${formatCharCount(MAX_SECTION_TEXT)} characters and was cut off at the end.`
      );
    }
  } else if (resolved.offset !== null) {
    const end = resolved.offset + resolved.content.replace(/\n\[\.\.\.truncated\]$/, "").length;
    header.push(
      `Showing characters ${formatCharCount(resolved.offset)}–${formatCharCount(end)} of ${formatCharCount(resolved.totalLength)} (offset ${resolved.offset}).${resolved.nextOffset !== null ? ` The document continues; call read_file with offset ${resolved.nextOffset} for the next window, or with section to jump to a heading.` : " This window reaches the end of the document."}`
    );
  } else if (resolved.truncated) {
    const omitted = compressSectionLabels(resolved.omittedLabels);
    const firstOmitted = resolved.omittedLabels[0] ?? null;
    const reach = firstOmitted
      ? `Call read_file with section "${firstOmitted}" (or any section named above) to read the rest, or with offset ${resolved.nextOffset} to continue from the cut-off.`
      : `Call read_file with offset ${resolved.nextOffset} to continue from the cut-off, or with section to jump to a heading.`;
    header.push(
      `This read shows the first ${formatCharCount(resolved.nextOffset ?? resolved.content.length)} of ${formatCharCount(resolved.totalLength)} characters${resolved.cutOffInside ? ` and is cut off inside "${resolved.cutOffInside}"` : ""}. Not included in this read: ${omitted.length > 0 ? omitted.join(" | ") : "the remainder of the document"}. ${reach}`
    );
  }

  if (labels.length >= 2) {
    const example = resolved.sectionLabel ?? labels[0]!;
    header.push(
      `When you quote or paraphrase this document, name the section you drew from (e.g. "${artifact.title} — ${example}") so the student can find it.`
    );
  } else if (resolved.sectionLabel) {
    header.push(
      `When you quote or paraphrase this document, attribute it to "${artifact.title} — ${resolved.sectionLabel}".`
    );
  } else {
    header.push(
      `When you quote or paraphrase this document, attribute it to "${artifact.title}".`
    );
  }
  return `${header.join("\n")}\n---\n${content}`;
}

/**
 * Build the tool result for a document read: the observation carries the
 * windowed text and, for section reads, a section-level artifact ref so the
 * citation is "deck.pdf — Page 57" without any re-attribution pass.
 */
function buildDocumentReadResult(
  tool: "read_file" | "download_course_file",
  artifact: ArtifactRef,
  content: string,
  request: DocumentReadRequest,
  summary?: string
): ToolExecutionResult {
  const view = buildDocumentReadView(content, request);
  const ref: ArtifactRef = view.sectionLabel
    ? {
        ...artifact,
        excerpt: buildArtifactExcerpt(view.content) ?? artifact.excerpt ?? null,
        sectionLabel: view.sectionLabel,
      }
    : artifact;
  const resolvedSummary =
    summary ??
    (view.sectionLabel
      ? `Read ${artifact.title} — ${view.sectionLabel}.`
      : view.offset !== null
        ? `Read ${artifact.title} from offset ${view.offset}.`
        : `Read ${artifact.title}.`);
  return {
    observation: {
      tool,
      status: "ok",
      summary: resolvedSummary,
      artifacts: [ref],
      content: view.content,
    },
    modelText: buildReadModelText(ref, view.content, view),
    uiText: view.content,
  };
}

function normalizeSourceSectionLabel(value: string | null | undefined): string | null {
  const normalized = (value ?? "").trim();
  if (
    normalized.length === 0 ||
    normalized === "Full text" ||
    normalized === "Top"
  ) {
    return null;
  }
  return normalized;
}

function toArtifactRef(artifact: {
  id: string;
  title: string;
  kind: string;
  excerpt: string;
}): ArtifactRef {
  return {
    artifactId: artifact.id,
    title: artifact.title,
    kind: artifact.kind,
    excerpt: artifact.excerpt,
  };
}

function createCourseAttachmentArtifactRef(
  localPath: string,
  originalFilename: string,
  excerpt?: string
): ArtifactRef {
  return {
    artifactId: buildCourseAttachmentArtifactId(localPath, originalFilename),
    title: originalFilename,
    kind: "attachment",
    excerpt: buildArtifactExcerpt(excerpt),
  };
}

function buildCourseAttachmentArtifactId(
  localPath: string,
  originalFilename: string
): string {
  return `course:attachment:${localPath}:${originalFilename}`;
}

async function recoverMissingAttachmentRead(
  artifact: ArtifactRecord | undefined,
  ctx: ChatAgentContext,
  tool: "read_file" | "download_course_file"
): Promise<ToolExecutionResult | null> {
  if (!artifact || artifact.kind !== "attachment" || !ctx.cache) {
    return null;
  }

  const localPath = artifact.metadata.localPath;
  if (typeof localPath !== "string" || localPath.trim().length === 0) {
    return null;
  }

  const cachedAttachment =
    ctx.cache.attachments.find((entry) => entry.localPath === localPath) ?? null;
  const unpackedEntries = await runAttachmentExtraction(
    ctx.cache.coursePath,
    cachedAttachment
  );
  if (unpackedEntries.length > 0) {
    await persistCourseAttachmentUpdates(ctx.cache);
  } else {
    clearArtifactIndexCache();
  }

  const extracted = await readExtractedSidecar(
    ctx.cache.coursePath,
    localPath
  );
  if (extracted) {
    return buildDocumentReadResult(
      tool,
      createCourseAttachmentArtifactRef(localPath, artifact.title, extracted),
      extracted,
      {},
      `Recovered text from local attachment ${artifact.title}.`
    );
  }

  if (unpackedEntries.length > 0) {
    const summary = `Unpacked ${artifact.title} (${unpackedEntries.length} inner files). Call read_file on a specific inner file by name.`;
    return {
      observation: {
        tool,
        status: "ok",
        summary,
        artifacts: [
          createCourseAttachmentArtifactRef(localPath, artifact.title),
        ],
      },
      modelText: summary,
      uiText: summary,
    };
  }

  return null;
}

async function reuseCachedAttachmentContent(
  coursePath: string,
  loaded: LoadedWorkspace,
  cache: ChatAgentContext["cache"],
  localPath: string,
  originalFilename: string
): Promise<ToolExecutionResult | null> {
  if (!cache) {
    return null;
  }
  const cachedArtifactId = buildCourseAttachmentArtifactId(
    localPath,
    originalFilename
  );
  const cachedRead = await readWorkspaceKnowledgeArtifactById(
    loaded,
    cache,
    cachedArtifactId,
    Number.MAX_SAFE_INTEGER
  );
  if (cachedRead.status === "ok") {
    return buildDocumentReadResult(
      "download_course_file",
      toArtifactRef(cachedRead.artifact),
      cachedRead.content,
      {},
      `Reused cached text for ${cachedRead.artifact.title}.`
    );
  }

  const cachedAttachment =
    cache.attachments.find((entry) => entry.localPath === localPath) ?? null;
  const unpackedEntries = await runAttachmentExtraction(
    coursePath,
    cachedAttachment
  );
  if (unpackedEntries.length > 0) {
    await persistCourseAttachmentUpdates(cache);
  } else {
    clearArtifactIndexCache();
  }

  const extracted = await readExtractedSidecar(coursePath, localPath);
  if (extracted) {
    return buildDocumentReadResult(
      "download_course_file",
      createCourseAttachmentArtifactRef(localPath, originalFilename, extracted),
      extracted,
      {},
      `Recovered text from previously downloaded ${originalFilename}.`
    );
  }

  if (unpackedEntries.length > 0) {
    const summary = `Unpacked ${originalFilename} (${unpackedEntries.length} inner files). The zip itself has no text body; call read_file on a specific inner file by name.`;
    return {
      observation: {
        tool: "download_course_file",
        status: "ok",
        summary,
        artifacts: [
          createCourseAttachmentArtifactRef(localPath, originalFilename),
        ],
      },
      modelText: summary,
      uiText: summary,
    };
  }

  return null;
}

/**
 * Run the shared ingestion-style extraction pipeline on a single attachment.
 * Handles text sidecar extraction and, for zips, per-entry unpack. Returns
 * the zip entries that were unpacked (empty array for non-zips or when the
 * attachment is missing). Falls back to just the sidecar if no attachment
 * entry exists yet (e.g. a pre-cache backfill path).
 */
async function runAttachmentExtraction(
  coursePath: string,
  attachment: DownloadedAttachmentEntry | null
): Promise<Array<{ filename: string }>> {
  if (!attachment) return [];
  try {
    await extractSingleAttachment(coursePath, attachment);
  } catch {
    return [];
  }
  return attachment.zipEntries ?? [];
}

async function readExtractedSidecar(
  coursePath: string,
  localPath: string
): Promise<string | null> {
  const sidecar = getExtractedAttachmentPath(coursePath, localPath);
  try {
    const content = await fs.readFile(sidecar, "utf-8");
    return isReadableExtractedText(content) ? content : null;
  } catch {
    return null;
  }
}

function renderWorkspaceArtifactLookupFailure(
  filename: string,
  result: Awaited<ReturnType<typeof readWorkspaceKnowledgeArtifact>>
): string {
  switch (result.status) {
    case "missing_text":
      if (!result.artifact) {
        return `File "${filename}" was indexed, but the readable text is missing. Refresh the workspace or course cache to rebuild it.`;
      }
      return result.artifact.scope === "course"
        ? `Matched ${result.artifact.title}, but the cached extracted text is missing. Refresh the course cache to rebuild it.`
        : `Matched ${result.artifact.title}, but the workspace text is missing. Rebuild or refresh the workspace to restore it.`;
    case "empty_query":
      return "Provide a file name to read from the workspace or course cache.";
    case "ok":
    case "not_found":
    default:
      return `File "${filename}" not found. Use list_files to see available files.`;
  }
}

function isReadableExtractedText(value: string | null | undefined): value is string {
  return Boolean(value && !value.startsWith("[") && value.trim().length > 0);
}

function findReusableReadObservation(
  filename: string,
  observations: ChatAgentContext["runState"]["observations"]
): ChatAgentContext["runState"]["observations"][number] | null {
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const observation = observations[index]!;
    if (!isGroundedContentObservation(observation)) {
      continue;
    }

    // A section/offset read is only a window onto the document; it must not
    // stand in for a whole-document read.
    if (isPartialReadObservation(observation)) {
      continue;
    }

    const matches = observation.artifacts.some(
      (artifact) => scoreFileLookupMatch(filename, artifact.title) > 0
    );

    if (matches) {
      return observation;
    }
  }

  return null;
}

function isPartialReadObservation(observation: {
  artifacts: ArtifactRef[];
}): boolean {
  return observation.artifacts.some((artifact) =>
    Boolean(artifact.sectionLabel)
  );
}

function buildSemanticTurnToolAliasKeys(
  name: string,
  input: Record<string, unknown>
): string[] {
  if (
    name === "search_workspace" ||
    name === "search_course" ||
    name === "open_resource" ||
    name === "open_lecture"
  ) {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    return [...buildSemanticSearchAliases(query)].map(
      (alias) => `semantic:${name}:${alias}`
    );
  }

  const target = getSemanticReuseTarget(name, input);
  if (!target) {
    return [];
  }

  return [...buildSemanticLookupAliases(target)].map(
    (alias) => `semantic:${name}:${alias}`
  );
}

function buildWorkspaceSearchGuidance(
  matches: Array<{ artifact: ArtifactRecord }>
): string {
  const readableTitles = [...new Set(
    matches
      .map((match) => match.artifact.title.trim())
      .filter((title) => title.length > 0)
  )].slice(0, 3);

  const guidance = [
    "These search results are discovery breadcrumbs only; the snippets may be incomplete.",
    "If the student wants exact wording, requirements, quotes, or an in-depth explanation, call read_file on the best matching source before answering.",
  ];

  if (readableTitles.length === 1) {
    guidance.push(`Best next step: call read_file with "${readableTitles[0]}".`);
  } else if (readableTitles.length > 1) {
    guidance.push(
      `Best next step: call read_file on the strongest match, such as ${joinQuotedTitles(readableTitles)}.`
    );
  }

  return guidance.join(" ");
}

function buildCourseSearchGuidance(
  matches: Array<{ artifact: ArtifactRecord }>,
  canDownloadCourseFile: boolean
): string {
  const readableTitles = [...new Set(
    matches
      .filter((match) => isReadableCourseArtifactKind(match.artifact.kind))
      .map((match) => match.artifact.title.trim())
      .filter((title) => title.length > 0)
  )].slice(0, 3);
  const downloadableTitles = [...new Set(
    matches
      .filter((match) => match.artifact.kind === "file")
      .map((match) => match.artifact.title.trim())
      .filter((title) => title.length > 0)
  )].slice(0, 2);

  const guidance = [
    "These course results are discovery breadcrumbs only; they are not the full source text.",
    "For exact wording, requirements, quotes, or in-depth explanations, do not answer from these snippets alone.",
  ];

  if (readableTitles.length === 1) {
    guidance.push(`Best next step: call read_file with "${readableTitles[0]}".`);
  } else if (readableTitles.length > 1) {
    guidance.push(
      `Best next step: call read_file on the strongest readable match, such as ${joinQuotedTitles(readableTitles)}.`
    );
  }

  if (canDownloadCourseFile && downloadableTitles.length === 1) {
    guidance.push(
      `If the key result is an undownloaded course file, call download_course_file with "${downloadableTitles[0]}".`
    );
  } else if (canDownloadCourseFile && downloadableTitles.length > 1) {
    guidance.push(
      `If the key result is an undownloaded course file, call download_course_file with the best file title, such as ${joinQuotedTitles(downloadableTitles)}.`
    );
  }

  return guidance.join(" ");
}

function isReadableCourseArtifactKind(kind: string): boolean {
  return (
    kind === "assignment" ||
    kind === "page" ||
    kind === "announcement" ||
    kind === "discussion" ||
    kind === "attachment" ||
    kind === "syllabus" ||
    kind === "front_page"
  );
}

function joinQuotedTitles(titles: string[]): string {
  if (titles.length === 0) {
    return "";
  }

  if (titles.length === 1) {
    return `"${titles[0]}"`;
  }

  if (titles.length === 2) {
    return `"${titles[0]}" or "${titles[1]}"`;
  }

  const head = titles.slice(0, -1).map((title) => `"${title}"`).join(", ");
  const tail = titles[titles.length - 1];
  return `${head}, or "${tail}"`;
}

function findSemanticTurnToolCacheHit(
  turnToolCache: TurnToolCache,
  name: string,
  input: Record<string, unknown>
): ToolExecutionResult | null {
  const requestedTarget = getSemanticReuseTarget(name, input);
  if (!requestedTarget) {
    return null;
  }

  const candidates = [...turnToolCache.values()].reverse();
  for (const candidate of candidates) {
    if (!isSemanticReuseCandidate(name, candidate)) {
      continue;
    }

    const matches = candidate.observation.artifacts.some(
      (artifact) => scoreFileLookupMatch(requestedTarget, artifact.title) > 0
    );
    if (!matches) {
      continue;
    }

    const resolvedTitle = candidate.observation.artifacts[0]?.title ?? requestedTarget;
    return {
      observation: {
        tool: name,
        status: "ok",
        summary: `Reused ${resolvedTitle} from an earlier tool call in this turn.`,
        artifacts: candidate.observation.artifacts,
        content: candidate.observation.content,
      },
      modelText: candidate.modelText,
      uiText: candidate.uiText,
    };
  }

  return null;
}

function getSemanticReuseTarget(
  name: string,
  input: Record<string, unknown>
): string | null {
  switch (name) {
    case "read_file":
      // Windowed reads (section / offset) are never satisfied by a reused
      // whole-document result, which may have been cut off before the window.
      if (isWindowedReadRequest(parseDocumentReadRequest(input))) {
        return null;
      }
      return typeof input.filename === "string" ? input.filename.trim() : null;
    case "download_course_file":
      return typeof input.title === "string" ? input.title.trim() : null;
    default:
      return null;
  }
}

function isSemanticReuseCandidate(
  requestedTool: string,
  candidate: ToolExecutionResult
): boolean {
  if (
    !isGroundedContentObservation(candidate.observation) ||
    isPartialReadObservation(candidate.observation)
  ) {
    return false;
  }

  if (requestedTool === "read_file") {
    return (
      candidate.observation.tool === "read_file" ||
      candidate.observation.tool === "download_course_file"
    );
  }

  if (requestedTool === "download_course_file") {
    return (
      candidate.observation.tool === "download_course_file" ||
      (candidate.observation.tool === "read_file" &&
        candidate.observation.artifacts.some(
          (artifact) => artifact.kind === "attachment"
        ))
    );
  }

  return false;
}

function buildFileLookupAliases(value: string): Set<string> {
  const candidates = new Set<string>();
  const cleaned = value.trim();
  if (!cleaned) {
    return candidates;
  }

  const normalized = normalizeLookupAlias(cleaned);
  if (normalized) {
    candidates.add(normalized);
    addTrimmedExtensionAlias(candidates, normalized);
  }

  const basename = path.basename(cleaned);
  const normalizedBasename = normalizeLookupAlias(basename);
  if (normalizedBasename) {
    candidates.add(normalizedBasename);
    addTrimmedExtensionAlias(candidates, normalizedBasename);
  }

  return candidates;
}

function buildSemanticLookupAliases(value: string): Set<string> {
  const candidates = buildFileLookupAliases(value);
  const cleaned = value.trim();
  if (!cleaned) {
    return candidates;
  }

  addFuzzyLookupAliases(candidates, cleaned);
  const basename = path.basename(cleaned);
  if (basename !== cleaned) {
    addFuzzyLookupAliases(candidates, basename);
  }

  return candidates;
}

function buildSemanticSearchAliases(value: string): Set<string> {
  const normalized = normalizeFuzzyLookupAlias(value);
  if (!normalized) {
    return new Set();
  }

  const sortedTokens = [...new Set(normalized.split(/\s+/).filter(Boolean))]
    .sort()
    .join(" ");
  return sortedTokens ? new Set([sortedTokens]) : new Set();
}

function addFuzzyLookupAliases(target: Set<string>, value: string): void {
  const normalized = normalizeFuzzyLookupAlias(value);
  if (!normalized) {
    return;
  }
  target.add(normalized);
  addTrimmedWordExtensionAlias(target, normalized);
}

function addTrimmedExtensionAlias(target: Set<string>, value: string): void {
  const stripped = value.replace(
    /\.(txt|md|pdf|html|htm|zip|csv|json)$/i,
    ""
  );
  if (stripped && stripped !== value) {
    target.add(stripped);
  }
}

function addTrimmedWordExtensionAlias(target: Set<string>, value: string): void {
  const stripped = value
    .replace(/\b(txt|md|pdf|html|htm|zip|csv|json)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped && stripped !== value) {
    target.add(stripped);
  }
}

function normalizeLookupAlias(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\s+/g, " ").toLowerCase();
}

function scoreFileLookupMatch(query: string, candidateTitle: string): number {
  const queryAliases = buildFileLookupAliases(query);
  const candidateAliases = buildFileLookupAliases(candidateTitle);

  let score = 0;
  for (const alias of queryAliases) {
    if (candidateAliases.has(alias)) {
      score = Math.max(score, alias.includes("/") ? 100 : 80 + alias.length);
    }
  }

  const normalizedQuery = normalizeFuzzyLookupAlias(query);
  const normalizedCandidate = normalizeFuzzyLookupAlias(candidateTitle);
  if (
    normalizedQuery &&
    normalizedCandidate &&
    (normalizedCandidate.includes(normalizedQuery) ||
      normalizedQuery.includes(normalizedCandidate))
  ) {
    score = Math.max(
      score,
      40 + Math.min(normalizedQuery.length, normalizedCandidate.length)
    );
  }

  return score;
}

function normalizeFuzzyLookupAlias(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/[/._-]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ");
}
