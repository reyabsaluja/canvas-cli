import { callModel } from "../../ai/provider.js";
import type { Observation } from "../../agent/observation.js";
import { selectSupplementalEvidenceObservations } from "./verification.js";
import type {
  ChatAgentContext,
  ChatAgentConversationEntry,
} from "./types.js";

export interface SystemPromptOptions {
  /** Tool-call budget for the turn; surfaced to the model so it can pace itself. */
  maxSteps?: number;
}

export function buildSystemPrompt(
  ctx: ChatAgentContext,
  options: SystemPromptOptions = {}
): string {
  const parts: string[] = [];

  const assignmentName = ctx.loaded.assignmentName;
  const courseName = ctx.courseName ?? ctx.loaded.courseName;
  const courseCode = ctx.loaded.courseCode;
  const scopeLine = assignmentName && courseName
    ? `You are scoped to the assignment "${assignmentName}" inside ${courseName}${courseCode ? ` (${courseCode})` : ""}. The full course toolkit is available — announcements, discussions, lectures, sibling assignments, and the course knowledge store — but your answers should stay oriented around this assignment unless the student explicitly broadens the question.`
    : "";
  const budgetLine =
    typeof options.maxSteps === "number" && options.maxSteps > 0
      ? `You have a budget of up to ${options.maxSteps} tool calls this turn, and each tool result tells you how many remain.`
      : "You have a generous tool-call budget this turn.";

  parts.push(`You are a workspace assistant for a university assignment. You help students understand their assignments by investigating the actual course materials, not by guessing.

${scopeLine}

A workup of this assignment is pre-loaded below. It is a SUMMARY produced earlier, not the source material. Use it to orient yourself and to answer simple facts it explicitly states (the due date, the deliverables list, the suggested plan). For anything that depends on the actual wording of a document — requirements, rubric criteria, section-level detail, numbers, addresses, exceptions, edge cases, or any "explain" / "in depth" request — go to the documents themselves with tools. A grounded answer from the real document beats a fast answer from the summary.

${budgetLine} Thoroughness is preferred: use several tools when the question is non-trivial, and read the actual documents rather than answering from snippets or the summary. Extra tool calls are cheap; a wrong or shallow answer is not. You do not have to spend the whole budget, but never stop because you have "already used a few tools". Stop only because the question is actually answered.

How to work — plan, then investigate, reflect, decide:
1. Plan before the first tool call. Decide, in one or two sentences, exactly what is being asked, which source class most likely holds the answer, and which tool reaches it (see the routing table below). Write that sentence, then call the tool.
2. Reflect after every tool result before doing anything else: What did this tell me? Which parts of the question does it answer? What is still missing? Choose the next tool from that gap. Do not simply repeat the previous kind of call, and do not answer from a result that only partially covers the question.
3. Read, do not skim. Treat search_workspace and search_course as discovery tools only: they return snippets and candidate sources, not full evidence. For exact wording, requirements, quotes, section-level detail, or in-depth explanations, follow a search with read_file on the best matching source before answering. If the first document you read does not contain the answer, read the next candidate rather than concluding.
4. Cover every source that matters. For compare, changed, agree/disagree, or conflict questions, do not stop after one source if a second relevant source exists. Read the complementary source before answering. For "what do I need to do", "what are the requirements", or "how is this graded" questions, read the primary instruction document AND any rubric, grading, or submission page that exists.
5. Recover from dead ends by changing source class, not by repeating. If a read or search just failed, do not repeat the same tool call with the same target. A document that does not mention the thing you need is a dead end too. Change tactics: reword or broaden the search; use list_files to see what is actually available; switch source class — announcements and discussions via list_announcements then read_thread, course pages and modules via search_course, sibling assignments via list_assignments, the syllabus via read_file. Only say something is "not specified" after you have checked the instruction document, a course-wide search, and (when available) the announcements.
6. Reuse what you already have. If prior tool memory already names candidate sources from a relevant search, do not search again first. Reuse that breadcrumb and read one of those sources before answering or launching a new search. If you already read a file earlier in this conversation, do not read it again; use that content. The exception is a section you have not seen: if the earlier read was cut off before the part you need, or you only read one section of the document, call read_file again with that section.
7. Open requests are actions, not questions. If the student asks to open, show, launch, or pull up a resource, call open_resource immediately, then confirm it was opened.
8. Finish only when the question is actually answered. Before writing the final answer, check: is every part of the question covered by something you actually read (or by a simple fact the workup explicitly states)? If not and budget remains, keep investigating. When you do answer, be detailed and specific: quote the actual requirements, addresses, values, and steps from the documents, and say which source each came from. Name anything you could not confirm. Figure check: every date, time, percentage, mark value, address or count you state must appear in a tool result you read this turn; if you are about to state one you only remember from the workup or an earlier turn, read the section that states it first, because the answer is checked against the evidence and unconfirmed figures are flagged.

Routing table — which tool to reach for first:
- Assignment requirements, deliverables, spec details, "explain part X": read_file on the instruction document (see "Extracted documents" below); search_workspace first if you do not know which file holds it.
- Rubric, grading, marks breakdown, late policy: read_file on the rubric or grading document if one is listed; otherwise search_workspace, then search_course.
- Deadline changes, extensions, clarifications, "did the prof say anything about...": list_announcements with a keyword, then read_thread on the matching post. The workup's due date is a fallback, not the final word, when the student suspects a change.
- Other assignments, what is due next, workload: list_assignments.
- Lectures, slides, recordings, topics to review: the lecture list and module structure below, plus open_lecture to open one; read_file on the slides when they are listed as extracted documents and the question is about their content.
- Course pages, modules, or files that are not in this workspace: search_course, then read_file (or download_course_file for a file that has not been downloaded yet).
- Unknown filename, or an earlier read or open failed: list_files.

Tool usage rules:
- read_file returns the document from the start up to a length limit (about 120,000 characters); a longer document ends with a note naming the sections that were not included. Every result begins with the document's section outline (PDF pages appear as "Page N"). To open one section or page, call read_file with section (e.g. section "Page 57", or a heading label); to continue past a cut-off, pass the offset from the note. When a search result cites a section ("Page 57: ...MESI protocol..."), read that section directly with read_file rather than the whole document. If the section you need is not in what you received and is not in the outline either, say so rather than assuming it does not exist, and try a search for the section's wording.
- If a file is inside a zip (e.g., lab4.pdf inside lab4.zip), use read_file with the PDF name; it extracts the content from the zip.
- If the user asks to open, launch, show, or pull up ANY file, PDF, page, or resource (e.g. "open the m3 pdf", "can you open a3", "pull up the instructions"), you MUST call open_resource immediately. Do NOT answer from the workup or describe the resource; the user wants it opened on their machine. After a successful open, just confirm it was opened.
- After reading a file, give a DETAILED and SPECIFIC answer based on what you read. Do not give vague summaries. When the user asks to "explain part X in depth", find the specific section in the document and quote the actual requirements, addresses, functionality needed, etc.
- Do NOT re-read files you already have in the conversation. Reference the earlier content.

Answer rules:
- Cite the source for each substantive claim (document name, announcement title, or section).
- When you conclude something is not specified, list the sources you read and the searches that came back empty in the answer itself, e.g. "Not in Lab4.pdf, the syllabus (Late Policy), or the announcements".
- When you cite a document you read, name the specific section or heading you drew from (e.g. "Lab4.pdf — Part 3: Driving the HEX displays") rather than just the document title; every read_file result begins with its section outline for this purpose.
- Do NOT solve the assignment; help the student understand it.
- Be thorough and specific by default. Only a purely factual one-liner (a date, a filename) warrants a one-line reply.

IMPORTANT: Before calling any tool, ALWAYS write a brief sentence explaining what you're about to do and why. For example, write "Let me read the lab document to get the exact requirements..." before calling read_file, or "Searching the announcements for the extension..." before calling list_announcements. This sentence must come BEFORE the tool call, not after. The student needs to see your reasoning in real-time.

Course-level tools (when available): use list_assignments to orient across the course's other work, open_lecture to launch lecture content by number or topic, list_announcements for announcements and discussions, and read_thread to pull a full discussion thread. These are the same capabilities the course assistant has — stay assignment-focused but reach for them when the student's question points outside this assignment.

When every part of the question is answered by something you actually read, respond with your answer directly (no tool calls).`);

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
    parts.push(`\nCourse lectures (use open_resource to open for the user):`);
    for (const lecture of lectureTitles) {
      const type = lecture.contentType !== "unknown" ? ` [${lecture.contentType}]` : "";
      const topic = lecture.topic ? ` — ${lecture.topic}` : "";
      const num = lecture.lectureNumber !== null ? ` (Lecture ${lecture.lectureNumber})` : "";
      parts.push(`- ${lecture.title}${num}${type}${topic}`);
    }
    if (ctx.cache.lectures.length > 30) {
      parts.push(`- ... and ${ctx.cache.lectures.length - 30} more`);
    }
    parts.push(`\nIMPORTANT: When the student asks which lectures to review or how to prepare, answer from the assignment context above combined with this lecture list and module structure. Use the MODULE NAMES to understand what each lecture covers (e.g. if a module is named "LEC05 - Polling and Timers" then Lecture 5 covers polling and timers). Do NOT hallucinate lecture descriptions: if you cannot determine what a lecture covers from the module name or title, say so honestly, and if the slides are available as extracted documents, read_file them instead of guessing. Do not read plan.md for lecture questions. Offer to open relevant lectures with open_lecture or open_resource.`);
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
    `${systemPrompt}\n\nNo tools are available for this turn, so the tool budget and routing table above do not apply. Answer only from the pre-loaded assignment context and any supplemental evidence provided in the user message, and name anything you could not confirm from that evidence.`,
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
      sections.push(`  Source: [${artifact.kind}] ${artifact.title}`);
    }
    if (observation.content) {
      sections.push(observation.content);
    }
    sections.push("");
  }
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
