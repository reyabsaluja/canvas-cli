import fs from "node:fs/promises";
import path from "node:path";
import type { LoadedWorkspace } from "../../ask/types.js";
import type { ToolExecutionResult, ArtifactRef } from "../../agent/observation.js";
import { isGroundedContentObservation } from "../../agent/observation-relevance.js";
import type { ArtifactRecord } from "../../knowledge/artifact-index.js";
import { clearArtifactIndexCache } from "../../knowledge/artifact-index.js";
import { extractFileText } from "../../extract/extract-text.js";
import { getExtractedAttachmentPath } from "../../enrich/course-documents.js";
import { handleOpenResourceQuery } from "../open-resources.js";
import { handleLectureQuery } from "../lecture-resources.js";
import {
  renderCourseArtifactSearchResult,
  searchCourseKnowledge,
} from "../course-retrieval.js";
import {
  listWorkspaceKnowledgeArtifacts,
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

const MAX_DOC_TEXT = 30000;

async function executeToolCallDetailed(
  name: string,
  input: Record<string, unknown>,
  ctx: ChatAgentContext
): Promise<ToolExecutionResult> {
  switch (name) {
    case "search_workspace":
      return await searchWorkspace(input.query as string, ctx);
    case "read_file":
      return readFile(input.filename as string, ctx);
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
    MAX_DOC_TEXT
  );
  switch (artifact.status) {
    case "ok":
      return {
        observation: {
          tool: "read_file",
          status: "ok",
          summary: `Read ${artifact.artifact.title}.`,
          artifacts: [toArtifactRef(artifact.artifact)],
          content: artifact.content,
        },
        modelText: artifact.content,
        uiText: artifact.content,
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
      })),
    },
    modelText: rendered,
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
      artifacts: filteredResult.matches.map(({ artifact }) => ({
        artifactId: artifact.id,
        title: artifact.title,
        kind: artifact.kind,
        excerpt: artifact.excerpt,
      })),
    },
    modelText: uiText,
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
  ctx: ChatAgentContext
): Promise<ToolExecutionResult> {
  const trimmedFilename = filename.trim();
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

  const reusedObservation = findReusableReadObservation(
    trimmedFilename,
    ctx.runState.observations
  );
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
      modelText: reusedObservation.content ?? "",
      uiText: reusedObservation.content ?? "",
    };
  }

  const artifact = await readWorkspaceKnowledgeArtifact(
    ctx.loaded,
    ctx.cache,
    trimmedFilename,
    MAX_DOC_TEXT
  );
  switch (artifact.status) {
    case "ok":
      return {
        observation: {
          tool: "read_file",
          status: "ok",
          summary: `Read ${artifact.artifact.title}.`,
          artifacts: [toArtifactRef(artifact.artifact)],
          content: artifact.content,
        },
        modelText: artifact.content,
        uiText: artifact.content,
      };
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
  const localPath = path.join(downloadDir, fileMeta.display_name);
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
  const extracted = await extractAndPersistAttachmentText(
    ctx.cache.coursePath,
    relativeLocalPath,
    fileMeta.display_name
  );
  if (extracted) {
    const artifactRef = createCourseAttachmentArtifactRef(
      relativeLocalPath,
      fileMeta.display_name,
      extracted
    );
    return {
      observation: {
        tool: "download_course_file",
        status: "ok",
        summary: `Downloaded and extracted ${fileMeta.display_name}.`,
        artifacts: [artifactRef],
        content: extracted,
      },
      modelText: extracted,
      uiText: extracted,
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
  const result = await handleOpenResourceQuery(query, {
    loaded: ctx.loaded,
    cache: ctx.cache,
  });
  const success = !/No openable resource|Multiple resources matched|Failed to open|missing/i.test(
    result.message
  );
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

  const extracted = await extractAndPersistAttachmentText(
    ctx.cache.coursePath,
    localPath,
    artifact.title
  );
  if (!extracted) {
    return null;
  }

  return {
    observation: {
      tool,
      status: "ok",
      summary: `Recovered text from local attachment ${artifact.title}.`,
      artifacts: [
        createCourseAttachmentArtifactRef(localPath, artifact.title, extracted),
      ],
      content: extracted,
    },
    modelText: extracted,
    uiText: extracted,
  };
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
    MAX_DOC_TEXT
  );
  if (cachedRead.status === "ok") {
    return {
      observation: {
        tool: "download_course_file",
        status: "ok",
        summary: `Reused cached text for ${cachedRead.artifact.title}.`,
        artifacts: [toArtifactRef(cachedRead.artifact)],
        content: cachedRead.content,
      },
      modelText: cachedRead.content,
      uiText: cachedRead.content,
    };
  }

  const extracted = await extractAndPersistAttachmentText(
    coursePath,
    localPath,
    originalFilename
  );
  if (!extracted) {
    return null;
  }

  return {
    observation: {
      tool: "download_course_file",
      status: "ok",
      summary: `Recovered text from previously downloaded ${originalFilename}.`,
      artifacts: [
        createCourseAttachmentArtifactRef(localPath, originalFilename, extracted),
      ],
      content: extracted,
    },
    modelText: extracted,
    uiText: extracted,
  };
}

async function extractAndPersistAttachmentText(
  coursePath: string,
  localPath: string,
  originalFilename: string
): Promise<string | null> {
  const absolutePath = path.join(coursePath, localPath);
  try {
    const extracted = await extractFileText(absolutePath, originalFilename);
    if (!isReadableExtractedText(extracted)) {
      return null;
    }
    const extractedPath = getExtractedAttachmentPath(coursePath, localPath);
    await fs.mkdir(path.dirname(extractedPath), { recursive: true });
    await fs.writeFile(
      extractedPath,
      extracted.endsWith("\n") ? extracted : `${extracted}\n`,
      "utf-8"
    );
    clearArtifactIndexCache();
    return extracted;
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

    const matches = observation.artifacts.some(
      (artifact) => scoreFileLookupMatch(filename, artifact.title) > 0
    );

    if (matches) {
      return observation;
    }
  }

  return null;
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
  if (!isGroundedContentObservation(candidate.observation)) {
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
