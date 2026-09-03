import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStepReflectionNote,
  STEP_REFLECTION_WRAP_UP_THRESHOLD,
  type Observation,
  type ToolExecutionResult,
} from "../src/agent/observation.js";
import { createEmptyRunState } from "../src/agent/run-state.js";
import {
  CHAT_AGENT_MAX_STEPS,
  createTurnToolExecutor,
} from "../src/tui/chat-agent.js";
import { buildSystemPrompt } from "../src/tui/chat-agent/prompt.js";
import { buildChatTools } from "../src/tui/chat-agent/tool-defs.js";
import type { ChatAgentContext } from "../src/tui/chat-agent/types.js";
import type { LoadedWorkspace } from "../src/ask/types.js";

function createLoaded(): LoadedWorkspace {
  return {
    workspacePath: "/tmp/workspace",
    assignmentName: "Lab 4",
    courseName: "ECE243",
    courseCode: "ECE243H1",
    planMd: "",
    workupJson: { overview: "Build a timer.", deliverables: ["report"] },
    extractedFiles: [{ name: "lab4.pdf.txt", content: "Lab 4 text" }],
    resourceFiles: [],
  } as unknown as LoadedWorkspace;
}

function createContext(): ChatAgentContext {
  return {
    aiConfig: { provider: "anthropic", model: "test-model" } as any,
    loaded: createLoaded(),
    cache: null,
    client: null,
    config: null,
    courseId: null,
    conversationHistory: [],
    runState: createEmptyRunState(),
  };
}

function groundedRead(title: string): Observation {
  return {
    tool: "read_file",
    status: "ok",
    summary: `Read ${title}.`,
    artifacts: [{ artifactId: `art:${title}`, title, kind: "attachment" }],
    content: `${title} full text`,
  };
}

function searchHit(title: string): Observation {
  return {
    tool: "search_workspace",
    status: "ok",
    summary: `Found 1 relevant workspace matches for "${title}".`,
    artifacts: [{ artifactId: `art:${title}`, title, kind: "attachment" }],
  };
}

function failedRead(title: string): Observation {
  return {
    tool: "read_file",
    status: "not_found",
    summary: `File "${title}" not found.`,
    artifacts: [],
  };
}

test("system prompt teaches a plan-investigate-reflect loop with a visible step budget", () => {
  const prompt = buildSystemPrompt(createContext(), { maxSteps: 30 });

  assert.match(prompt, /budget of up to 30 tool calls this turn/);
  assert.match(prompt, /Plan before the first tool call/);
  assert.match(prompt, /Reflect after every tool result/);
  assert.match(prompt, /Routing table/);
  assert.match(prompt, /Recover from dead ends by changing source class/);
  assert.match(prompt, /Finish only when the question is actually answered/);
  assert.match(prompt, /It is a SUMMARY produced earlier, not the source material/);
  assert.match(prompt, /a longer document ends with a note naming the sections that were not included/);
  assert.match(prompt, /call read_file with section \(e\.g\. section "Page 57"/);
  assert.match(prompt, /list_announcements with a keyword, then read_thread/);

  // Brevity-biased instructions must be gone.
  assert.doesNotMatch(prompt, /Use tools ONLY when/);
  assert.doesNotMatch(prompt, /Stop calling tools as soon as/);
  assert.doesNotMatch(prompt, /For simple questions, keep it brief/);
  assert.doesNotMatch(prompt, /answer directly from this context WITHOUT using tools/);

  // Guidance that other modules and tests rely on is preserved.
  assert.match(prompt, /Treat search_workspace and search_course as discovery tools only/);
  assert.match(prompt, /follow a search with read_file/);
  assert.match(prompt, /If a read or search just failed, do not repeat the same tool call/);
  assert.match(prompt, /Before calling any tool, ALWAYS write a brief sentence/);
});

test("system prompt still reads as plain text without a step budget", () => {
  const prompt = buildSystemPrompt(createContext());
  assert.match(prompt, /generous tool-call budget/);
  assert.doesNotMatch(prompt, /budget of up to \d+ tool calls/);
});

test("tool descriptions make scope and follow-up unambiguous", () => {
  const tools = buildChatTools({
    cache: { modules: [], lectures: [{ title: "L1" }] } as any,
    client: {} as any,
    radar: {} as any,
    courseId: 17,
    assignments: [],
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool.description]));

  assert.match(byName.get("search_workspace") ?? "", /does NOT cover announcements/);
  assert.match(byName.get("search_workspace") ?? "", /Best first tool when you do not know which document/);
  assert.match(byName.get("search_course") ?? "", /Broader than search_workspace/);
  assert.match(byName.get("read_file") ?? "", /120,000 characters/);
  assert.match(byName.get("read_file") ?? "", /pass section/);
  assert.match(byName.get("read_file") ?? "", /rubric or grading page are usually both needed/);
  assert.match(byName.get("list_announcements") ?? "", /deadline change, extension/);
  assert.match(byName.get("list_announcements") ?? "", /follow up with read_thread/);
  assert.match(byName.get("read_thread") ?? "", /grounding tool for announcements/);
  assert.match(byName.get("download_course_file") ?? "", /doubles as a read/);
});

test("step reflection note classifies evidence and reports the budget", () => {
  const grounded = buildStepReflectionNote({
    step: 2,
    maxSteps: 30,
    observation: groundedRead("lab4.pdf"),
  });
  assert.match(grounded, /^\[Tool step 2 of 30; 28 remaining\./);
  assert.match(grounded, /full source text/);
  assert.match(grounded, /rather than concluding it is unspecified/);
  assert.match(grounded, /Do not stop because you have already used several tools/);
  assert.ok(grounded.endsWith("]"));

  const discovery = buildStepReflectionNote({
    step: 1,
    maxSteps: 30,
    observation: searchHit("rubric.pdf"),
  });
  assert.match(discovery, /candidate sources, not evidence/);
  assert.match(discovery, /read_file, read_thread, or download_course_file/);

  const failure = buildStepReflectionNote({
    step: 3,
    maxSteps: 30,
    observation: failedRead("missing.pdf"),
  });
  assert.match(failure, /Dead end\. Do not retry the same target/);
  assert.match(failure, /list_announcements/);
  assert.match(failure, /search_course/);

  const deduped = buildStepReflectionNote({
    step: 4,
    maxSteps: 30,
    observation: searchHit("rubric.pdf"),
    deduped: true,
  });
  assert.match(deduped, /already made this exact call this turn/);
});

test("step reflection note pushes comparison questions toward a second grounded read", () => {
  const oneRead = buildStepReflectionNote({
    step: 1,
    maxSteps: 30,
    observation: groundedRead("spec.pdf"),
    needsMultipleSources: true,
    groundedReadCount: 1,
  });
  assert.match(oneRead, /you have 1 grounded read\(s\) so far; read a second relevant source/);

  const twoReads = buildStepReflectionNote({
    step: 2,
    maxSteps: 30,
    observation: groundedRead("announcement.txt"),
    needsMultipleSources: true,
    groundedReadCount: 2,
  });
  assert.doesNotMatch(twoReads, /read a second relevant source/);
});

test("step reflection note tells the model to wrap up as the budget runs out", () => {
  const nearEnd = buildStepReflectionNote({
    step: 30 - STEP_REFLECTION_WRAP_UP_THRESHOLD,
    maxSteps: 30,
    observation: groundedRead("spec.pdf"),
  });
  assert.match(nearEnd, new RegExp(`Only ${STEP_REFLECTION_WRAP_UP_THRESHOLD} tool call\\(s\\) remain`));
  assert.doesNotMatch(nearEnd, /Do not stop because/);

  const exhausted = buildStepReflectionNote({
    step: 30,
    maxSteps: 30,
    observation: groundedRead("spec.pdf"),
  });
  assert.match(exhausted, /budget is exhausted\. Answer now/);
  assert.ok(exhausted.endsWith("]"));
});

test("turn tool executor appends the reflection footer to model text only and tracks steps", async () => {
  const ctx = createContext();
  const pending: ToolExecutionResult[] = [];
  const calls: string[] = [];
  const results: Record<string, ToolExecutionResult> = {
    search_workspace: {
      observation: searchHit("lab4.pdf"),
      modelText: "lab4.pdf: snippet",
      uiText: "lab4.pdf: snippet",
    },
    read_file: {
      observation: groundedRead("lab4.pdf"),
      modelText: "lab4.pdf full text",
      uiText: "lab4.pdf full text",
    },
  };

  const executeTool = createTurnToolExecutor({
    ctx,
    question: "How does the spec differ from the announcement?",
    observationStart: 0,
    turnToolCache: new Map(),
    pendingToolResults: pending,
    maxSteps: 5,
    execute: async (_cache, name) => {
      calls.push(name);
      return { result: results[name]!, deduped: name === "search_workspace" && calls.length > 2 };
    },
  });

  const first = await executeTool("search_workspace", { query: "lab 4" });
  assert.ok(first.startsWith("lab4.pdf: snippet\n\n[Tool step 1 of 5; 4 remaining."));
  assert.match(first, /candidate sources, not evidence/);

  const second = await executeTool("read_file", { filename: "lab4.pdf" });
  assert.match(second, /\[Tool step 2 of 5; 3 remaining\./);
  assert.match(second, /full source text/);
  assert.match(second, /you have 1 grounded read\(s\) so far; read a second relevant source/);
  assert.match(second, /Only 3 tool call\(s\) remain/);

  const third = await executeTool("search_workspace", { query: "lab 4" });
  assert.match(third, /\[Tool step 3 of 5; 2 remaining\./);
  assert.match(third, /already made this exact call this turn/);

  // UI text and run-state stay free of the footer; deduped calls are not re-recorded.
  assert.equal(pending.length, 3);
  assert.ok(pending.every((entry) => !entry.uiText.includes("[Tool step")));
  assert.ok(pending.every((entry) => !entry.modelText.includes("[Tool step")));
  assert.equal(ctx.runState.observations.length, 2);
  assert.ok(
    ctx.runState.observations.every(
      (observation) => !(observation.content ?? "").includes("[Tool step")
    )
  );
});

test("turn tool executor defaults to the shared chat step budget", async () => {
  const ctx = createContext();
  const executeTool = createTurnToolExecutor({
    ctx,
    question: "What is due?",
    observationStart: 0,
    turnToolCache: new Map(),
    pendingToolResults: [],
    execute: async () => ({
      result: {
        observation: groundedRead("spec.pdf"),
        modelText: "text",
        uiText: "text",
      },
      deduped: false,
    }),
  });

  const text = await executeTool("read_file", { filename: "spec.pdf" });
  assert.match(text, new RegExp(`\\[Tool step 1 of ${CHAT_AGENT_MAX_STEPS};`));
});
