import fs from "node:fs/promises";
import path from "node:path";
import type { LoadedWorkspace } from "../ask/types.js";
import type { CourseCache } from "../enrich/cache-loader.js";
import { getExtractedAttachmentPath } from "../enrich/course-documents.js";
import type { CanvasClient } from "../canvas/client.js";
import type { Config } from "../config/env.js";
import type { WorkspaceAnswer } from "../ask/types.js";
import {
  callModel,
  streamWithTools,
  type AIProviderConfig,
  type ToolDefinition,
} from "../ai/provider.js";
import type {
  Observation,
  ToolExecutionResult,
  ArtifactRef,
} from "../agent/observation.js";
import {
  appendObservation,
  type RunState,
} from "../agent/run-state.js";
import { decideWorkspaceRetrieval } from "../agent/retrieval-gate.js";
import { verifyWorkspaceAnswer } from "../agent/verify.js";
import { extractFileText } from "../extract/extract-text.js";
import { handleOpenResourceQuery } from "./open-resources.js";
import {
  renderCourseArtifactSearchResult,
  searchCourseKnowledge,
} from "./course-retrieval.js";
import {
  listWorkspaceKnowledgeArtifacts,
  readWorkspaceKnowledgeArtifact,
  readWorkspaceKnowledgeArtifactById,
  registerDownloadedCourseAttachment,
  searchWorkspaceKnowledge,
} from "./workspace-knowledge.js";

const MAX_DOC_TEXT = 30000;
const MAX_CONVERSATION_MESSAGES = 12;
const MAX_CONVERSATION_CHARS = 80000;

const CHAT_TOOLS: ToolDefinition[] = [
  {
    name: "search_workspace",
    description: "Search the workspace for content relevant to a query. Returns the most relevant sections from assignment.md, workup.json, plan.md, and extracted documents.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
  {
    name: "read_file",
    description: "Read a file from the workspace or ingested course cache. Supports PDFs, text, HTML, ZIP. Use for reading extracted documents, assignment files, or downloaded course materials.",
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Filename to read (e.g. 'lab4.pdf', 'assignment.md', 'lab4.zip')" },
      },
      required: ["filename"],
    },
  },
  {
    name: "list_files",
    description: "List all available files in the workspace and course cache (extracted docs, downloaded attachments, workspace files).",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "search_course",
    description: "Search the course structure — modules, module items, and file index. Use when you need to find specific course materials, documents, or content not in the workspace.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keyword to match against module names, item titles, and file names" },
      },
      required: ["query"],
    },
  },
  {
    name: "download_course_file",
    description: "Download a file from the Canvas course by module item title. Use when you find a file via search_course that hasn't been downloaded yet.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Module item title of the file to download" },
      },
      required: ["title"],
    },
  },
  {
    name: "open_resource",
    description: "Open a workspace or course resource on the user's machine. Use this when the user explicitly asks to open a PDF, file, page, assignment, or resource.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Resource name or description to open" },
      },
      required: ["query"],
    },
  },
];

function buildSystemPrompt(ctx: ChatAgentContext): string {
  const parts: string[] = [];

  parts.push(`You are a workspace assistant for a university assignment. You help students understand their assignments.

You already have a detailed workup of this assignment pre-loaded below. For most questions, you can answer directly from this context WITHOUT using tools.

Use tools ONLY when:
- The question asks about something not covered in the workup
- You need to read a specific document in detail
- You need to find information not already summarized

IMPORTANT tool usage rules:
- If you already read a file earlier in this conversation, DO NOT read it again. Use the content from the earlier read.
- read_file returns the FULL content of the file. After reading, IMMEDIATELY use that content to answer in detail.
- If a file is inside a zip (e.g., lab4.pdf inside lab4.zip), use read_file with the PDF name — it extracts the content from the zip.
- If the user explicitly asks you to open a file, PDF, assignment page, or resource, immediately call open_resource.
- After reading a file, give a DETAILED and SPECIFIC answer based on what you read. Do not give vague summaries.
- When the user asks to "explain part X in depth", find the specific section in the document and quote the actual requirements, addresses, functionality needed, etc.
- Do NOT re-read files you already have in the conversation. Just reference the earlier content.

Rules:
- When the user asks for detail or "in depth", give thorough answers with specific requirements, addresses, values, and steps from the documents.
- If the workup already contains the answer, respond immediately (no tool calls needed).
- Cite sources when relevant.
- Do NOT solve the assignment — help the student understand it.
- For simple questions, keep it brief. For "explain" or "in depth" questions, be thorough and specific.

IMPORTANT: Before calling any tool, ALWAYS write a brief sentence explaining what you're about to do. For example, write "Let me read the lab document..." before calling read_file, or "Searching for that..." before calling search_workspace. This sentence must come BEFORE the tool call, not after. The student needs to see your thought process in real-time.

When you have enough information, respond with your answer directly (no tool calls).`);

  if (ctx.loaded.workupJson) {
    const w = ctx.loaded.workupJson;
    parts.push("\n--- PRE-LOADED ASSIGNMENT CONTEXT ---\n");

    if (w.overview) parts.push(`Overview: ${w.overview}`);

    const deliverables = (w.deliverables ?? w.deliverables) as string[] | undefined;
    if (deliverables?.length) {
      parts.push(`\nDeliverables:\n${deliverables.map((d: string) => `- ${d}`).join("\n")}`);
    }

    const constraints = w.constraints as string[] | undefined;
    if (constraints?.length) {
      parts.push(`\nConstraints:\n${constraints.map((c: string) => `- ${c}`).join("\n")}`);
    }

    const plan = (w.actionPlan ?? w.action_plan) as any[] | undefined;
    if (plan?.length) {
      parts.push(`\nAction plan:\n${plan.map((s: any) => `${s.step}. ${s.action}${s.detail ? " — " + s.detail : ""}`).join("\n")}`);
    }

    const resources = (w.relevantResources ?? w.relevant_resources) as any[] | undefined;
    if (resources?.length) {
      parts.push(`\nKey resources:\n${resources.map((r: any) => `- ${r.title} (${r.type}) — ${r.why}`).join("\n")}`);
    }

    const trace = (w.sourceTrace ?? w.source_trace) as any[] | undefined;
    if (trace?.length) {
      parts.push(`\nSource trace:\n${trace.map((e: any) => `- ${e.conclusion} [source: ${e.source}]`).join("\n")}`);
    }

    const uncertainties = w.uncertainties as string[] | undefined;
    if (uncertainties?.length) {
      parts.push(`\nOpen questions:\n${uncertainties.map((u: string) => `- ${u}`).join("\n")}`);
    }

    if (w.dueDate ?? w.due_date) {
      parts.push(`\nDue date: ${w.dueDate ?? w.due_date}`);
    }

    parts.push("\n--- END PRE-LOADED CONTEXT ---");
  }

  if (ctx.loaded.extractedFiles.length > 0) {
    parts.push(`\nExtracted documents available (use read_file to access):`);
    for (const ef of ctx.loaded.extractedFiles) {
      const isZip = ef.name.endsWith(".zip.txt");
      const hint = isZip ? " (contains extracted files — PDFs inside are readable)" : "";
      parts.push(`- ${ef.name}${hint}`);
    }
  }

  return parts.join("\n");
}

export interface ChatAgentContext {
  aiConfig: AIProviderConfig;
  loaded: LoadedWorkspace;
  cache: CourseCache | null;
  client: CanvasClient | null;
  config: Config | null;
  courseId: number | null;
  /** Persistent conversation history for multi-turn context. */
  conversationHistory: ChatAgentConversationEntry[];
  /** Minimal serialized working memory for grounding and retrieval gating. */
  runState: RunState;
}

export interface ChatAgentConversationEntry {
  role: string;
  content: string;
}

export interface ChatAgentExtraContext {
  cache: CourseCache | null;
  client: CanvasClient | null;
  config: Config | null;
  courseId: number | null;
}

export interface ToolCallEvent {
  action: string;
  target: string;
  result: string;
  color: "green" | "red";
  observation?: Observation;
}

type ConversationEntry = ChatAgentContext["conversationHistory"][number];
type ConversationTurn = [ConversationEntry, ConversationEntry];
type TurnToolCache = Map<string, ToolExecutionResult>;

export interface TurnToolExecutionResult {
  result: ToolExecutionResult;
  deduped: boolean;
}

function mapToolCall(
  name: string,
  input: Record<string, unknown>
): { action: string; target: string; color: "green" | "red" } {
  switch (name) {
    case "read_file":
      return { action: "read", target: (input.filename as string) ?? "file", color: "green" };
    case "search_workspace":
      return { action: "search", target: (input.query as string) ?? "workspace", color: "green" };
    case "search_course":
      return { action: "search", target: (input.query as string) ?? "course", color: "green" };
    case "list_files":
      return { action: "list", target: "files", color: "green" };
    case "download_course_file":
      return { action: "download", target: (input.title as string) ?? "file", color: "green" };
    case "open_resource":
      return { action: "open", target: (input.query as string) ?? "resource", color: "green" };
    default:
      return { action: name, target: "", color: "green" };
  }
}

/**
 * Run the chat agent using the AI SDK's built-in tool loop.
 * Maintains conversation history across calls for multi-turn context.
 */
/**
 * Run the chat agent with streaming text output.
 * Tool calls fire onToolCall. The final text streams via onTextDelta.
 */
export async function runChatAgent(
  ctx: ChatAgentContext,
  question: string,
  onToolCall: (event: ToolCallEvent) => void,
  onTextDelta?: (delta: string) => void
): Promise<WorkspaceAnswer> {
  const systemPrompt = buildSystemPrompt(ctx);

  const observationStart = ctx.runState.observations.length;
  const retrievalDecision = await decideWorkspaceRetrieval({
    question,
    runState: ctx.runState,
    loaded: ctx.loaded,
    cache: ctx.cache,
  });

  let fullText = "";
  let supportingObservations: Observation[] = [];
  let usedWorkup = false;

  if (retrievalDecision.action === "answer_from_workup") {
    usedWorkup = true;
    fullText = await answerWithoutTools(ctx, systemPrompt, question, [], onTextDelta);
  } else if (retrievalDecision.action === "answer_from_memory") {
    supportingObservations = findObservationsForArtifacts(
      ctx.runState.observations,
      retrievalDecision.sourceArtifactIds
    );
    fullText = await answerWithoutTools(
      ctx,
      systemPrompt,
      question,
      supportingObservations,
      onTextDelta
    );
  } else if (retrievalDecision.action === "read_artifact") {
    const toolResult = await readArtifactForGate(retrievalDecision.artifactId, ctx);
    appendObservation(ctx.runState, toolResult.observation);
    supportingObservations = [toolResult.observation];
    const { action, target } = mapToolCall("read_file", {
      filename: toolResult.observation.artifacts[0]?.title ?? retrievalDecision.artifactId,
    });
    onToolCall({
      action,
      target,
      result: toolResult.uiText,
      color: toolResult.observation.status === "ok" ? "green" : "red",
      observation: toolResult.observation,
    });
    fullText = await answerWithoutTools(
      ctx,
      systemPrompt,
      question,
      supportingObservations,
      onTextDelta
    );
  } else {
    const pendingToolResults: ToolExecutionResult[] = [];
    const turnToolCache: TurnToolCache = new Map();
    const promptMessages = buildToolPromptMessages(
      ctx.conversationHistory,
      question
    );
    fullText = await streamWithTools(
      ctx.aiConfig,
      systemPrompt,
      promptMessages,
      CHAT_TOOLS,
      async (name, input) => {
        const execution = await executeToolCallForTurn(
          turnToolCache,
          name,
          input,
          ctx
        );
        pendingToolResults.push(execution.result);
        if (!execution.deduped) {
          appendObservation(ctx.runState, execution.result.observation);
        }
        return execution.result.modelText;
      },
      {
        onToolCall: (name, input, toolResult) => {
          const { action, target, color } = mapToolCall(name, input);
          const detailed = pendingToolResults.shift();
          const observation = detailed?.observation;
          onToolCall({
            action,
            target,
            result: detailed?.uiText ?? toolResult,
            color: observation?.status === "ok" ? color : "red",
            observation,
          });
        },
        onTextDelta,
      },
      10
    );
    supportingObservations = ctx.runState.observations.slice(observationStart);
  }

  const verification = verifyWorkspaceAnswer({
    answer: fullText,
    observations: supportingObservations,
    usedWorkup,
    loaded: ctx.loaded,
  });
  const finalAnswer = finalizeAnswerText(fullText, verification.missing);

  ctx.conversationHistory.push({ role: "user", content: question });
  ctx.conversationHistory.push({ role: "assistant", content: finalAnswer });
  trimConversationHistory(ctx);

  return {
    question,
    answer: finalAnswer,
    bulletPoints: [],
    sources: verification.sources,
    confidence: verification.confidence,
  };
}

function trimConversationHistory(ctx: ChatAgentContext): void {
  ctx.conversationHistory = trimConversationEntries(ctx.conversationHistory);
}

export function buildToolPromptMessages(
  history: ChatAgentConversationEntry[],
  question: string
): ChatAgentConversationEntry[] {
  return trimConversationEntries([...history, { role: "user", content: question }]);
}

function trimConversationEntries(
  history: ConversationEntry[]
): ConversationEntry[] {
  const { turns, pendingUser } = normalizeConversationHistory(history);

  while (conversationMessageCount(turns, pendingUser) > MAX_CONVERSATION_MESSAGES) {
    turns.shift();
  }

  let totalChars = conversationCharCount(turns, pendingUser);
  while (totalChars > MAX_CONVERSATION_CHARS && turns.length > 0) {
    const removedTurn = turns.shift();
    if (!removedTurn) {
      break;
    }
    totalChars -= removedTurn[0].content.length + removedTurn[1].content.length;
  }

  return flattenConversationHistory(turns, pendingUser);
}

function normalizeConversationHistory(
  history: ConversationEntry[]
): { turns: ConversationTurn[]; pendingUser?: ConversationEntry } {
  const turns: ConversationTurn[] = [];
  let pendingUser: ConversationEntry | undefined;

  for (const entry of history) {
    if (entry.role === "user") {
      pendingUser = entry;
      continue;
    }

    if (entry.role === "assistant" && pendingUser) {
      turns.push([pendingUser, entry]);
      pendingUser = undefined;
    }
  }

  return { turns, pendingUser };
}

function flattenConversationHistory(
  turns: ConversationTurn[],
  pendingUser?: ConversationEntry
): ConversationEntry[] {
  const history = turns.flatMap(([user, assistant]) => [user, assistant]);
  if (pendingUser) {
    history.push(pendingUser);
  }
  return history;
}

function conversationMessageCount(
  turns: ConversationTurn[],
  pendingUser?: ConversationEntry
): number {
  return turns.length * 2 + (pendingUser ? 1 : 0);
}

function conversationCharCount(
  turns: ConversationTurn[],
  pendingUser?: ConversationEntry
): number {
  return turns.reduce(
    (sum, [user, assistant]) => sum + user.content.length + assistant.content.length,
    pendingUser?.content.length ?? 0
  );
}

// --- Tool execution ---

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

  // Keep dedupe scoped to a single chat turn so we avoid repeated local reads
  // and searches without changing any cross-turn grounding behavior.
  const result = await executeToolCallDetailed(name, input, ctx);
  turnToolCache.set(cacheKey, result);
  return { result, deduped: false };
}

export function buildTurnToolCacheKey(
  name: string,
  input: Record<string, unknown>
): string {
  return `${name}:${normalizeToolInput(input)}`;
}

async function searchWorkspace(
  query: string,
  ctx: ChatAgentContext
): Promise<ToolExecutionResult> {
  const relevant = await searchWorkspaceKnowledge(ctx.loaded, ctx.cache, query, 5);
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
  const uiText = renderCourseArtifactSearchResult(result, query);
  if (result.status !== "ok") {
    return {
      observation: {
        tool: "search_course",
        status:
          result.status === "not_found" || result.status === "empty_query"
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
      summary: `Found ${result.matches.length} course matches for "${query}".`,
      artifacts: result.matches.map(({ artifact }) => ({
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

async function readFile(
  filename: string,
  ctx: ChatAgentContext
): Promise<ToolExecutionResult> {
  const artifact = await readWorkspaceKnowledgeArtifact(
    ctx.loaded,
    ctx.cache,
    filename,
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
    case "missing_text":
      return {
        observation: {
          tool: "read_file",
          status: "missing_text",
          summary: renderWorkspaceArtifactLookupFailure(filename, artifact),
          artifacts: artifact.artifact ? [toArtifactRef(artifact.artifact)] : [],
        },
        modelText: renderWorkspaceArtifactLookupFailure(filename, artifact),
        uiText: renderWorkspaceArtifactLookupFailure(filename, artifact),
      };
    case "not_found":
    default:
      return {
        observation: {
          tool: "read_file",
          status: "not_found",
          summary: `File "${filename}" not found. Use list_files to see available files.`,
          artifacts: [],
        },
        modelText: `File "${filename}" not found. Use list_files to see available files.`,
        uiText: `File "${filename}" not found. Use list_files to see available files.`,
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
  if (!ctx.cache || !ctx.client) {
    return {
      observation: {
        tool: "download_course_file",
        status: "error",
        summary: "Cannot download files — no course cache or Canvas client available.",
        artifacts: [],
      },
      modelText: "Cannot download files — no course cache or Canvas client available.",
      uiText: "Cannot download files — no course cache or Canvas client available.",
    };
  }
  const q = title.toLowerCase();
  let foundItem = null;
  for (const mod of ctx.cache.modules) {
    for (const item of mod.items) {
      if (item.type === "File" && item.title.toLowerCase().includes(q)) { foundItem = item; break; }
    }
    if (foundItem) break;
  }
  if (!foundItem || !foundItem.contentId) {
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
  try {
    const extracted = await extractFileText(localPath, fileMeta.display_name);
    if (extracted && !extracted.startsWith("[") && extracted.trim().length > 0) {
      const extractedPath = getExtractedAttachmentPath(
        ctx.cache.coursePath,
        relativeLocalPath
      );
      await fs.mkdir(path.dirname(extractedPath), { recursive: true });
      await fs.writeFile(
        extractedPath,
        extracted.endsWith("\n") ? extracted : extracted + "\n",
        "utf-8"
      );
      return {
        observation: {
          tool: "download_course_file",
          status: "ok",
          summary: `Downloaded and extracted ${fileMeta.display_name}.`,
          artifacts: [],
          content: extracted,
        },
        modelText: extracted,
        uiText: extracted,
      };
    }
  } catch {
    // Fall through to a guidance message below.
  }
  const message = `Downloaded "${fileMeta.display_name}", but extracted text is not available yet. Refresh the course cache to rebuild it.`;
  return {
    observation: {
      tool: "download_course_file",
      status: "missing_text",
      summary: message,
      artifacts: [],
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

async function readArtifactForGate(
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
    case "missing_text":
      return {
        observation: {
          tool: "read_file",
          status: "missing_text",
          summary: `Matched ${artifact.artifact?.title ?? artifactId}, but readable text is missing.`,
          artifacts: artifact.artifact ? [toArtifactRef(artifact.artifact)] : [],
        },
        modelText: `Matched ${artifact.artifact?.title ?? artifactId}, but readable text is missing.`,
        uiText: `Matched ${artifact.artifact?.title ?? artifactId}, but readable text is missing.`,
      };
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

async function answerWithoutTools(
  ctx: ChatAgentContext,
  systemPrompt: string,
  question: string,
  observations: Observation[],
  onTextDelta?: (delta: string) => void
): Promise<string> {
  const userMessage = buildEvidenceBackedQuestion(question, observations);
  const answer = await callModel(
    ctx.aiConfig,
    `${systemPrompt}\n\nNo tools are available for this turn. Answer only from the pre-loaded assignment context and any supplemental evidence provided in the user message.`,
    buildConversationPrompt(ctx.conversationHistory, userMessage)
  );
  if (answer && onTextDelta) {
    onTextDelta(answer);
  }
  return answer;
}

function buildConversationPrompt(
  history: ChatAgentConversationEntry[],
  userMessage: string
): string {
  const sections: string[] = [];
  if (history.length > 0) {
    sections.push("Conversation so far:");
    for (const entry of history.slice(-6)) {
      sections.push(`${entry.role.toUpperCase()}: ${entry.content}`);
    }
    sections.push("");
  }
  sections.push(userMessage);
  return sections.join("\n");
}

export function buildEvidenceBackedQuestion(
  question: string,
  observations: Observation[]
): string {
  if (observations.length === 0) {
    return question;
  }

  const supplementalObservations = selectSupplementalEvidenceObservations(
    observations
  );
  const sections: string[] = [question, "", "Supplemental evidence already gathered in this chat:"];
  for (const observation of supplementalObservations) {
    sections.push(`- Tool: ${observation.tool}`);
    sections.push(`  Summary: ${observation.summary}`);
    for (const artifact of observation.artifacts) {
      sections.push(`  Source: [${artifact.kind}] ${artifact.title}`);
    }
    if (observation.content) {
      sections.push(observation.content);
    }
    sections.push("");
  }
  return sections.join("\n");
}

function selectSupplementalEvidenceObservations(
  observations: Observation[]
): Observation[] {
  if (observations.length <= 3) {
    return observations;
  }

  const selected = new Set<number>();
  // Keep the latest successful direct read in prompt context so memory answers
  // still include the underlying text instead of only later search summaries.
  const latestSuccessfulReadIndex = findLatestSuccessfulReadObservationIndex(
    observations
  );

  if (latestSuccessfulReadIndex !== -1) {
    selected.add(latestSuccessfulReadIndex);
  }

  for (let index = observations.length - 1; index >= 0; index -= 1) {
    selected.add(index);
    if (selected.size === 3) {
      break;
    }
  }

  return [...selected]
    .sort((a, b) => a - b)
    .map((index) => observations[index]!);
}

function findLatestSuccessfulReadObservationIndex(
  observations: Observation[]
): number {
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const observation = observations[index]!;
    if (
      observation.tool === "read_file" &&
      observation.status === "ok" &&
      observation.content?.trim()
    ) {
      return index;
    }
  }
  return -1;
}

function findObservationsForArtifacts(
  observations: Observation[],
  artifactIds: string[]
): Observation[] {
  const ids = new Set(artifactIds);
  return observations.filter((observation) =>
    observation.artifacts.some((artifact) => ids.has(artifact.artifactId))
  );
}

function finalizeAnswerText(answer: string, missing: string[]): string {
  const trimmed = answer.trim();
  if (!trimmed) {
    return "I wasn't able to find a clear answer.";
  }
  if (missing.includes("source")) {
    return `${trimmed}\n\nI may be missing an exact source for part of this answer, so treat it as tentative.`;
  }
  return trimmed;
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
