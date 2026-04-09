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
  clearArtifactIndexCache,
  type ArtifactRecord,
} from "../knowledge/artifact-index.js";
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
const MAX_TOOL_MEMORY_CHARS = 2400;
const MAX_TOOL_MEMORY_DETAIL_CHARS = 220;

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
  let verificationObservations: Observation[] = [];
  let usedWorkup = false;

  if (retrievalDecision.action === "answer_from_workup") {
    usedWorkup = true;
    fullText = await answerWithoutTools(ctx, systemPrompt, question, [], onTextDelta);
  } else if (retrievalDecision.action === "answer_from_memory") {
    supportingObservations = selectArtifactSupportObservations(
      ctx.runState.observations,
      retrievalDecision.sourceArtifactIds
    );
    verificationObservations = selectSupplementalEvidenceObservations(
      supportingObservations
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
    verificationObservations = supportingObservations;
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
      question,
      ctx.runState
    );
    let toolLoopError: unknown = null;
    try {
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
    } catch (error) {
      toolLoopError = error;
    }
    supportingObservations = ctx.runState.observations.slice(observationStart);
    verificationObservations = resolveToolTurnVerificationObservations(
      ctx.runState.observations,
      observationStart
    );
    if (shouldRecoverFromToolLoop(fullText, verificationObservations)) {
      fullText = await answerWithoutTools(
        ctx,
        systemPrompt,
        question,
        verificationObservations,
        onTextDelta
      );
    } else if (toolLoopError) {
      throw toolLoopError;
    }
  }

  const verification = verifyWorkspaceAnswer({
    question,
    answer: fullText,
    observations: verificationObservations,
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
  question: string,
  runState?: RunState
): ChatAgentConversationEntry[] {
  return trimConversationEntries([
    ...history,
    {
      role: "user",
      content: buildToolPromptQuestion(question, runState),
    },
  ]);
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

function buildToolPromptQuestion(
  question: string,
  runState?: RunState
): string {
  const memory = buildToolRuntimeMemory(runState?.observations ?? []);
  if (!memory) {
    return question;
  }
  return `${question}\n\n${memory}`;
}

function buildToolRuntimeMemory(
  observations: Observation[]
): string {
  if (observations.length === 0) {
    return "";
  }

  const selected = selectToolMemoryObservations(observations);
  if (selected.length === 0) {
    return "";
  }

  const lines = [
    "Previously gathered tool memory (reuse this before calling tools again):",
  ];

  for (const observation of selected) {
    const parts = [
      `- ${observation.tool} [${observation.status}] ${observation.summary}`,
    ];
    const sourceTitles = [...new Set(
      observation.artifacts
        .map((artifact) => artifact.title.trim())
        .filter((title) => title.length > 0)
    )].slice(0, 2);
    if (sourceTitles.length > 0) {
      parts.push(`Sources: ${sourceTitles.join(", ")}`);
    }

    const detail = summarizeObservationDetail(observation);
    if (detail) {
      parts.push(`Key detail: ${detail}`);
    }

    lines.push(parts.join(" "));
  }

  lines.push("Only call a tool if you still need new evidence beyond this memory.");

  const rendered = lines.join("\n");
  if (rendered.length <= MAX_TOOL_MEMORY_CHARS) {
    return rendered;
  }

  return `${rendered.slice(0, MAX_TOOL_MEMORY_CHARS - 3).trimEnd()}...`;
}

function selectToolMemoryObservations(
  observations: Observation[]
): Observation[] {
  const selected = selectSupplementalEvidenceObservations(observations);
  if (selected.length === 0) {
    return [];
  }

  const recentFailures = selectRecentFailedToolObservations(observations);
  if (recentFailures.length === 0) {
    return selected;
  }

  const combined = [...selected];
  for (const observation of recentFailures) {
    if (!combined.includes(observation)) {
      combined.push(observation);
    }
  }
  return combined;
}

function selectRecentFailedToolObservations(
  observations: Observation[]
): Observation[] {
  return observations.filter((observation) => observation.status !== "ok").slice(-2);
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

  const semanticCached = findSemanticTurnToolCacheHit(turnToolCache, name, input);
  if (semanticCached) {
    return { result: semanticCached, deduped: true };
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

  const supplementalObservations = selectSupplementalEvidenceObservations(observations);
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
  const grounded = observations.filter((observation) =>
    isGroundedContentObservation(observation)
  );
  const candidates = grounded.length > 0 ? grounded : observations;

  if (candidates.length <= 3) {
    return candidates;
  }

  return candidates.slice(-3);
}

export function resolveToolTurnVerificationObservations(
  observations: Observation[],
  observationStart: number
): Observation[] {
  const currentTurn = observations.slice(observationStart);
  if (currentTurn.length === 0) {
    return selectSupplementalEvidenceObservations(observations);
  }

  if (currentTurn.some((observation) => isGroundedContentObservation(observation))) {
    return currentTurn;
  }

  const priorSupport = selectSupplementalEvidenceObservations(
    observations.slice(0, observationStart)
  );
  if (priorSupport.length === 0) {
    return currentTurn;
  }

  return [...priorSupport, ...currentTurn];
}

export function shouldRecoverFromToolLoop(
  answer: string,
  observations: Observation[]
): boolean {
  if (answer.trim().length > 0) {
    return false;
  }

  return observations.some(
    (observation) =>
      isGroundedContentObservation(observation) ||
      observation.artifacts.length > 0 ||
      (typeof observation.content === "string" &&
        observation.content.trim().length > 0)
  );
}

export function selectArtifactSupportObservations(
  observations: Observation[],
  artifactIds: string[]
): Observation[] {
  const uniqueArtifactIds = [...new Set(artifactIds)];
  const selected: Observation[] = [];

  for (const artifactId of uniqueArtifactIds) {
    const best = findBestObservationForArtifact(observations, artifactId);
    if (best) {
      selected.push(best);
    }
  }

  return selected;
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

function summarizeObservationDetail(
  observation: Observation
): string | null {
  const fromExcerpt = observation.artifacts
    .map((artifact) => cleanInlineText(artifact.excerpt))
    .find((excerpt) => excerpt.length > 0);
  const detail = cleanInlineText(observation.content) || fromExcerpt;
  if (!detail) {
    return null;
  }
  if (detail.length <= MAX_TOOL_MEMORY_DETAIL_CHARS) {
    return detail;
  }
  return `${detail.slice(0, MAX_TOOL_MEMORY_DETAIL_CHARS - 3).trimEnd()}...`;
}

function cleanInlineText(value?: string | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
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
  cache: CourseCache,
  localPath: string,
  originalFilename: string
): Promise<ToolExecutionResult | null> {
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
      extracted.endsWith("\n") ? extracted : extracted + "\n",
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

function buildArtifactExcerpt(value?: string | null): string | null {
  const cleaned = cleanInlineText(value);
  if (!cleaned) {
    return null;
  }
  if (cleaned.length <= 180) {
    return cleaned;
  }
  return `${cleaned.slice(0, 177).trimEnd()}...`;
}

function isGroundedContentObservation(observation: Observation): boolean {
  return (
    observation.status === "ok" &&
    observation.artifacts.length > 0 &&
    typeof observation.content === "string" &&
    observation.content.trim().length > 0
  );
}

function isReadableExtractedText(value: string | null | undefined): value is string {
  return Boolean(value && !value.startsWith("[") && value.trim().length > 0);
}

function findReusableReadObservation(
  filename: string,
  observations: Observation[]
): Observation | null {
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const observation = observations[index]!;
    if (!isGroundedContentObservation(observation)) {
      continue;
    }

    const matches = observation.artifacts.some((artifact) =>
      scoreFileLookupMatch(filename, artifact.title) > 0
    );

    if (matches) {
      return observation;
    }
  }

  return null;
}

function findBestObservationForArtifact(
  observations: Observation[],
  artifactId: string
): Observation | null {
  let fallback: Observation | null = null;

  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const observation = observations[index]!;
    if (
      !observation.artifacts.some((artifact) => artifact.artifactId === artifactId)
    ) {
      continue;
    }

    if (!fallback) {
      fallback = observation;
    }

    if (isGroundedContentObservation(observation)) {
      return observation;
    }
  }

  return fallback;
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

function addTrimmedExtensionAlias(target: Set<string>, value: string): void {
  const stripped = value.replace(
    /\.(txt|md|pdf|html|htm|zip|csv|json)$/i,
    ""
  );
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
    score = Math.max(score, 40 + Math.min(normalizedQuery.length, normalizedCandidate.length));
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
