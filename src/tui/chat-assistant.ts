import fs from "node:fs/promises";
import path from "node:path";
import {
  streamWithTools,
  type AIProviderConfig,
  type ToolDefinition,
} from "../ai/provider.js";
import type { Assignment } from "../domain/models.js";
import type { CourseCache } from "../enrich/cache-loader.js";
import {
  getDisplayCourseAvailability,
  type AppServices,
} from "./services.js";
import type { ChatMessage } from "./chat-state.js";
import { extractFileText } from "../extract/extract-text.js";

const COURSE_TOOLS: ToolDefinition[] = [
  {
    name: "list_assignments",
    description:
      "List course assignments with due dates and submission status.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "search_course",
    description:
      "Search course modules, file index, downloaded attachments, and pages by keyword.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword or phrase to search for" },
      },
      required: ["query"],
    },
  },
  {
    name: "read_course_document",
    description:
      "Read a downloaded course document or extracted page by filename or title.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Document name or page title" },
      },
      required: ["name"],
    },
  },
];

export interface ScopeToolCallEvent {
  action: string;
  target: string;
  result: string;
  color: "green" | "red";
}

interface CourseAssistantOptions {
  aiConfig: AIProviderConfig;
  courseName: string;
  courseCode: string;
  cache: CourseCache | null;
  assignments: Assignment[];
  history: ChatMessage[];
  question: string;
  onToolCall?: (event: ScopeToolCallEvent) => void;
  onTextDelta?: (delta: string) => void;
}

export async function answerGlobalQuestion(options: {
  aiConfig: AIProviderConfig;
  services: AppServices;
  question: string;
  history: ChatMessage[];
  recent: Array<{ name: string; course: string; path: string }>;
  upcomingAssignments: Assignment[];
  onTextDelta?: (delta: string) => void;
}): Promise<string> {
  const system = buildGlobalSystemPrompt(
    options.services,
    options.recent,
    options.upcomingAssignments
  );

  return streamWithTools(
    options.aiConfig,
    system,
    toModelMessages(options.history, options.question),
    [],
    async () => "No tools available in global scope.",
    {
      onTextDelta: options.onTextDelta,
    },
    4
  );
}

export async function answerCourseQuestion(
  options: CourseAssistantOptions
): Promise<string> {
  const system = buildCourseSystemPrompt(
    options.courseName,
    options.courseCode,
    options.cache,
    options.assignments
  );

  return streamWithTools(
    options.aiConfig,
    system,
    toModelMessages(options.history, options.question),
    COURSE_TOOLS,
    async (toolName, input) => {
      switch (toolName) {
        case "list_assignments": {
          const result = renderAssignments(options.assignments);
          options.onToolCall?.({
            action: "list",
            target: "assignments",
            result,
            color: "green",
          });
          return result;
        }
        case "search_course": {
          const query = String(input.query ?? "");
          const result = searchCourseMaterials(options.cache, query);
          options.onToolCall?.({
            action: "search",
            target: query || "course",
            result,
            color: "green",
          });
          return result;
        }
        case "read_course_document": {
          const name = String(input.name ?? "");
          const result = await readCourseDocument(options.cache, name);
          options.onToolCall?.({
            action: "read",
            target: name || "document",
            result,
            color: result.startsWith("Could not") ? "red" : "green",
          });
          return result;
        }
        default:
          return `Unknown tool: ${toolName}`;
      }
    },
    {
      onTextDelta: options.onTextDelta,
    },
    8
  );
}

function buildGlobalSystemPrompt(
  services: AppServices,
  recent: Array<{ name: string; course: string; path: string }>,
  upcomingAssignments: Assignment[]
): string {
  const availability = getDisplayCourseAvailability(services);
  const courses = availability.available;
  const unavailableCourses = availability.unavailable;
  const lines: string[] = [
    "You are the global home assistant for canvas-cli.",
    "This scope is navigation-oriented. Help the user with cross-course questions, upcoming work, and where to go next.",
    "Do not pretend you can read assignment documents from global scope.",
    "If the user needs assignment-level detail, tell them to open the course or workspace.",
    "",
    "Available configured courses:",
  ];

  if (courses.length === 0) {
    lines.push("- No available courses configured.");
  } else {
    for (const course of courses) {
      lines.push(`- ${course.name} (${course.courseCode})`);
    }
  }

  lines.push("", "Unavailable configured courses:");
  if (unavailableCourses.length === 0) {
    lines.push("- None.");
  } else {
    for (const course of unavailableCourses) {
      lines.push(`- ${course.displayName} (${course.originalCode})`);
    }
  }

  lines.push("", "Recent workspaces:");
  if (recent.length === 0) {
    lines.push("- No recent workspaces.");
  } else {
    for (const item of recent.slice(0, 8)) {
      lines.push(`- ${item.name} — ${item.course}`);
    }
  }

  lines.push("", "Upcoming assignments:");
  if (upcomingAssignments.length === 0) {
    lines.push("- No upcoming assignments found.");
  } else {
    for (const assignment of upcomingAssignments.slice(0, 12)) {
      lines.push(
        `- ${assignment.name} — ${assignment.courseName} — ${assignment.dueAt?.toISOString() ?? "no due date"}`
      );
    }
  }

  return lines.join("\n");
}

function buildCourseSystemPrompt(
  courseName: string,
  courseCode: string,
  cache: CourseCache | null,
  assignments: Assignment[]
): string {
  const lines: string[] = [
    `You are the course assistant for ${courseName} (${courseCode}).`,
    "Answer questions about assignments, modules, files, and course structure.",
    "Use tools when the user asks for details that require searching or reading cached course materials.",
    "If the cache is missing, say that clearly and guide the user toward opening a workspace or refreshing.",
    "",
    "Current assignments:",
    renderAssignments(assignments),
  ];

  if (!cache) {
    lines.push("", "Course cache status: missing.");
    return lines.join("\n");
  }

  lines.push(
    "",
    `Cache status: ready with ${cache.modules.length} modules, ${cache.files.length} files, ${cache.pages.length} pages, ${cache.attachments.length} attachments.`
  );

  if (cache.ingestion?.ingestedAt) {
    lines.push(`Last ingested at: ${cache.ingestion.ingestedAt}`);
  }

  return lines.join("\n");
}

function renderAssignments(assignments: Assignment[]): string {
  if (assignments.length === 0) return "No assignments found.";
  return assignments
    .slice(0, 20)
    .map((assignment) => {
      const due = assignment.dueAt
        ? assignment.dueAt.toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })
        : "no due date";
      return `- ${assignment.name} — ${due}${assignment.submitted ? " — submitted" : ""}`;
    })
    .join("\n");
}

function searchCourseMaterials(cache: CourseCache | null, query: string): string {
  if (!cache) {
    return "Course cache is not available yet. Open a workspace or refresh the course first.";
  }

  const q = query.toLowerCase();
  const lines: string[] = [];

  for (const assignment of cache.assignments) {
    if (assignment.name.toLowerCase().includes(q)) {
      lines.push(`[assignment] ${assignment.name}`);
    }
  }

  for (const module of cache.modules) {
    if (module.name.toLowerCase().includes(q)) {
      lines.push(`[module] ${module.name}`);
    }
    for (const item of module.items) {
      if (item.title.toLowerCase().includes(q)) {
        lines.push(`[module item] ${item.title} — ${module.name}`);
      }
    }
  }

  for (const file of cache.files) {
    if (
      file.displayName.toLowerCase().includes(q) ||
      file.filename.toLowerCase().includes(q)
    ) {
      lines.push(`[file] ${file.displayName}`);
    }
  }

  for (const page of cache.pages) {
    if (page.title.toLowerCase().includes(q) || page.pageId.toLowerCase().includes(q)) {
      lines.push(`[page] ${page.title}`);
    }
  }

  for (const attachment of cache.attachments) {
    if (attachment.originalFilename.toLowerCase().includes(q)) {
      lines.push(`[attachment] ${attachment.originalFilename}`);
    }
  }

  if (lines.length === 0) {
    return `No course material matched "${query}".`;
  }

  return lines.slice(0, 40).join("\n");
}

async function readCourseDocument(
  cache: CourseCache | null,
  name: string
): Promise<string> {
  if (!cache) {
    return "Could not read course documents because the course cache is missing.";
  }

  const lowered = name.toLowerCase().trim();
  const extractedCandidates = [
    path.join(cache.coursePath, "extracted", "syllabus-body.txt"),
    path.join(cache.coursePath, "extracted", "front-page.txt"),
  ];

  for (const candidate of extractedCandidates) {
    if (path.basename(candidate).toLowerCase().includes(lowered)) {
      return readText(candidate);
    }
  }

  const page = cache.pages.find((entry) => entry.title.toLowerCase().includes(lowered));
  if (page) {
    const pagePath = path.join(
      cache.coursePath,
      "extracted",
      "pages",
      `${page.pageId.replace(/[^a-zA-Z0-9._-]/g, "_")}.txt`
    );
    return readText(pagePath);
  }

  const attachment = cache.attachments.find((entry) =>
    entry.originalFilename.toLowerCase().includes(lowered)
  );
  if (attachment) {
    const fullPath = path.join(cache.coursePath, attachment.localPath);
    try {
      const text = await extractFileText(fullPath, attachment.originalFilename);
      return text.length > 18000 ? text.slice(0, 18000) + "\n[...truncated]" : text;
    } catch {
      return `Could not read ${attachment.originalFilename}.`;
    }
  }

  return `Could not find a downloaded course document matching "${name}".`;
}

async function readText(filePath: string): Promise<string> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return content.length > 18000
      ? content.slice(0, 18000) + "\n[...truncated]"
      : content;
  } catch {
    return `Could not read ${path.basename(filePath)}.`;
  }
}

function toModelMessages(
  history: ChatMessage[],
  question: string
): Array<{ role: string; content: string }> {
  return [
    ...history
      .filter((message) => message.role === "user" || message.role === "assistant")
      .slice(-20)
      .map((message) => ({
        role: message.role,
        content: message.content,
      })),
    { role: "user", content: question },
  ];
}
