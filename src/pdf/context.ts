import path from "node:path";
import type { AIProviderConfig } from "../ai/provider.js";
import type { LoadedWorkspace } from "../ask/types.js";
import type { CourseCache } from "../enrich/cache-loader.js";
import type { ChatMessage, ChatSession, ScopeRuntime } from "../tui/chat-state.js";

export interface PdfContextInput {
  instruction: string;
  session: ChatSession;
  runtime: ScopeRuntime;
  loaded?: LoadedWorkspace | null;
  cache?: CourseCache | null;
  aiConfig?: AIProviderConfig | null;
  abortSignal?: AbortSignal;
  now?: Date;
}

export interface PdfContextBundle {
  generatedAt: string;
  instruction: string;
  suggestedTitle: string;
  outputDirectory: string;
  outputBaseName: string;
  promptContext: string;
  fallbackMarkdown: string;
}

const MAX_PROMPT_CONTEXT_CHARS = 60000;
const MAX_CONVERSATION_MESSAGES = 80;
const MAX_SECTION_CHARS = 16000;
const MAX_SMALL_SECTION_CHARS = 6000;

export function buildPdfContextBundle(input: PdfContextInput): PdfContextBundle {
  const now = input.now ?? new Date();
  const generatedAt = now.toLocaleString();
  const instruction = input.instruction.trim();
  const suggestedTitle = inferSuggestedTitle(input);
  const outputDirectory = inferOutputDirectory(input);
  const outputBaseName = buildOutputBaseName(suggestedTitle, now);

  const contextSections = [
    buildSessionSection(input, generatedAt),
    buildWorkspaceSection(input.loaded ?? null),
    buildCourseSection(input.cache ?? null),
    buildConversationSection(input.session.messages),
  ].filter(Boolean);

  const promptContext = clampText(contextSections.join("\n\n"), MAX_PROMPT_CONTEXT_CHARS);
  const fallbackMarkdown = buildFallbackMarkdown({
    generatedAt,
    instruction,
    suggestedTitle,
    contextSections,
  });

  return {
    generatedAt,
    instruction,
    suggestedTitle,
    outputDirectory,
    outputBaseName,
    promptContext,
    fallbackMarkdown,
  };
}

function inferSuggestedTitle(input: PdfContextInput): string {
  const trimmed = input.instruction.trim();
  if (trimmed) {
    return titleCase(trimmed).slice(0, 90);
  }

  if (input.loaded?.assignmentName) {
    return `${input.loaded.assignmentName} Study Guide`;
  }

  if (input.session.metadata.courseName) {
    return `${input.session.metadata.courseName} Notes`;
  }

  return `${input.session.title || input.runtime.title || "Canvas CLI"} Export`;
}

function inferOutputDirectory(input: PdfContextInput): string {
  if (input.loaded?.path) {
    return path.join(input.loaded.path, "exports");
  }
  return path.resolve(process.cwd(), ".canvas-cli", "exports");
}

function buildOutputBaseName(title: string, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
  const slug = slugify(title).slice(0, 70) || "canvas-cli-export";
  return `${stamp}-${slug}`;
}

function buildSessionSection(input: PdfContextInput, generatedAt: string): string {
  const lines = [
    "# Session",
    `Generated: ${generatedAt}`,
    `Scope: ${input.runtime.scope.type}`,
    `Title: ${input.session.title || input.runtime.title}`,
  ];

  if (input.runtime.subtitle) lines.push(`Subtitle: ${input.runtime.subtitle}`);
  if (input.runtime.statusLabel) lines.push(`Status: ${input.runtime.statusLabel}`);
  if (input.session.metadata.courseName) {
    lines.push(`Course: ${input.session.metadata.courseName}`);
  }
  if (input.session.metadata.courseCode) {
    lines.push(`Course code: ${input.session.metadata.courseCode}`);
  }
  if (input.session.metadata.assignmentName) {
    lines.push(`Assignment: ${input.session.metadata.assignmentName}`);
  }
  if (input.instruction.trim()) {
    lines.push(`Requested PDF: ${input.instruction.trim()}`);
  }

  return lines.join("\n");
}

function buildWorkspaceSection(loaded: LoadedWorkspace | null): string {
  if (!loaded) return "";

  const parts = [
    "# Workspace",
    [
      `Assignment: ${loaded.assignmentName}`,
      `Course: ${loaded.courseName}`,
      loaded.courseCode ? `Course code: ${loaded.courseCode}` : "",
      loaded.preparedAt ? `Prepared: ${loaded.preparedAt}` : "",
      loaded.workspaceState ? `Workspace state: ${loaded.workspaceState}` : "",
      `Workspace path: ${loaded.path}`,
    ]
      .filter(Boolean)
      .join("\n"),
  ];

  const workup = loaded.workupJson;
  if (workup) {
    parts.push(formatWorkup(workup));
  }

  if (loaded.assignmentMd) {
    parts.push(
      `## assignment.md\n${clampText(loaded.assignmentMd, MAX_SECTION_CHARS)}`
    );
  }
  if (loaded.planMd) {
    parts.push(`## plan.md\n${clampText(loaded.planMd, MAX_SMALL_SECTION_CHARS)}`);
  }
  if (loaded.notesMd) {
    parts.push(`## notes.md\n${clampText(loaded.notesMd, MAX_SMALL_SECTION_CHARS)}`);
  }
  if (loaded.extractedFiles.length > 0) {
    parts.push(
      [
        "## Extracted Documents",
        ...loaded.extractedFiles
          .slice(0, 50)
          .map((file) => `- ${file.name} (${file.relativePath})`),
      ].join("\n")
    );
  }

  return parts.join("\n\n");
}

function formatWorkup(workup: Record<string, unknown>): string {
  const parts = ["## Assignment Workup"];
  const overview = stringField(workup, "overview");
  if (overview) parts.push(`### Overview\n${overview}`);

  const dueDate = stringField(workup, "dueDate") ?? stringField(workup, "due_date");
  if (dueDate) parts.push(`### Due Date\n${dueDate}`);

  const confidence = stringField(workup, "confidence");
  if (confidence) parts.push(`### Confidence\n${confidence}`);

  pushStringList(parts, "Deliverables", arrayField(workup, "deliverables"));
  pushStringList(parts, "Constraints", arrayField(workup, "constraints"));
  pushStringList(
    parts,
    "Recommended Read Order",
    arrayField(workup, "recommendedReadOrder") ??
      arrayField(workup, "recommended_read_order")
  );

  const actionPlan =
    arrayField(workup, "actionPlan") ?? arrayField(workup, "action_plan");
  if (actionPlan?.length) {
    parts.push(
      [
        "### Action Plan",
        ...actionPlan.map((step, index) => {
          if (typeof step !== "object" || step === null) {
            return `${index + 1}. ${String(step)}`;
          }
          const record = step as Record<string, unknown>;
          const number =
            typeof record.step === "number" ? record.step : index + 1;
          const action = stringField(record, "action") ?? "Step";
          const detail = stringField(record, "detail");
          return `${number}. ${action}${detail ? ` - ${detail}` : ""}`;
        }),
      ].join("\n")
    );
  }

  const resources =
    arrayField(workup, "relevantResources") ??
    arrayField(workup, "relevant_resources");
  if (resources?.length) {
    parts.push(
      [
        "### Key Resources",
        ...resources.map((resource) => {
          if (typeof resource !== "object" || resource === null) {
            return `- ${String(resource)}`;
          }
          const record = resource as Record<string, unknown>;
          const title = stringField(record, "title") ?? "Resource";
          const type = stringField(record, "type");
          const why = stringField(record, "why");
          const location = stringField(record, "location");
          return `- ${title}${type ? ` (${type})` : ""}${why ? ` - ${why}` : ""}${location ? ` [${location}]` : ""}`;
        }),
      ].join("\n")
    );
  }

  pushStringList(parts, "Open Questions", arrayField(workup, "uncertainties"));

  const sourceTrace =
    arrayField(workup, "sourceTrace") ?? arrayField(workup, "source_trace");
  if (sourceTrace?.length) {
    parts.push(
      [
        "### Source Trace",
        ...sourceTrace.map((entry) => {
          if (typeof entry !== "object" || entry === null) return `- ${String(entry)}`;
          const record = entry as Record<string, unknown>;
          const conclusion = stringField(record, "conclusion") ?? "Conclusion";
          const source = stringField(record, "source");
          return `- ${conclusion}${source ? ` [source: ${source}]` : ""}`;
        }),
      ].join("\n")
    );
  }

  return parts.join("\n\n");
}

function buildCourseSection(cache: CourseCache | null): string {
  if (!cache) return "";

  const parts = [
    "# Course Cache",
    [
      `Course ID: ${cache.courseId}`,
      `Course path: ${cache.coursePath}`,
      cache.ingestion?.ingestedAt ? `Ingested: ${cache.ingestion.ingestedAt}` : "",
      cache.ingestion?.courseName ? `Course: ${cache.ingestion.courseName}` : "",
      cache.ingestion?.courseCode ? `Course code: ${cache.ingestion.courseCode}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  ];

  if (cache.assignments.length > 0) {
    parts.push(
      [
        "## Assignments",
        ...cache.assignments.slice(0, 60).map((assignment) => {
          const due = assignment.dueAt ? ` due ${assignment.dueAt}` : "";
          return `- ${assignment.name}${due}`;
        }),
      ].join("\n")
    );
  }

  if (cache.modules.length > 0) {
    parts.push(
      [
        "## Modules",
        ...cache.modules.slice(0, 40).map((module) => {
          const items = module.items
            .slice(0, 20)
            .map((item) => item.title)
            .join("; ");
          return `- ${module.name}${items ? `: ${items}` : ""}`;
        }),
      ].join("\n")
    );
  }

  if (cache.lectures.length > 0) {
    parts.push(
      [
        "## Lectures",
        ...cache.lectures.slice(0, 60).map((lecture) => {
          const number =
            lecture.lectureNumber !== null ? `Lecture ${lecture.lectureNumber}: ` : "";
          const topic = lecture.topic ? ` - ${lecture.topic}` : "";
          return `- ${number}${lecture.title} (${lecture.contentType})${topic}`;
        }),
      ].join("\n")
    );
  }

  if (cache.syllabusCandidates.length > 0) {
    parts.push(
      [
        "## Syllabus Candidates",
        ...cache.syllabusCandidates.slice(0, 10).map((candidate) => {
          return `- ${candidate.title} (${candidate.confidence}) - ${candidate.reason}`;
        }),
      ].join("\n")
    );
  }

  return parts.join("\n\n");
}

function buildConversationSection(messages: ChatMessage[]): string {
  const relevant = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .filter((message) => !isMakePdfCommand(message))
    .slice(-MAX_CONVERSATION_MESSAGES);

  if (relevant.length === 0) {
    return "# Conversation\nNo prior user/assistant messages are available.";
  }

  const lines = ["# Conversation"];
  for (const message of relevant) {
    lines.push(message.role === "user" ? "## Student" : "## Assistant");
    lines.push(formatMessageBody(message));
  }
  return lines.join("\n\n");
}

function isMakePdfCommand(message: ChatMessage): boolean {
  return message.role === "user" && /^\/(?:make-pdf|pdf)\b/i.test(message.content.trim());
}

function formatMessageBody(message: ChatMessage): string {
  const parts = [message.content.trim()];
  if (message.bulletPoints?.length) {
    parts.push("", ...message.bulletPoints.map((point) => `- ${point}`));
  }
  if (message.sources?.length) {
    parts.push(
      "",
      "Sources:",
      ...message.sources.map((source) => {
        const label = source.section
          ? `${source.title} - ${source.section}`
          : source.title;
        return `- [${source.kind}] ${label}`;
      })
    );
  }
  if (message.confidence) {
    parts.push("", `Confidence: ${message.confidence}`);
  }
  if (message.verificationNote) {
    parts.push("", `Verification: ${message.verificationNote}`);
  }
  return clampText(parts.join("\n"), MAX_SECTION_CHARS);
}

function buildFallbackMarkdown(input: {
  generatedAt: string;
  instruction: string;
  suggestedTitle: string;
  contextSections: string[];
}): string {
  const lines = [
    `# ${input.suggestedTitle}`,
    "",
    `Generated: ${input.generatedAt}`,
  ];
  if (input.instruction) {
    lines.push(`Request: ${input.instruction}`);
  }
  lines.push(
    "",
    "> AI composition was unavailable, so this PDF exports the current canvas-cli context directly.",
    "",
    ...input.contextSections
  );
  return lines.join("\n");
}

function pushStringList(parts: string[], title: string, values?: unknown[]): void {
  if (!values?.length) return;
  parts.push(
    [`### ${title}`, ...values.map((value) => `- ${String(value)}`)].join("\n")
  );
}

function stringField(
  record: Record<string, unknown>,
  key: string
): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function arrayField(
  record: Record<string, unknown>,
  key: string
): unknown[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value : undefined;
}

function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n\n[Truncated ${text.length - maxChars} characters]`;
}

function titleCase(text: string): string {
  return text
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}
