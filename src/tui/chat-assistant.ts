import {
  streamWithTools,
  type AIProviderConfig,
  type ToolDefinition,
} from "../ai/provider.js";
import type { Assignment } from "../domain/models.js";
import type { CourseCache } from "../enrich/cache-loader.js";
import {
  filterActionableUpcomingAssignments,
  getDisplayCourseAvailability,
  getDisplayCourses,
  type AppServices,
} from "./services.js";
import type { ChatMessage } from "./chat-state.js";
import {
  readCourseDocument,
  renderCourseArtifactSearchResult,
  renderCourseDocumentLookupResult,
  searchCourseKnowledge,
} from "./course-retrieval.js";
import { handleOpenResourceQuery } from "./open-resources.js";
import { handleLectureQuery } from "./lecture-resources.js";
import {
  formatRadarItems,
  resolveAndRenderThread,
} from "./radar-commands.js";
import type { RadarFilter } from "./services.js";

const GLOBAL_TOOLS: ToolDefinition[] = [
  {
    name: "list_courses",
    description: "List available configured courses and unavailable course entries.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "list_recent_workspaces",
    description: "List recent workspaces and sessions available from global scope.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "list_upcoming_assignments",
    description: "List upcoming assignments across all configured courses.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "search_home",
    description: "Search courses, recent workspaces, and upcoming assignments by keyword.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword or phrase to search for" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_radar",
    description:
      "List recent announcements and discussion topics across all courses. Optionally filter by type and search by keyword.",
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
  },
  {
    name: "read_thread",
    description:
      "Read a full discussion thread including all replies. Identify the thread by topic ID or partial title.",
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
  },
];

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
  {
    name: "open_course_resource",
    description:
      "Open a cached course resource or link on the user's machine. Use this when the user asks to open a file, PDF, page, or resource. Pass the most specific filename or title you can infer.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The resource filename or title to open. Use the most specific name possible — e.g. 'a3.pdf', 'M3_Instructions.pdf'. Avoid vague descriptions.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "open_lecture",
    description:
      "Find and open lecture content (video, slides, or page). Use when the user asks about lectures, recordings, or slides.",
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
  },
  {
    name: "list_radar",
    description:
      "List recent announcements and discussion topics for this course. Optionally filter by type and search by keyword.",
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
  },
  {
    name: "read_thread",
    description:
      "Read a full discussion thread including all replies. Identify the thread by topic ID or partial title.",
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
  services: AppServices;
  courseId: number;
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
  onToolCall?: (event: ScopeToolCallEvent) => void;
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
    GLOBAL_TOOLS,
    async (toolName, input) => {
      switch (toolName) {
        case "list_courses": {
          const result = renderGlobalCourses(options.services);
          options.onToolCall?.({
            action: "list",
            target: "courses",
            result,
            color: "green",
          });
          return result;
        }
        case "list_recent_workspaces": {
          const result = renderRecentWorkspaces(options.recent);
          options.onToolCall?.({
            action: "list",
            target: "recent",
            result,
            color: "green",
          });
          return result;
        }
        case "list_upcoming_assignments": {
          const result = renderUpcomingAssignments(options.upcomingAssignments);
          options.onToolCall?.({
            action: "list",
            target: "upcoming assignments",
            result,
            color: "green",
          });
          return result;
        }
        case "search_home": {
          const query = String(input.query ?? "");
          const result = searchGlobalHome(
            options.services,
            options.recent,
            options.upcomingAssignments,
            query
          );
          options.onToolCall?.({
            action: "search",
            target: query || "home",
            result,
            color: "green",
          });
          return result;
        }
        case "list_radar": {
          const filter = (input.filter as RadarFilter) ?? "all";
          const query = (input.query as string) ?? "";
          const courses = getDisplayCourses(options.services);
          const items = await options.services.radar.getRadarItemsMultiCourse(
            courses.map((c) => ({ id: c.id, name: c.name })),
            filter,
            query || undefined
          );
          const result = formatRadarItems(items, filter, query);
          options.onToolCall?.({
            action: "list",
            target: "radar",
            result,
            color: "green",
          });
          return result;
        }
        case "read_thread": {
          const topicQuery = String(input.topic ?? "");
          const courses = getDisplayCourses(options.services);
          const resolved = await resolveAndRenderThread(
            options.services,
            courses,
            topicQuery
          );
          options.onToolCall?.({
            action: "read",
            target: topicQuery || "thread",
            result: resolved.content,
            color: resolved.found ? "green" : "red",
          });
          return resolved.content;
        }
        default:
          return `Unknown tool: ${toolName}`;
      }
    },
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
          const search = await searchCourseKnowledge(options.cache, query);
          const result = renderCourseArtifactSearchResult(search, query);
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
          const lookup = await readCourseDocument(options.cache, name);
          const result = renderCourseDocumentLookupResult(lookup, name);
          options.onToolCall?.({
            action: "read",
            target: name || "document",
            result,
            color:
              lookup.status === "ok" || lookup.status === "missing_text"
                ? "green"
                : "red",
          });
          return result;
        }
        case "open_course_resource": {
          const query = String(input.query ?? "");
          const result = await handleOpenResourceQuery(
            query,
            { cache: options.cache },
            undefined,
            true
          );
          options.onToolCall?.({
            action: "open",
            target: query || "resource",
            result: result.message,
            color:
              result.status === "opened" || result.status === "listed"
                ? "green"
                : "red",
          });
          return result.message;
        }
        case "open_lecture": {
          const query = String(input.query ?? "");
          const result = await handleLectureQuery(
            query,
            options.cache,
            options.services.client,
            options.courseId
          );
          options.onToolCall?.({
            action: "open",
            target: query || "lecture",
            result: result.message,
            color:
              result.status === "opened" || result.status === "listed"
                ? "green"
                : "red",
          });
          return result.message;
        }
        case "list_radar": {
          const filter = (input.filter as RadarFilter) ?? "all";
          const query = (input.query as string) ?? "";
          const items = await options.services.radar.getRadarItems(
            options.courseId,
            options.courseName,
            filter,
            query || undefined
          );
          const result = formatRadarItems(items, filter, query);
          options.onToolCall?.({
            action: "list",
            target: "radar",
            result,
            color: "green",
          });
          return result;
        }
        case "read_thread": {
          const topicQuery = String(input.topic ?? "");
          const course = {
            id: options.courseId,
            name: options.courseName,
          };
          const resolved = await resolveAndRenderThread(
            options.services,
            [course],
            topicQuery
          );
          options.onToolCall?.({
            action: "read",
            target: topicQuery || "thread",
            result: resolved.content,
            color: resolved.found ? "green" : "red",
          });
          return resolved.content;
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
  const actionableUpcoming =
    filterActionableUpcomingAssignments(upcomingAssignments);
  const lines: string[] = [
    "You are the global home assistant for canvas-cli.",
    "This scope is navigation-oriented. Help the user with cross-course questions, upcoming work, and where to go next.",
    "Do not pretend you can read assignment documents from global scope.",
    "If the user needs assignment-level detail, tell them to open the course or workspace.",
    "Use list_radar and read_thread to check announcements and discussions across courses.",
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
  if (actionableUpcoming.length === 0) {
    lines.push("- No upcoming assignments found.");
  } else {
    for (const assignment of actionableUpcoming.slice(0, 12)) {
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
    "IMPORTANT: If the user asks to open, launch, show, or pull up ANY file, PDF, page, or resource, you MUST call open_course_resource immediately. Do NOT describe the resource or answer from context — the user wants it opened on their machine. After a successful open, just confirm it was opened.",
    "Use list_radar and read_thread to check announcements and discussions for this course.",
    "Ground answers in the indexed local cache. If the cache does not contain the answer, say so plainly.",
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

  if (cache.lectures.length > 0) {
    lines.push("", "Course lectures (use open_course_resource to open for the user):");
    for (const lecture of cache.lectures.slice(0, 30)) {
      const type = lecture.contentType !== "unknown" ? ` [${lecture.contentType}]` : "";
      lines.push(`- ${lecture.title}${type}`);
    }
    if (cache.lectures.length > 30) {
      lines.push(`- ... and ${cache.lectures.length - 30} more`);
    }
    lines.push("When the student asks what lectures to review, recommend from this list and offer to open them.");
  }

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

function renderGlobalCourses(services: AppServices): string {
  const availability = getDisplayCourseAvailability(services);
  const lines: string[] = ["Available courses:"];

  if (availability.available.length === 0) {
    lines.push("- None configured.");
  } else {
    for (const course of getDisplayCourses(services)) {
      lines.push(`- ${course.name} (${course.courseCode})`);
    }
  }

  lines.push("", "Unavailable configured courses:");
  if (availability.unavailable.length === 0) {
    lines.push("- None.");
  } else {
    for (const course of availability.unavailable) {
      lines.push(`- ${course.displayName} (${course.originalCode})`);
    }
  }

  return lines.join("\n");
}

function renderRecentWorkspaces(
  recent: Array<{ name: string; course: string; path: string }>
): string {
  if (recent.length === 0) return "No recent workspaces.";
  return recent
    .slice(0, 12)
    .map((item) => `- ${item.name} — ${item.course}`)
    .join("\n");
}

function renderUpcomingAssignments(assignments: Assignment[]): string {
  const actionableUpcoming = filterActionableUpcomingAssignments(assignments);
  if (actionableUpcoming.length === 0) return "No upcoming assignments found.";
  return actionableUpcoming
    .slice(0, 12)
    .map((assignment) => {
      const due = assignment.dueAt?.toISOString() ?? "no due date";
      return `- ${assignment.name} — ${assignment.courseName} — ${due}`;
    })
    .join("\n");
}

function searchGlobalHome(
  services: AppServices,
  recent: Array<{ name: string; course: string; path: string }>,
  upcomingAssignments: Assignment[],
  query: string
): string {
  const normalized = query.trim().toLowerCase();
  const actionableUpcoming =
    filterActionableUpcomingAssignments(upcomingAssignments);
  if (!normalized) {
    return "Enter a keyword to search courses, recent workspaces, and upcoming assignments.";
  }

  const lines: string[] = [];
  for (const course of getDisplayCourses(services)) {
    if (
      course.name.toLowerCase().includes(normalized) ||
      course.courseCode.toLowerCase().includes(normalized)
    ) {
      lines.push(`[course] ${course.name} (${course.courseCode})`);
    }
  }
  for (const workspace of recent) {
    if (
      workspace.name.toLowerCase().includes(normalized) ||
      workspace.course.toLowerCase().includes(normalized)
    ) {
      lines.push(`[recent] ${workspace.name} — ${workspace.course}`);
    }
  }
  for (const assignment of actionableUpcoming) {
    if (
      assignment.name.toLowerCase().includes(normalized) ||
      assignment.courseName.toLowerCase().includes(normalized)
    ) {
      lines.push(`[upcoming] ${assignment.name} — ${assignment.courseName}`);
    }
  }

  if (lines.length === 0) {
    return `No course, recent workspace, or upcoming assignment matched "${query}".`;
  }

  return lines.slice(0, 12).join("\n");
}
