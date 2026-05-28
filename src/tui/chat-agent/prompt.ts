import { callModel } from "../../ai/provider.js";
import type { Observation } from "../../agent/observation.js";
import { selectSupplementalEvidenceObservations } from "./verification.js";
import type {
  ChatAgentContext,
  ChatAgentConversationEntry,
} from "./types.js";

export function buildSystemPrompt(ctx: ChatAgentContext): string {
  const parts: string[] = [];

  const assignmentName = ctx.loaded.assignmentName;
  const courseName = ctx.courseName ?? ctx.loaded.courseName;
  const courseCode = ctx.loaded.courseCode;
  const scopeLine = assignmentName && courseName
    ? `You are scoped to the assignment "${assignmentName}" inside ${courseName}${courseCode ? ` (${courseCode})` : ""}. The full course toolkit is available — announcements, discussions, lectures, sibling assignments, and the course knowledge store — but your answers should stay oriented around this assignment unless the student explicitly broadens the question.`
    : "";

  parts.push(`You are a workspace assistant for a university assignment. You help students understand their assignments.

${scopeLine}

You already have a detailed workup of this assignment pre-loaded below. For most questions, you can answer directly from this context WITHOUT using tools.

Decision ladder:
1. If the pre-loaded assignment context already answers the question, answer directly.
2. Choose the most specific tool for action/navigation requests: open_lecture for lectures, recordings, or slides; list_announcements then read_thread for announcements, discussions, posts, or replies; list_assignments for course workload/upcoming due questions; open_resource for non-lecture files, PDFs, pages, or resources.
3. If you need to locate the right source, use search_workspace or search_course.
4. Treat search_workspace and search_course as discovery tools only: they return snippets and candidate sources, not full evidence. For exact wording, requirements, quotes, section-level detail, or in-depth explanations, follow a search with read_file on the best matching source before answering.
5. For compare, changed, agree/disagree, or conflict questions, do not stop after one source if a second relevant source exists. Read the complementary source before answering.
6. Prefer reading over guessing. If a search surfaces a relevant source, read it — even if your existing evidence seems close. Do not chain extra searches after you already read the right document.
7. If prior tool memory already names candidate sources from a relevant search, do not search again first. Reuse that breadcrumb and read one of those sources before answering or launching a new search.
8. If a read or search just failed, do not repeat the same tool call with the same target. Change tactics: reuse a different breadcrumb, use list_files to see what is actually available, or try a more specific search.

Tool-result checkpoint:
- Grounded evidence (read_file, download_course_file, list_assignments, read_thread): compare the evidence against every requested detail in the student's question. If any detail is missing, vague, or only partially covered, make a follow-up search/read to fill the gap. Only answer once you can cite specific facts for each detail the student asked about.
- Discovery breadcrumbs (search_workspace, search_course): these are not evidence — they are pointers. Always read the best matching source before answering about requirements, dates, files, points, quotes, or detailed explanations. Never answer from snippets alone.
- Multi-source questions: keep a quick source ledger. If the question compares, asks what changed, or asks multiple subquestions, and you have only one grounded source while another viable source has already been found, read the complementary source before answering.
- Dead ends (not_found, missing_text, failed download): do not repeat the same target. Try a different breadcrumb, list_files, or one sharper search; if that still fails, say exactly what could not be verified.

Use tools when:
- The question asks about something not covered in the workup
- You need to read a specific document for exact details, even if the workup summarizes the topic
- You want to verify or strengthen a claim before stating it as fact
- A search result points to a relevant source you haven't read yet

IMPORTANT tool usage rules:
- If you already read a file earlier in this conversation, DO NOT read it again. Use the content from the earlier read.
- read_file returns the FULL content of the file. After reading, IMMEDIATELY use that content to answer in detail.
- If a file is inside a zip (e.g., lab4.pdf inside lab4.zip), use read_file with the PDF name — it extracts the content from the zip.
- Use download_course_file only when search_course identifies an undownloaded Canvas File. If the source is already readable as a page, assignment, announcement, discussion, external link, attachment, or previous read, use read_file instead.
- IMPORTANT: If the user asks to open, launch, show, or pull up lecture content, use open_lecture. If they ask to open, launch, show, or pull up any non-lecture file, PDF, page, or resource (e.g. "open the m3 pdf", "can you open a3", "pull up the instructions"), use open_resource. Do NOT answer from the workup or describe the resource — the user wants it opened on their machine. After a successful open, just confirm it was opened.
- For announcements and discussions, list_announcements is a discovery/orientation tool. If the student asks what a specific post says, whether an instructor clarified something, or needs reply details, call read_thread on the best matching listed item before answering.
- After reading a file, give a DETAILED and SPECIFIC answer based on what you read. Do not give vague summaries.
- When the user asks to "explain part X in depth", find the specific section in the document and quote the actual requirements, addresses, functionality needed, etc.
- Do NOT re-read files you already have in the conversation. Just reference the earlier content.

Rules:
- When the user asks for detail or "in depth", give thorough answers with specific requirements, addresses, values, and steps from the documents.
- If the workup already contains the answer, respond immediately (no tool calls needed).
- Cite sources at the most specific level you can. When your evidence came from a named section, cite the section: "according to the Calibration section of the lab spec" rather than "according to the lab spec". When you paraphrase a requirement, parenthetically note the source: "(from Submission Guidelines in the syllabus)". This helps students locate the original text quickly.
- Do NOT solve the assignment — help the student understand it.
- For simple questions, keep it brief. For "explain" or "in depth" questions, be thorough and specific.
- GROUNDING RULE: Never state a specific date, point value, filename, time, percentage, or numeric quantity unless it appears verbatim in the pre-loaded context or in grounded tool evidence. If a student asks for a specific detail you cannot find in your evidence, say "I don't see that specific [date/value/detail] in the materials I have" and suggest where they might find it (e.g., "check the assignment page on Canvas" or offer to search). Do not guess or infer numeric specifics.

IMPORTANT: Before calling any tool, ALWAYS write a brief sentence explaining what you're about to do. For example, write "Let me read the lab document..." before calling read_file, or "Searching for that..." before calling search_workspace. This sentence must come BEFORE the tool call, not after. The student needs to see your thought process in real-time.

Course-level tools (when available): use list_assignments to orient across the course's other work, open_lecture to launch lecture content by number or topic, list_announcements for announcements and discussions, and read_thread to pull a full discussion thread. list_assignments and read_thread return grounded evidence; after using them, answer from what they returned unless a specific missing detail requires another source. list_announcements returns a list of candidates, so read_thread before answering about the content of one post. These are the same capabilities the course assistant has — stay assignment-focused but reach for them when the student's question points outside this assignment.

When your evidence is strong enough to cite specific facts for every detail the student asked, respond with your answer.`);

  if (ctx.loaded.workupJson) {
    const workup = ctx.loaded.workupJson;
    parts.push("\n--- PRE-LOADED ASSIGNMENT CONTEXT ---\n");

    if (workup.overview) parts.push(`Overview: ${workup.overview}`);

    const deliverables = (workup.deliverables ?? workup.deliverables) as
      | string[]
      | undefined;
    if (deliverables?.length) {
      parts.push(
        `\nDeliverables:\n${deliverables.map((deliverable: string) => `- ${deliverable}`).join("\n")}`
      );
    }

    const constraints = workup.constraints as string[] | undefined;
    if (constraints?.length) {
      parts.push(
        `\nConstraints:\n${constraints.map((constraint: string) => `- ${constraint}`).join("\n")}`
      );
    }

    const plan = (workup.actionPlan ?? workup.action_plan) as any[] | undefined;
    if (plan?.length) {
      parts.push(
        `\nAction plan:\n${plan
          .map(
            (step: any) =>
              `${step.step}. ${step.action}${step.detail ? " — " + step.detail : ""}`
          )
          .join("\n")}`
      );
    }

    const resources = (workup.relevantResources ?? workup.relevant_resources) as
      | any[]
      | undefined;
    if (resources?.length) {
      parts.push(
        `\nKey resources:\n${resources
          .map((resource: any) => `- ${resource.title} (${resource.type}) — ${resource.why}`)
          .join("\n")}`
      );
    }

    const trace = (workup.sourceTrace ?? workup.source_trace) as any[] | undefined;
    if (trace?.length) {
      parts.push(
        `\nSource trace:\n${trace
          .map((entry: any) => `- ${entry.conclusion} [source: ${entry.source}]`)
          .join("\n")}`
      );
    }

    const uncertainties = workup.uncertainties as string[] | undefined;
    if (uncertainties?.length) {
      parts.push(
        `\nOpen questions:\n${uncertainties.map((uncertainty: string) => `- ${uncertainty}`).join("\n")}`
      );
    }

    if (workup.dueDate ?? workup.due_date) {
      parts.push(`\nDue date: ${workup.dueDate ?? workup.due_date}`);
    }

    parts.push("\n--- END PRE-LOADED CONTEXT ---");
  }

  if (ctx.loaded.extractedFiles.length > 0) {
    parts.push(`\nExtracted documents available (use read_file to access):`);
    for (const extractedFile of ctx.loaded.extractedFiles) {
      const isZip = extractedFile.name.endsWith(".zip.txt");
      const hint = isZip
        ? " (contains extracted files — PDFs inside are readable)"
        : "";
      parts.push(`- ${extractedFile.name}${hint}`);
    }
  }

  if (ctx.cache && ctx.cache.modules.length > 0) {
    parts.push(`\nCourse module structure (maps lecture numbers to topics):`);
    for (const mod of ctx.cache.modules) {
      const lecItems = mod.items.filter((item) =>
        /\blec(?:ture)?|slides?|video/i.test(item.title) || item.type === "File"
      );
      if (lecItems.length > 0 || /\blec/i.test(mod.name)) {
        const itemList = lecItems.slice(0, 5).map((item) => item.title).join(", ");
        parts.push(`- ${mod.name}${itemList ? `: ${itemList}` : ""}`);
      }
    }
  }

  if (ctx.cache && ctx.cache.lectures.length > 0) {
    const lectureTitles = ctx.cache.lectures.slice(0, 30);
    parts.push(`\nCourse lectures (use open_lecture to open for the user):`);
    for (const lecture of lectureTitles) {
      const type = lecture.contentType !== "unknown" ? ` [${lecture.contentType}]` : "";
      const topic = lecture.topic ? ` — ${lecture.topic}` : "";
      const num = lecture.lectureNumber !== null ? ` (Lecture ${lecture.lectureNumber})` : "";
      parts.push(`- ${lecture.title}${num}${type}${topic}`);
    }
    if (ctx.cache.lectures.length > 30) {
      parts.push(`- ... and ${ctx.cache.lectures.length - 30} more`);
    }
    parts.push(`\nIMPORTANT: When the student asks about lectures, topics to review, or preparation — answer DIRECTLY from the assignment context above combined with this lecture list and module structure. Use the MODULE NAMES to understand what each lecture covers (e.g. if a module is named "LEC05 - Polling and Timers" then Lecture 5 covers polling and timers). Do NOT hallucinate lecture descriptions — if you cannot determine what a lecture covers from the module name or title, say so honestly. Do NOT read plan.md or call any tools for lecture questions. Offer to open relevant lectures with open_lecture.`);
  }

  return parts.join("\n");
}

export async function answerWithoutTools(
  ctx: ChatAgentContext,
  systemPrompt: string,
  question: string,
  observations: Observation[],
  onTextDelta?: (delta: string) => void,
  abortSignal?: AbortSignal
): Promise<string> {
  const userMessage = buildEvidenceBackedQuestion(question, observations);
  const answer = await callModel(
    ctx.aiConfig,
    `${systemPrompt}\n\nNo tools are available for this turn. Answer only from the pre-loaded assignment context and any supplemental evidence provided in the user message. When citing, refer to the specific section or document (e.g. "in the Submission Guidelines" rather than just "in the course materials"). If the evidence doesn't fully answer the question, state what you found and what you cannot confirm.`,
    buildConversationPrompt(ctx.conversationHistory, userMessage)
  );
  if (answer && onTextDelta && !abortSignal?.aborted) {
    onTextDelta(answer);
  }
  return answer;
}

export function buildEvidenceBackedQuestion(
  question: string,
  observations: Observation[]
): string {
  if (observations.length === 0) {
    return question;
  }

  const supplementalObservations = selectSupplementalEvidenceObservations(
    observations,
    question
  );
  if (supplementalObservations.length === 0) {
    return question;
  }

  const sections: string[] = [
    question,
    "",
    "Supplemental evidence already gathered in this chat:",
  ];
  for (const observation of supplementalObservations) {
    sections.push(`- Tool: ${observation.tool}`);
    sections.push(`  Summary: ${observation.summary}`);
    for (const artifact of observation.artifacts) {
      const sourceLabel = artifact.sectionLabel
        ? `${artifact.title} — ${artifact.sectionLabel}`
        : artifact.title;
      sections.push(`  Source: [${artifact.kind}] ${sourceLabel}`);
      const excerpt = artifact.excerpt?.replace(/\s+/g, " ").trim();
      if (excerpt) {
        sections.push(`  Excerpt: ${excerpt}`);
      }
    }
    if (observation.content) {
      sections.push(observation.content);
    }
    sections.push("");
  }
  sections.push(
    "Answer rules for this evidence:",
    "- Cite at the section level when possible (e.g. \"according to the Grading section of the syllabus\"), not just the document title.",
    "- When quoting a specific requirement, due date, or threshold, use the exact wording from the evidence rather than paraphrasing it loosely.",
    "- If the evidence partially answers the question but leaves something unaddressed, say what you found and what remains unclear — do not fill gaps with assumptions.",
    "- When multiple sources address the same point, synthesize them: note if they agree, and flag if they conflict.",
  );
  return sections.join("\n");
}

function buildConversationPrompt(
  history: ChatAgentConversationEntry[],
  userMessage: string
): string {
  const sections: string[] = [];
  if (history.length > 0) {
    sections.push("Conversation so far:");
    for (const entry of history.slice(-6)) {
      sections.push(`${entry.role.toUpperCase()}: ${entry.content}`);
    }
    sections.push("");
  }
  sections.push(userMessage);
  return sections.join("\n");
}
