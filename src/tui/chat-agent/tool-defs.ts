import type { ToolDefinition } from "../../ai/provider.js";
import type { ChatAgentContext } from "./types.js";

const SEARCH_WORKSPACE_TOOL: ToolDefinition = {
  name: "search_workspace",
  description:
    "Discovery-only keyword search across the workspace and ingested course knowledge. Returns relevant snippets and source names, not the full document text. Use it to find the best source, then call read_file for exact wording, requirements, quotes, or detailed answers. For compare, changed, or conflict questions, use search to identify the best two candidate sources before concluding. QUERY TIPS: Use 2–4 specific keywords, not full questions. Good: 'calibration threshold voltage'. Bad: 'what does the assignment say about the calibration threshold'. The engine matches individual words and stems (submit matches submissions), so pick distinctive nouns/verbs from the student's question.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "2–4 distinctive keywords (not a full question)" },
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
    "Discovery-only keyword search of the course cache — modules, pages, assignments, grading breakdowns, announcements, discussions, attachments, and file index entries. Returns candidate matches, not full document text. After finding the right item, use read_file for readable artifacts or download_course_file for undownloaded course files. For compare, changed, or conflict questions, identify the best two course sources before concluding. QUERY TIPS: Use 2–4 specific keywords, not full questions. Good: 'late penalty submission'. Bad: 'what is the policy on late submissions'. The engine matches individual words and stems (grade matches grading), so pick distinctive terms.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "2–4 distinctive keywords to match against titles, sections, and content",
      },
    },
    required: ["query"],
  },
};

const DOWNLOAD_COURSE_FILE_TOOL: ToolDefinition = {
  name: "download_course_file",
  description:
    "Download a file from the Canvas course by module item title. Use only when search_course identifies an undownloaded Canvas File. If the result is already readable as a page, assignment, grading breakdown, announcement, discussion, external link, attachment, or previous read, use read_file instead. This tool reuses cached course text before attempting a Canvas download.",
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
    "Open a workspace or course resource on the user's machine. Use this when the user asks to open a non-lecture PDF, file, page, or resource. For lecture videos, recordings, or slides, prefer open_lecture when that tool is available. Pass the most specific filename or resource name you can infer from the user's request as the query — e.g. 'M3_Instructions.pdf' rather than 'the m3 pdf'. If the user mentions a milestone, lab, or assignment number, include it.",
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

const LIST_ASSIGNMENTS_TOOL: ToolDefinition = {
  name: "list_assignments",
  description:
    "List this course's assignments with due dates and submission status. Use when the student asks about upcoming work, what's due, or to orient across assignments beyond the current one. The result is grounded course evidence; answer from it directly unless the student needs a specific assignment's full instructions.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
};

const OPEN_LECTURE_TOOL: ToolDefinition = {
  name: "open_lecture",
  description:
    "Find and open lecture content (video, slides, recording, or page) for this course. Prefer this over open_resource whenever the user asks to open lectures, lecture slides, recordings, or videos by number, title, or topic.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Lecture number, title keyword, or content type (e.g. '13', 'lecture 13 slides', 'video')",
      },
    },
    required: ["query"],
  },
};

const LIST_ANNOUNCEMENTS_TOOL: ToolDefinition = {
  name: "list_announcements",
  description:
    "List announcements and discussion topics for this course. Optionally filter by type and search by keyword. This is a discovery/orientation tool for announcements, discussions, posts, or what's new in the course. Use read_thread on a listed item before answering what a specific post says, whether an instructor clarified something, or what replies contain.",
  parameters: {
    type: "object",
    properties: {
      filter: {
        type: "string",
        enum: ["all", "announcements", "discussions"],
        description: "Type of items to list. Default: all.",
      },
      query: {
        type: "string",
        description: "Optional keyword to search titles.",
      },
    },
    required: [],
  },
};

const READ_THREAD_TOOL: ToolDefinition = {
  name: "read_thread",
  description:
    "Read a full discussion or announcement thread including all replies. This is a grounding tool for posts, instructor clarifications, and reply details; after reading, answer from the thread content instead of searching again. Identify the thread by numeric topic ID or partial title. Use after list_announcements surfaces a candidate, or when the student references a specific post or announcement.",
  parameters: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description: "Topic ID (number) or partial title to match.",
      },
    },
    required: ["topic"],
  },
};

export function getAvailableChatToolNames(
  ctx: Pick<ChatAgentContext, "cache" | "client" | "assignments" | "radar" | "courseId">
): string[] {
  return buildChatTools(ctx).map((tool) => tool.name);
}

export function buildChatTools(
  ctx: Pick<ChatAgentContext, "cache" | "client" | "assignments" | "radar" | "courseId">
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

  if (ctx.assignments && ctx.assignments.length > 0) {
    tools.push(LIST_ASSIGNMENTS_TOOL);
  }

  if (ctx.cache && ctx.cache.lectures && ctx.cache.lectures.length > 0) {
    tools.push(OPEN_LECTURE_TOOL);
  }

  if (ctx.radar && ctx.courseId != null) {
    tools.push(LIST_ANNOUNCEMENTS_TOOL);
    tools.push(READ_THREAD_TOOL);
  }

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
    case "list_assignments":
      return { action: "list", target: "assignments", color: "green" };
    case "open_lecture":
      return {
        action: "open",
        target: (input.query as string) ?? "lecture",
        color: "green",
      };
    case "list_announcements":
      return { action: "list", target: "announcements", color: "green" };
    case "read_thread":
      return {
        action: "read",
        target: (input.topic as string) ?? "thread",
        color: "green",
      };
    default:
      return { action: name, target: "", color: "green" };
  }
}
