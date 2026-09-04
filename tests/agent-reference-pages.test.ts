import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemPrompt, collectCourseReferencePages } from "../src/tui/chat-agent/prompt.js";
import type { ChatAgentContext } from "../src/tui/chat-agent/types.js";

function ctxWith(pages: Array<{ title: string }>): ChatAgentContext {
  return {
    loaded: {
      path: "/tmp/ws", sessionSlug: "lab-5", assignmentId: 1, assignmentName: "Lab 5", courseId: 17, courseName: "ECE243", courseCode: "ECE243H1",
      preparedAt: "2026-04-02T09:00:00.000Z", workspaceState: "ready", assignmentMd: "# Lab 5", planMd: null, notesMd: null, workupJson: null,
      extractedFiles: [], extractedFileCache: new Map(),
    },
    cache: { courseId: 17, coursePath: "/tmp/course", modules: [], lectures: [], pages: pages.map((page, index) => ({ pageId: `p${index}`, title: page.title, htmlUrl: null, updatedAt: null, hasBody: true })), assignments: [], files: [], attachments: [], syllabusCandidates: [], ingestion: null },
  } as unknown as ChatAgentContext;
}

test("before/after: the prompt tells the agent about the grading-scheme, course-tools and quiz pages", () => {
  const prompt = buildSystemPrompt(
    ctxWith([
      { title: "Week 1" },
      { title: "Grading scheme: assignment groups and weights" },
      { title: "Course tools and external links" },
      { title: "Quiz: Week 3 Practice Quiz" },
      { title: "Quiz: Midterm Quiz" },
    ]),
    { maxSteps: 30 }
  );
  assert.match(prompt, /Course reference pages/);
  assert.match(prompt, /"Grading scheme: assignment groups and weights" — assignment group weights/);
  assert.match(prompt, /"Course tools and external links" — Piazza/);
  assert.match(prompt, /2 quiz pages .*"Quiz: Week 3 Practice Quiz", "Quiz: Midterm Quiz"/);
  assert.match(prompt, /How much an assignment is worth.*search_course "grading scheme"/);
  assert.match(prompt, /Where to ask questions.*search_course "course tools"/);
  assert.match(prompt, /Quiz rules .*quizzes are pages titled "Quiz: <name>"/);
});

test("no reference-page block when the course has none", () => {
  assert.deepEqual(collectCourseReferencePages(ctxWith([{ title: "Week 1" }])), []);
  assert.doesNotMatch(buildSystemPrompt(ctxWith([{ title: "Week 1" }]), { maxSteps: 30 }), /Course reference pages/);
});
