import assert from "node:assert/strict";
import test from "node:test";
import {
  getMissedQuestions,
  isQuizRetry,
  rememberMissedQuestions,
  type QuizQuestion,
} from "../src/tui/quiz-command.js";
import { renderScoreScreen } from "../src/tui/quiz-session.js";

const q = (topic: string): QuizQuestion =>
  ({ type: "tf", topic, difficulty: "medium", stem: `${topic}?`, answer: true, explanation: "" }) as QuizQuestion;

test("/quiz retry is recognised only as the whole argument", () => {
  assert.equal(isQuizRetry("retry"), true);
  assert.equal(isQuizRetry("  Retry "), true);
  assert.equal(isQuizRetry("retry loops"), false);
  assert.equal(isQuizRetry("5 hard"), false);
});

test("missed questions are remembered per session and cleared by a perfect run", () => {
  const questions = [q("a"), q("b"), q("c")];
  rememberMissedQuestions("s1", { questions, answers: [true, false, null], times: [] });
  assert.deepEqual(getMissedQuestions("s1").map((x) => x.topic), ["b"]);
  assert.deepEqual(getMissedQuestions("s2"), []);
  rememberMissedQuestions("s1", { questions: [q("b")], answers: [true], times: [] });
  assert.deepEqual(getMissedQuestions("s1"), []);
});

test("the score screen offers a retry only when something was missed", () => {
  const withMiss = renderScoreScreen({ questions: [q("a"), q("b")], answers: [true, false], times: [] }, "Signals");
  assert.match(withMiss, /\/quiz retry/);
  assert.match(withMiss, /Signals — Quiz Results/);
  const perfect = renderScoreScreen({ questions: [q("a")], answers: [true], times: [] }, null);
  assert.doesNotMatch(perfect, /retry/);
});
