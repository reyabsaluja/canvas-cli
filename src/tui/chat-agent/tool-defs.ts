import type { ToolDefinition } from "../../ai/provider.js";
import type { ChatAgentContext } from "./types.js";

const SEARCH_WORKSPACE_TOOL: ToolDefinition = {
  name: "search_workspace",
  description:
    "Discovery-only search across the workspace and ingested course knowledge. Returns relevant snippets and source names, not the full document text. Use it to find the best source, then call read_file for exact wording, requirements, quotes, or detailed answers. For compare, changed, or conflict questions, use search to identify the best two candidate sources before concluding.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
    },
    required: ["query"],
  },
};

const READ_FILE_TOOL: ToolDefinition = {
  name: "read_file",
  description:
    "Read the full extracted text of a specific workspace or course artifact. This is the grounding tool to use after search when you need exact details, requirements, or citations. Supports PDFs, text, HTML, and ZIP-backed extracted files. For compare, changed, or conflict questions, read each relevant source before deciding whether they agree.",
  parameters: {
    type: "object",
    properties: {
      filename: {
        type: "string",
        description:
          "Filename to read (e.g. 'lab4.pdf', 'assignment.md', 'lab4.zip')",
      },
    },
    required: ["filename"],
  },
};

const LIST_FILES_TOOL: ToolDefinition = {
  name: "list_files",
  description:
    "List all available files in the workspace and course cache (extracted docs, downloaded attachments, workspace files). Use this after a failed or ambiguous read/open, or when a search came up empty and you need the exact filename or title before calling read_file or open_resource again.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
};

const SEARCH_COURSE_TOOL: ToolDefinition = {
  name: "search_course",
  description:
    "Discovery-only search of the course cache — modules, pages, assignments, announcements, discussions, attachments, and file index entries. Returns candidate matches, not full document text. After finding the right item, use read_file for readable artifacts or download_course_file for undownloaded course files. For compare, changed, or conflict questions, identify the best two course sources before concluding.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Search keyword to match against module names, item titles, and file names",
      },
    },
    required: ["query"],
  },
};

const DOWNLOAD_COURSE_FILE_TOOL: ToolDefinition = {
  name: "download_course_file",
  description:
    "Download a file from the Canvas course by module item title. Use when you find a file via search_course that hasn't been downloaded yet.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Module item title of the file to download",
      },
    },
    required: ["title"],
  },
};

const OPEN_RESOURCE_TOOL: ToolDefinition = {
  name: "open_resource",
  description:
    "Open a workspace or course resource on the user's machine. Use this when the user asks to open a PDF, file, page, or resource. Pass the most specific filename or resource name you can infer from the user's request as the query — e.g. 'M3_Instructions.pdf' rather than 'the m3 pdf'. If the user mentions a milestone, lab, or assignment number, include it.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "The resource filename or title to open. Use the most specific name possible — e.g. 'a3.pdf', 'M3_Instructions.pdf', 'lab4.zip'. Avoid vague descriptions.",
      },
    },
    required: ["query"],
  },
};

export function getAvailableChatToolNames(
  ctx: Pick<ChatAgentContext, "cache" | "client">
): string[] {
  return buildChatTools(ctx).map((tool) => tool.name);
}

export function buildChatTools(
  ctx: Pick<ChatAgentContext, "cache" | "client">
): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    SEARCH_WORKSPACE_TOOL,
    READ_FILE_TOOL,
    LIST_FILES_TOOL,
  ];

  if (ctx.cache) {
    tools.push(SEARCH_COURSE_TOOL);
  }

  if (ctx.cache && ctx.client) {
    tools.push(DOWNLOAD_COURSE_FILE_TOOL);
  }

  tools.push(OPEN_RESOURCE_TOOL);

  return tools;
}

export function mapToolCall(
  name: string,
  input: Record<string, unknown>
): { action: string; target: string; color: "green" | "red" } {
  switch (name) {
    case "read_file":
      return {
        action: "read",
        target: (input.filename as string) ?? "file",
        color: "green",
      };
    case "search_workspace":
      return {
        action: "search",
        target: (input.query as string) ?? "workspace",
        color: "green",
      };
    case "search_course":
      return {
        action: "search",
        target: (input.query as string) ?? "course",
        color: "green",
      };
    case "list_files":
      return { action: "list", target: "files", color: "green" };
    case "download_course_file":
      return {
        action: "download",
        target: (input.title as string) ?? "file",
        color: "green",
      };
    case "open_resource":
      return {
        action: "open",
        target: (input.query as string) ?? "resource",
        color: "green",
      };
    default:
      return { action: name, target: "", color: "green" };
  }
}
