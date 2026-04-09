import type { ToolDefinition } from "../../ai/provider.js";
import type { ChatAgentContext } from "./types.js";

const SEARCH_WORKSPACE_TOOL: ToolDefinition = {
  name: "search_workspace",
  description:
    "Search the workspace for content relevant to a query. Returns the most relevant sections from assignment.md, workup.json, plan.md, and extracted documents.",
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
    "Read a file from the workspace or ingested course cache. Supports PDFs, text, HTML, ZIP. Use for reading extracted documents, assignment files, or downloaded course materials.",
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
    "List all available files in the workspace and course cache (extracted docs, downloaded attachments, workspace files).",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
};

const SEARCH_COURSE_TOOL: ToolDefinition = {
  name: "search_course",
  description:
    "Search the course structure — modules, module items, and file index. Use when you need to find specific course materials, documents, or content not in the workspace.",
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
    "Open a workspace or course resource on the user's machine. Use this when the user explicitly asks to open a PDF, file, page, assignment, or resource.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Resource name or description to open" },
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
