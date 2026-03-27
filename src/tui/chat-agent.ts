import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { LoadedWorkspace } from "../ask/types.js";
import type { CourseCache } from "../enrich/cache-loader.js";
import type { CanvasClient } from "../canvas/client.js";
import type { Config } from "../config/env.js";
import type { WorkspaceAnswer } from "../ask/types.js";
import {
  callModelWithTools,
  buildToolResultMessage,
  type AIProviderConfig,
} from "../ai/provider.js";
import { buildChunks, retrieveRelevant } from "../ask/retrieve.js";
import { extractFileText } from "../extract/extract-text.js";

const MAX_ITERATIONS = 6;
const MAX_DOC_TEXT = 12000;

const CHAT_TOOLS: Tool[] = [
  {
    name: "search_workspace",
    description: "Search the workspace for content relevant to a query. Returns the most relevant sections from assignment.md, workup.json, plan.md, and extracted documents.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
  {
    name: "read_file",
    description: "Read a file from the workspace or ingested course cache. Supports PDFs, text, HTML. Use for reading extracted documents, assignment files, or downloaded course materials.",
    input_schema: {
      type: "object" as const,
      properties: {
        filename: { type: "string", description: "Filename to read (e.g. 'Lab4_Second-order-Circuits.pdf', 'assignment.md')" },
      },
      required: ["filename"],
    },
  },
  {
    name: "list_files",
    description: "List all available files in the workspace and course cache (extracted docs, downloaded attachments, workspace files).",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "search_course",
    description: "Search the course structure — modules, module items, and file index. Use when you need to find specific course materials, documents, or content not in the workspace.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search keyword to match against module names, item titles, and file names" },
      },
      required: ["query"],
    },
  },
  {
    name: "download_course_file",
    description: "Download a file from the Canvas course by module item title. Use when you find a file via search_course that hasn't been downloaded yet.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Module item title of the file to download" },
      },
      required: ["title"],
    },
  },
];

/**
 * Build the system prompt with pre-loaded workup context.
 * This means the agent can answer most questions WITHOUT tool calls —
 * the ingestion + work pipeline already gathered the information.
 * Tools are only needed for deeper investigation.
 */
function buildSystemPrompt(ctx: ChatAgentContext): string {
  const parts: string[] = [];

  parts.push(`You are a workspace assistant for a university assignment. You help students understand their assignments.

You already have a detailed workup of this assignment pre-loaded below. For most questions, you can answer directly from this context WITHOUT using tools.

Use tools ONLY when:
- The question asks about something not covered in the workup
- You need to read a specific document in detail
- You need to find information not already summarized

Rules:
- Be concise and direct.
- If the workup already contains the answer, respond immediately (no tool calls needed).
- Cite sources when relevant.
- Do NOT solve the assignment — help the student understand it.
- Keep answers to 2-5 sentences unless the student asks for detail.

When you have enough information, respond with your answer directly (no tool calls).`);

  // Pre-load workup context into system prompt
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

  // List what extracted docs are available (so the agent knows it can read them)
  if (ctx.loaded.extractedFiles.length > 0) {
    parts.push(`\nExtracted documents available (use read_file to access):`);
    for (const ef of ctx.loaded.extractedFiles) {
      parts.push(`- ${ef.name}`);
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
}

export interface ToolCallEvent {
  action: string;
  target: string;
  result: string;
  color: "green" | "red";
}

/**
 * Run the chat agent with tool calling.
 * onToolCall is fired after each tool execution with structured event data.
 */
export async function runChatAgent(
  ctx: ChatAgentContext,
  question: string,
  onToolCall: (event: ToolCallEvent) => void
): Promise<WorkspaceAnswer> {
  const systemPrompt = buildSystemPrompt(ctx);
  const messages: MessageParam[] = [
    { role: "user", content: question },
  ];

  let finalText = "";

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await callModelWithTools(
      ctx.aiConfig,
      systemPrompt,
      messages,
      CHAT_TOOLS,
      4096
    );

    // If no tool calls, the model is done — extract the text response
    if (response.toolCalls.length === 0) {
      finalText = response.textContent ?? "";
      break;
    }

    // Execute tool calls
    const toolResults: Array<{ toolCallId: string; content: string; isError?: boolean }> = [];

    for (const tc of response.toolCalls) {
      // Map tool name to human-readable action + target
      const { action, target, color } = mapToolCall(tc.name, tc.input);

      try {
        const result = await executeToolCall(tc.name, tc.input, ctx);
        toolResults.push({ toolCallId: tc.id, content: result });
        onToolCall({ action, target, result, color });
      } catch (err) {
        const errMsg = `Error: ${err instanceof Error ? err.message : "unknown"}`;
        onToolCall({ action, target, result: errMsg, color: "red" });
        toolResults.push({
          toolCallId: tc.id,
          content: errMsg,
          isError: true,
        });
      }
    }

    // Add to conversation and continue
    messages.push({ role: "assistant", content: response.rawContent });
    messages.push(buildToolResultMessage(toolResults));
  }

  // If we exhausted iterations without a text response, do one final call
  if (!finalText) {
    const final = await callModelWithTools(
      ctx.aiConfig,
      systemPrompt,
      messages,
      [],
      4096
    );
    finalText = final.textContent ?? "I wasn't able to find a clear answer.";
  }

  return {
    question,
    answer: finalText,
    bulletPoints: [],
    sources: [],
    confidence: "medium",
  };
}

/** Map tool name + input to a human-readable action/target/color. */
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
  if (!ctx.cache) return "Course cache not available. Cannot search course structure.";

  const q = query.toLowerCase();
  const results: string[] = [];

  // Search modules and module items
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

  // Search file index
  for (const f of ctx.cache.files) {
    if (
      f.displayName.toLowerCase().includes(q) ||
      f.filename.toLowerCase().includes(q)
    ) {
      const size = f.size < 1024 * 1024
        ? `${(f.size / 1024).toFixed(0)}KB`
        : `${(f.size / (1024 * 1024)).toFixed(1)}MB`;
      results.push(`File: "${f.displayName}" (${f.contentType}, ${size})`);
    }
  }

  // Search downloaded attachments
  for (const att of ctx.cache.attachments) {
    if (
      att.originalFilename.toLowerCase().includes(q) &&
      (att.status === "downloaded" || att.status === "skipped")
    ) {
      results.push(`Downloaded: "${att.originalFilename}" [${att.sourceType}] — ${att.reason}`);
    }
  }

  if (results.length === 0) return `No course materials matching "${query}" found.`;
  return results.join("\n");
}

async function readFile(filename: string, ctx: ChatAgentContext): Promise<string> {
  const q = filename.toLowerCase();

  // Check workspace extracted files
  for (const ef of ctx.loaded.extractedFiles) {
    if (ef.name.toLowerCase().includes(q)) {
      return ef.content.slice(0, MAX_DOC_TEXT);
    }
  }

  // Check workspace files (assignment.md, plan.md, etc.)
  if (q.includes("assignment.md") && ctx.loaded.assignmentMd) {
    return ctx.loaded.assignmentMd.slice(0, MAX_DOC_TEXT);
  }
  if (q.includes("plan.md") && ctx.loaded.planMd) {
    return ctx.loaded.planMd.slice(0, MAX_DOC_TEXT);
  }
  if (q.includes("notes.md") && ctx.loaded.notesMd) {
    return ctx.loaded.notesMd.slice(0, MAX_DOC_TEXT);
  }
  if (q.includes("workup") && ctx.loaded.workupJson) {
    return JSON.stringify(ctx.loaded.workupJson, null, 2).slice(0, MAX_DOC_TEXT);
  }

  // Check course cache downloaded attachments
  if (ctx.cache) {
    for (const att of ctx.cache.attachments) {
      if (
        (att.status === "downloaded" || att.status === "skipped") &&
        att.originalFilename.toLowerCase().includes(q)
      ) {
        const fullPath = path.join(ctx.cache.coursePath, att.localPath);
        return await extractFileText(fullPath, att.originalFilename);
      }
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
    lines.push("\nExtracted documents:");
    for (const ef of ctx.loaded.extractedFiles) {
      lines.push(`  - ${ef.name}`);
    }
  }

  if (ctx.cache) {
    const downloaded = ctx.cache.attachments.filter(
      (a) => a.status === "downloaded" || a.status === "skipped"
    );
    if (downloaded.length > 0) {
      lines.push("\nCourse attachments (downloaded):");
      for (const a of downloaded) {
        lines.push(`  - ${a.originalFilename} [${a.sourceType}]`);
      }
    }

    // Module files not yet downloaded
    const downloadedIds = new Set(downloaded.map((a) => a.canvasFileId).filter(Boolean));
    const moduleFiles: string[] = [];
    for (const mod of ctx.cache.modules) {
      for (const item of mod.items) {
        if (item.type === "File" && item.contentId && !downloadedIds.has(item.contentId)) {
          moduleFiles.push(`  - ${item.title} (in "${mod.name}", downloadable)`);
        }
      }
    }
    if (moduleFiles.length > 0) {
      lines.push("\nModule files (not yet downloaded — use download_course_file):");
      lines.push(...moduleFiles);
    }
  }

  return lines.join("\n");
}

async function downloadCourseFile(title: string, ctx: ChatAgentContext): Promise<string> {
  if (!ctx.cache || !ctx.client) {
    return "Cannot download files — no course cache or Canvas client available.";
  }

  const q = title.toLowerCase();
  let foundItem = null;
  let modName = "";

  for (const mod of ctx.cache.modules) {
    for (const item of mod.items) {
      if (item.type === "File" && item.title.toLowerCase().includes(q)) {
        foundItem = item;
        modName = mod.name;
        break;
      }
    }
    if (foundItem) break;
  }

  if (!foundItem || !foundItem.contentId) {
    return `No downloadable file matching "${title}" found in modules.`;
  }

  // Get file metadata
  const fileMeta = await ctx.client.getFileSafe(foundItem.contentId);
  if (!fileMeta) {
    return `Could not access file "${title}" from Canvas.`;
  }

  // Download
  const buffer = await ctx.client.downloadFile(fileMeta.url);
  if (!buffer) {
    return `Failed to download "${fileMeta.display_name}".`;
  }

  // Save locally
  const downloadDir = path.join(ctx.cache.coursePath, "attachments", "modules");
  await fs.mkdir(downloadDir, { recursive: true });
  const localPath = path.join(downloadDir, fileMeta.display_name);
  await fs.writeFile(localPath, buffer);

  // Extract text
  const text = await extractFileText(localPath, fileMeta.display_name);
  return `Downloaded "${fileMeta.display_name}" (${buffer.length} bytes):\n\n${text}`;
}

// extractFileText imported from ../extract/extract-text.js
// Handles PDF, text, HTML, ZIP, and code files
