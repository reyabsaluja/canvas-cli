import fs from "node:fs/promises";
import path from "node:path";
import type { LoadedWorkspace } from "../ask/types.js";
import type { CourseCache } from "../enrich/cache-loader.js";
import type { CanvasClient } from "../canvas/client.js";
import type { Config } from "../config/env.js";
import type { WorkspaceAnswer } from "../ask/types.js";
import {
  streamWithTools,
  type AIProviderConfig,
  type ToolDefinition,
} from "../ai/provider.js";
import { buildChunks, retrieveRelevant } from "../ask/retrieve.js";
import { extractFileText } from "../extract/extract-text.js";

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
  conversationHistory: Array<{ role: string; content: string }>;
}

export interface ToolCallEvent {
  action: string;
  target: string;
  result: string;
  color: "green" | "red";
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
        onToolCall({ action, target, result: toolResult, color });
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
  while (ctx.conversationHistory.length > MAX_CONVERSATION_MESSAGES) {
    ctx.conversationHistory.shift();
  }

  let totalChars = ctx.conversationHistory.reduce(
    (sum, entry) => sum + entry.content.length,
    0
  );
  while (totalChars > MAX_CONVERSATION_CHARS && ctx.conversationHistory.length > 2) {
    const removed = ctx.conversationHistory.shift();
    totalChars -= removed?.content.length ?? 0;
  }
}

// --- Tool execution ---

async function executeToolCall(
  name: string,
  input: Record<string, unknown>,
  ctx: ChatAgentContext
): Promise<string> {
  switch (name) {
    case "search_workspace":
      return searchWorkspace(input.query as string, ctx);
    case "read_file":
      return readFile(input.filename as string, ctx);
    case "list_files":
      return listFiles(ctx);
    case "search_course":
      return searchCourse(input.query as string, ctx);
    case "download_course_file":
      return downloadCourseFile(input.title as string, ctx);
    default:
      return `Unknown tool: ${name}`;
  }
}

function searchWorkspace(query: string, ctx: ChatAgentContext): string {
  const chunks = buildChunks(ctx.loaded);
  const relevant = retrieveRelevant(query, chunks, 5);
  if (relevant.length === 0) return "No relevant content found for that query.";
  const results: string[] = [];
  for (const chunk of relevant) {
    results.push(`--- ${chunk.source} / ${chunk.section} ---`);
    results.push(chunk.text.slice(0, 2000));
    results.push("");
  }
  return results.join("\n");
}

function searchCourse(query: string, ctx: ChatAgentContext): string {
  if (!ctx.cache) return "Course cache not available.";
  const q = query.toLowerCase();
  const results: string[] = [];
  for (const mod of ctx.cache.modules) {
    if (mod.name.toLowerCase().includes(q)) {
      results.push(`Module: "${mod.name}" (${mod.items.length} items)`);
    }
    for (const item of mod.items) {
      if (item.title.toLowerCase().includes(q)) {
        const downloadable = item.type === "File" ? " [downloadable]" : "";
        results.push(`  [${item.type}] "${item.title}" in "${mod.name}"${downloadable}`);
      }
    }
  }
  for (const f of ctx.cache.files) {
    if (f.displayName.toLowerCase().includes(q) || f.filename.toLowerCase().includes(q)) {
      results.push(`File: "${f.displayName}" (${f.contentType})`);
    }
  }
  for (const att of ctx.cache.attachments) {
    if (att.originalFilename.toLowerCase().includes(q) && (att.status === "downloaded" || att.status === "skipped")) {
      results.push(`Downloaded: "${att.originalFilename}" [${att.sourceType}]`);
    }
  }
  if (results.length === 0) return `No course materials matching "${query}" found.`;
  return results.join("\n");
}

async function readFile(filename: string, ctx: ChatAgentContext): Promise<string> {
  const q = filename.toLowerCase().trim();
  // Strip .txt suffix (workspace extracts add .txt)
  const qClean = q.endsWith(".txt") ? q.slice(0, -4) : q;
  // Base name without any extension: "lab4.pdf" -> "lab4"
  const qBase = qClean.replace(/\.[^.]+$/, "");

  // Helper: find a downloaded file in course cache
  const findInCache = (test: (name: string) => boolean) => {
    if (!ctx.cache) return null;
    for (const att of ctx.cache.attachments) {
      if ((att.status === "downloaded" || att.status === "skipped") && test(att.originalFilename.toLowerCase())) {
        return { path: path.join(ctx.cache.coursePath, att.localPath), name: att.originalFilename };
      }
    }
    return null;
  };

  // 1. Direct match in course cache (e.g., "lab4_rubric.pdf" -> "lab4_rubric.pdf")
  const direct = findInCache((n) => n === qClean || n === q);
  if (direct) return extractFileText(direct.path, direct.name);

  // 2. Contains match in course cache (e.g., "rubric" -> "lab4_rubric-1.pdf")
  const contains = findInCache((n) => n.includes(qClean) || n.includes(q));
  if (contains) return extractFileText(contains.path, contains.name);

  // 3. Zip match: requested file might be INSIDE a zip (e.g., "lab4.pdf" is inside "lab4.zip")
  const zipMatch = findInCache((n) => n.endsWith(".zip") && n.includes(qBase));
  if (zipMatch) {
    const fullContent = await extractFileText(zipMatch.path, zipMatch.name);
    // Extract just the specific file section from the zip output
    const lines = fullContent.split("\n");
    const hdr = lines.findIndex((l) => {
      const ll = l.toLowerCase();
      return ll.includes(`--- ${qClean}`) || ll.includes(`/${qClean} ---`) || ll.includes(`/${qClean}`);
    });
    if (hdr >= 0) {
      // Return from this header to end (the PDF text section)
      return lines.slice(hdr).join("\n").slice(0, MAX_DOC_TEXT);
    }
    return fullContent.slice(0, MAX_DOC_TEXT);
  }

  // 4. Workspace markdown files
  if (qClean.includes("assignment.md") && ctx.loaded.assignmentMd) return ctx.loaded.assignmentMd.slice(0, MAX_DOC_TEXT);
  if (qClean.includes("plan.md") && ctx.loaded.planMd) return ctx.loaded.planMd.slice(0, MAX_DOC_TEXT);
  if (qClean.includes("notes.md") && ctx.loaded.notesMd) return ctx.loaded.notesMd.slice(0, MAX_DOC_TEXT);
  if (qClean.includes("workup") && ctx.loaded.workupJson) return JSON.stringify(ctx.loaded.workupJson, null, 2).slice(0, MAX_DOC_TEXT);

  // 5. Workspace extracted files
  for (const ef of ctx.loaded.extractedFiles) {
    const en = ef.name.toLowerCase();
    if (en === q || en === qClean || en === qClean + ".txt" || en.includes(qClean)) {
      return ef.content.slice(0, MAX_DOC_TEXT);
    }
  }

  return `File "${filename}" not found. Use list_files to see available files.`;
}

function listFiles(ctx: ChatAgentContext): string {
  const lines: string[] = [];
  lines.push("Workspace files:");
  if (ctx.loaded.assignmentMd) lines.push("  - assignment.md");
  if (ctx.loaded.planMd) lines.push("  - plan.md");
  if (ctx.loaded.notesMd) lines.push("  - notes.md");
  if (ctx.loaded.workupJson) lines.push("  - workup.json");
  if (ctx.loaded.extractedFiles.length > 0) {
    lines.push("\nExtracted documents (use read_file to access):");
    for (const ef of ctx.loaded.extractedFiles) {
      const isZip = ef.name.endsWith(".zip.txt");
      lines.push(`  - ${ef.name}${isZip ? " (contains extracted files — PDFs inside are readable)" : ""}`);
    }
  }
  if (ctx.cache) {
    const downloaded = ctx.cache.attachments.filter((a) => a.status === "downloaded" || a.status === "skipped");
    if (downloaded.length > 0) {
      lines.push("\nCourse attachments (downloaded):");
      for (const a of downloaded) lines.push(`  - ${a.originalFilename} [${a.sourceType}]`);
    }
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
  return await extractFileText(localPath, fileMeta.display_name);
}
