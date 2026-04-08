import fs from "node:fs/promises";
import path from "node:path";
import type { LoadedWorkspace } from "../ask/types.js";
import type { CourseCache } from "../enrich/cache-loader.js";
import { getExtractedAttachmentPath } from "../enrich/course-documents.js";
import type { CanvasClient } from "../canvas/client.js";
import type { Config } from "../config/env.js";
import type { WorkspaceAnswer } from "../ask/types.js";
import {
  streamWithTools,
  type AIProviderConfig,
  type ToolDefinition,
} from "../ai/provider.js";
import { extractFileText } from "../extract/extract-text.js";
import { handleOpenResourceQuery } from "./open-resources.js";
import {
  renderCourseArtifactSearchResult,
  searchCourseKnowledge,
} from "./course-retrieval.js";
import {
  listWorkspaceKnowledgeArtifacts,
  readWorkspaceKnowledgeArtifact,
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
}

type ConversationEntry = ChatAgentContext["conversationHistory"][number];
type ConversationTurn = [ConversationEntry, ConversationEntry];

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

  ctx.conversationHistory.push({ role: "user", content: question });
  trimConversationHistory(ctx);

  const fullText = await streamWithTools(
    ctx.aiConfig,
    systemPrompt,
    ctx.conversationHistory,
    CHAT_TOOLS,
    async (name, input) => executeToolCall(name, input, ctx),
    {
      onToolCall: (name, input, toolResult) => {
        const { action, target, color } = mapToolCall(name, input);
        const nextColor =
          name === "open_resource" &&
          /No openable resource|Multiple resources matched|Failed to open|missing/i.test(
            toolResult
          )
            ? "red"
            : color;
        onToolCall({ action, target, result: toolResult, color: nextColor });
      },
      onTextDelta,
    },
    10
  );

  ctx.conversationHistory.push({ role: "assistant", content: fullText });
  trimConversationHistory(ctx);

  return {
    question,
    answer: fullText || "I wasn't able to find a clear answer.",
    bulletPoints: [],
    sources: [],
    confidence: "medium",
  };
}

function trimConversationHistory(ctx: ChatAgentContext): void {
  const { turns, pendingUser } = normalizeConversationHistory(ctx.conversationHistory);

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

  ctx.conversationHistory.splice(
    0,
    ctx.conversationHistory.length,
    ...flattenConversationHistory(turns, pendingUser)
  );
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

async function executeToolCall(
  name: string,
  input: Record<string, unknown>,
  ctx: ChatAgentContext
): Promise<string> {
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
      return `Unknown tool: ${name}`;
  }
}

async function searchWorkspace(query: string, ctx: ChatAgentContext): Promise<string> {
  const relevant = await searchWorkspaceKnowledge(ctx.loaded, ctx.cache, query, 5);
  if (relevant.length === 0) return "No relevant content found for that query.";
  const results: string[] = [];
  for (const match of relevant) {
    results.push(match.header);
    results.push(match.preview);
    results.push("");
  }
  return results.join("\n");
}

async function searchCourse(
  query: string,
  ctx: ChatAgentContext
): Promise<string> {
  const result = await searchCourseKnowledge(ctx.cache, query);
  return renderCourseArtifactSearchResult(result, query);
}

async function readFile(filename: string, ctx: ChatAgentContext): Promise<string> {
  const artifact = await readWorkspaceKnowledgeArtifact(
    ctx.loaded,
    ctx.cache,
    filename,
    MAX_DOC_TEXT
  );
  switch (artifact.status) {
    case "ok":
      return artifact.content;
    case "empty_query":
      return "Provide a file name to read from the workspace or course cache.";
    case "missing_text":
      return renderWorkspaceArtifactLookupFailure(filename, artifact);
    case "not_found":
    default:
      return `File "${filename}" not found. Use list_files to see available files.`;
  }
}

async function listFiles(ctx: ChatAgentContext): Promise<string> {
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
  return lines.join("\n");
}

async function downloadCourseFile(title: string, ctx: ChatAgentContext): Promise<string> {
  if (!ctx.cache || !ctx.client) return "Cannot download files — no course cache or Canvas client available.";
  const q = title.toLowerCase();
  let foundItem = null;
  for (const mod of ctx.cache.modules) {
    for (const item of mod.items) {
      if (item.type === "File" && item.title.toLowerCase().includes(q)) { foundItem = item; break; }
    }
    if (foundItem) break;
  }
  if (!foundItem || !foundItem.contentId) return `No downloadable file matching "${title}" found.`;
  const fileMeta = await ctx.client.getFileSafe(foundItem.contentId);
  if (!fileMeta) return `Could not access file "${title}" from Canvas.`;
  const buffer = await ctx.client.downloadFile(fileMeta.url);
  if (!buffer) return `Failed to download "${fileMeta.display_name}".`;
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
      return extracted;
    }
  } catch {
    // Fall through to a guidance message below.
  }
  return `Downloaded "${fileMeta.display_name}", but extracted text is not available yet. Refresh the course cache to rebuild it.`;
}

async function openResource(query: string, ctx: ChatAgentContext): Promise<string> {
  const result = await handleOpenResourceQuery(query, {
    loaded: ctx.loaded,
    cache: ctx.cache,
  });
  return result.message;
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
