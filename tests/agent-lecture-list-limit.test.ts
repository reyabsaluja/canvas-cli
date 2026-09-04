import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemPrompt, PROMPT_LECTURE_LIST_LIMIT, PROMPT_MODULE_ITEM_LIMIT } from "../src/tui/chat-agent/prompt.js";
import type { ChatAgentContext } from "../src/tui/chat-agent/types.js";

function ctxWithLectures(count: number): ChatAgentContext {
  const lectures = Array.from({ length: count }, (_, index) => ({
    title: `Lecture ${index + 1} recording`, url: `https://x/${index + 1}`, contentType: "video", source: "page", lectureNumber: index + 1, topic: `Topic ${index + 1}`,
  }));
  const items = Array.from({ length: 12 }, (_, index) => ({ id: index, title: `Lecture slides ${index + 1}`, type: "File", position: index, contentId: null, pageUrl: null, htmlUrl: null, externalUrl: null }));
  return {
    loaded: {
      path: "/tmp/ws", sessionSlug: "lab-5", assignmentId: 1, assignmentName: "Lab 5", courseId: 17, courseName: "ECE243", courseCode: "ECE243H1",
      preparedAt: "2026-04-02T09:00:00.000Z", workspaceState: "ready", assignmentMd: "# Lab 5", planMd: null, notesMd: null, workupJson: null, extractedFiles: [], extractedFileCache: new Map(),
    },
    cache: { courseId: 17, coursePath: "/tmp/course", modules: [{ id: 1, name: "LEC01 - Intro", position: 1, itemCount: 12, items }], lectures, pages: [], assignments: [], files: [], attachments: [], syllabusCandidates: [], ingestion: null },
  } as unknown as ChatAgentContext;
}

test("before/after: the prompt lists more lectures and tells the agent how to reach the rest", () => {
  assert.ok(PROMPT_LECTURE_LIST_LIMIT >= 60, "limit must not drop below 60");
  const prompt = buildSystemPrompt(ctxWithLectures(70), { maxSteps: 30 });
  assert.match(prompt, /- Lecture 45 recording \(Lecture 45\)/, "lectures past the old cap of 30 are listed");
  assert.match(prompt, /and 10 more not listed here\. Every lecture is indexed: search_course/);
  assert.match(prompt, /open_lecture opens it/);
  assert.ok(PROMPT_MODULE_ITEM_LIMIT >= 8);
  assert.match(prompt, /Lecture slides 8/, "module structure shows more items");
  assert.match(prompt, /\(\+4 more\)/);
});

test("a short lecture list has no overflow note", () => {
  const prompt = buildSystemPrompt(ctxWithLectures(3), { maxSteps: 30 });
  assert.doesNotMatch(prompt, /more not listed here/);
});
