import type { ToolDefinition } from "../../ai/provider.js";
import type { ChatAgentContext } from "./types.js";

const SEARCH_WORKSPACE_TOOL: ToolDefinition = {
  name: "search_workspace",
  description:
    "Discovery-only search across the workspace and ingested course knowledge: the assignment's instruction documents, extracted PDFs, plan, and ingested course documents. It does NOT cover announcements or discussion threads (use list_announcements for those). Best first tool when you do not know which document holds the answer. Returns relevant snippets and source names, not the full document text. Use it to find the best source, then call read_file for exact wording, requirements, quotes, or detailed answers. If the results look weak, reword or broaden the query once before switching to search_course or list_files. For compare, changed, or conflict questions, use search to identify the best two candidate sources before concluding.",
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
    "Read the full extracted text of a specific workspace or course artifact. This is the grounding tool to use after search when you need exact details, requirements, or citations, and the default first tool when the instruction document is already listed in your context. Supports PDFs, text, HTML, and ZIP-backed extracted files. Returns up to about 30,000 characters; very long documents are cut off at the end, so if the section you need is missing, say so instead of assuming it does not exist. Read every document that could hold part of the answer: the instruction document and the rubric or grading page are usually both needed. For compare, changed, or conflict questions, read each relevant source before deciding whether they agree.",
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
    "List all available files in the workspace and course cache (extracted docs, downloaded attachments, workspace files). Use this after a failed or ambiguous read/open, or when a search came up empty and you need the exact filename or title before calling read_file or open_resource again. Also useful before the first read when the documents listed in your context do not obviously contain what the question needs.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
};

const SEARCH_COURSE_TOOL: ToolDefinition = {
  name: "search_course",
  description:
    "Discovery-only search of the course cache — modules, pages, assignments, announcements, discussions, attachments, and file index entries. Broader than search_workspace: use it when the answer is likely on a course page, in a module, in the syllabus, or in a file that is not part of this workspace, and as the next step when search_workspace found nothing useful. Returns candidate matches, not full document text. After finding the right item, use read_file for readable artifacts or download_course_file for undownloaded course files. For compare, changed, or conflict questions, identify the best two course sources before concluding.",
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
    "Download a file from the Canvas course by module item title and return its extracted text, so it doubles as a read. Use when you find a file via search_course that hasn't been downloaded yet.",
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

const LIST_ASSIGNMENTS_TOOL: ToolDefinition = {
  name: "list_assignments",
  description:
    "List this course's assignments with due dates and submission status. Use when the student asks about upcoming work, what's due, or to orient across assignments beyond the current one.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
};

const OPEN_LECTURE_TOOL: ToolDefinition = {
  name: "open_lecture",
  description:
    "Find and open lecture content (video, slides, or page) for this course. Use when the user asks about lectures, recordings, or slides by number, title, or topic.",
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
    "List announcements and discussion topics for this course. Optionally filter by type and search by keyword. Use when the student asks about announcements, discussions, posts, or what's new in the course, and whenever the question is about a deadline change, extension, clarification, correction, or 'did the professor say anything about...'. Returns titles and IDs only, not the post text: follow up with read_thread on the matching item to read what was actually said.",
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
    "Read a full discussion or announcement thread including all replies. This is the grounding tool for announcements and discussions: the full post text, not a summary. Identify the thread by numeric topic ID or partial title. Use after list_announcements surfaces a candidate, or when the student references a specific post or announcement.",
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
