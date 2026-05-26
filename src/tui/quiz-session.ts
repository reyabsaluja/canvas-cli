import chalk from "chalk";
import {
  clearScreen,
  createBuffer,
  getTermSize,
  wrapText,
  visibleWidth,
} from "./screen.js";
import { USER_ABORT_EXIT_CODE } from "./chat-shell-exit.js";
import type { QuizQuestion, QuizResult, MCQuestion, TFQuestion, FillQuestion, FlashQuestion } from "./quiz-command.js";

const B = {
  dim: chalk.hex("#505050"),
  white: chalk.white,
  bold: chalk.white.bold,
  green: chalk.hex("#6ec86a"),
  red: chalk.hex("#ff6b6b"),
  yellow: chalk.hex("#e8a86d"),
  muted: chalk.hex("#808080"),
};

export async function runQuizSession(
  questions: QuizQuestion[],
  courseName: string | null
): Promise<QuizResult> {
  const answers: (boolean | null)[] = [];
  const times: number[] = [];

  const stdin = process.stdin;

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    const startTime = Date.now();
    const result = await presentQuestion(q, i, questions.length, stdin);
    times.push(Math.round((Date.now() - startTime) / 1000));

    if (result === "quit") {
      answers.push(null);
      break;
    }

    answers.push(result);
    await showFeedback(q, result, stdin);
  }

  return { questions, answers, times };
}

function presentQuestion(
  q: QuizQuestion,
  index: number,
  total: number,
  stdin: NodeJS.ReadStream
): Promise<boolean | "quit"> {
  switch (q.type) {
    case "mc": return presentMC(q, index, total, stdin);
    case "tf": return presentTF(q, index, total, stdin);
    case "fill": return presentFill(q, index, total, stdin);
    case "flash": return presentFlash(q, index, total, stdin);
  }
}

function presentMC(q: MCQuestion, index: number, total: number, stdin: NodeJS.ReadStream): Promise<boolean | "quit"> {
  return new Promise((resolve) => {
    renderQuestionBox(q.stem, index, total, "MC", q.choices.map(c => `${c.label}) ${c.text}`));

    function onData(key: string) {
      if (key === "\x03") { cleanup(); process.exit(USER_ABORT_EXIT_CODE); }
      if (key === "\x1B" || key === "q") { cleanup(); resolve("quit"); return; }
      if (key === "s") { cleanup(); resolve(false); return; }
      const lower = key.toLowerCase();
      if (["a", "b", "c", "d"].includes(lower) && q.choices.some(c => c.label === lower)) {
        cleanup();
        resolve(lower === q.answer.toLowerCase());
        return;
      }
    }

    stdin.on("data", onData);
    function cleanup() { stdin.removeListener("data", onData); }
  });
}

function presentTF(q: TFQuestion, index: number, total: number, stdin: NodeJS.ReadStream): Promise<boolean | "quit"> {
  return new Promise((resolve) => {
    renderQuestionBox(q.stem, index, total, "T/F", ["t) True", "f) False"]);

    function onData(key: string) {
      if (key === "\x03") { cleanup(); process.exit(USER_ABORT_EXIT_CODE); }
      if (key === "\x1B" || key === "q") { cleanup(); resolve("quit"); return; }
      if (key === "s") { cleanup(); resolve(false); return; }
      const lower = key.toLowerCase();
      if (lower === "t") { cleanup(); resolve(q.answer === true); return; }
      if (lower === "f") { cleanup(); resolve(q.answer === false); return; }
    }

    stdin.on("data", onData);
    function cleanup() { stdin.removeListener("data", onData); }
  });
}

function presentFill(q: FillQuestion, index: number, total: number, stdin: NodeJS.ReadStream): Promise<boolean | "quit"> {
  return new Promise((resolve) => {
    let input = "";

    function render() {
      renderQuestionBox(q.stem, index, total, "Fill", [], `  Answer: ${input}█`);
    }
    render();

    function onData(key: string) {
      if (key === "\x03") { cleanup(); process.exit(USER_ABORT_EXIT_CODE); }
      if (key === "\x1B" || (key === "q" && input === "")) { cleanup(); resolve("quit"); return; }
      if (key === "\r" || key === "\n") {
        cleanup();
        const trimmed = input.trim().toLowerCase();
        const correct = q.accepted.some(a => a.toLowerCase() === trimmed);
        resolve(correct);
        return;
      }
      if (key === "\x7F" || key === "\b") {
        input = input.slice(0, -1);
        render();
        return;
      }
      if (key.length === 1 && key >= " ") {
        input += key;
        render();
      }
    }

    stdin.on("data", onData);
    function cleanup() { stdin.removeListener("data", onData); }
  });
}

function presentFlash(q: FlashQuestion, index: number, total: number, stdin: NodeJS.ReadStream): Promise<boolean | "quit"> {
  return new Promise((resolve) => {
    renderQuestionBox(q.term, index, total, "Flash", [], `\n  ${B.muted("[press space to reveal]")}`);

    let revealed = false;

    function onData(key: string) {
      if (key === "\x03") { cleanup(); process.exit(USER_ABORT_EXIT_CODE); }
      if (key === "\x1B" || key === "q") { cleanup(); resolve("quit"); return; }

      if (!revealed && key === " ") {
        revealed = true;
        const { cols } = getTermSize();
        const defWidth = Math.max(30, cols - 12);
        const wrapped = wrapText(q.definition, defWidth);
        renderQuestionBox(q.term, index, total, "Flash", [], `\n  ${wrapped}\n\n  ${B.green("[y]")} ${B.muted("Got it")}    ${B.red("[n]")} ${B.muted("Missed it")}    ${B.muted("[q] Quit")}`);
        return;
      }

      if (revealed) {
        const lower = key.toLowerCase();
        if (lower === "y") { cleanup(); resolve(true); return; }
        if (lower === "n") { cleanup(); resolve(false); return; }
      }
    }

    stdin.on("data", onData);
    function cleanup() { stdin.removeListener("data", onData); }
  });
}

function renderQuestionBox(
  stem: string,
  index: number,
  total: number,
  tag: string,
  options: string[],
  footer?: string
): void {
  const { cols } = getTermSize();
  const boxWidth = Math.min(cols - 6, 90);
  const innerWidth = boxWidth - 4;
  const optionIndent = 2;
  const optionWidth = innerWidth - optionIndent;
  const buf = createBuffer();

  clearScreen();
  buf.push("");

  const headerLeft = `Question ${index + 1} of ${total}`;
  const headerRight = `[${tag}]`;
  const headerGap = Math.max(1, innerWidth - headerLeft.length - headerRight.length);

  buf.push(`  ${B.dim("┌" + "─".repeat(boxWidth) + "┐")}`);
  buf.push(`  ${B.dim("│")}  ${B.muted(headerLeft)}${" ".repeat(headerGap)}${B.muted(headerRight)}  ${B.dim("│")}`);
  buf.push(`  ${B.dim("│")}${" ".repeat(boxWidth)}${B.dim("│")}`);

  const stemLines = wrapText(stem, innerWidth).split("\n");
  for (const line of stemLines) {
    const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
    buf.push(`  ${B.dim("│")}  ${B.white(line)}${pad}  ${B.dim("│")}`);
  }

  if (options.length > 0) {
    buf.push(`  ${B.dim("│")}${" ".repeat(boxWidth)}${B.dim("│")}`);
    for (const opt of options) {
      const optLines = wrapText(opt, optionWidth).split("\n");
      for (let j = 0; j < optLines.length; j++) {
        const prefix = j === 0 ? " ".repeat(optionIndent) : " ".repeat(optionIndent + 3);
        const text = optLines[j]!;
        const totalUsed = optionIndent + (j === 0 ? 0 : 3) + visibleWidth(text);
        const pad = " ".repeat(Math.max(0, innerWidth - totalUsed));
        buf.push(`  ${B.dim("│")}  ${prefix}${B.white(text)}${pad}  ${B.dim("│")}`);
      }
    }
  }

  buf.push(`  ${B.dim("│")}${" ".repeat(boxWidth)}${B.dim("│")}`);
  buf.push(`  ${B.dim("└" + "─".repeat(boxWidth) + "┘")}`);

  if (footer) {
    buf.push(footer);
  } else {
    buf.push("");
    buf.push(`  ${B.muted("Answer:")} █`);
  }

  buf.push("");
  buf.push(`  ${B.dim("[s] skip  [q] quit")}`);
  buf.flush();
}

function showFeedback(q: QuizQuestion, correct: boolean, stdin: NodeJS.ReadStream): Promise<void> {
  return new Promise((resolve) => {
    const buf = createBuffer();
    clearScreen();
    buf.push("");

    if (correct) {
      buf.push(`  ${B.green("✓ Correct!")}`);
    } else {
      const answerStr = getAnswerString(q);
      buf.push(`  ${B.red("✗ Incorrect")} ${B.muted("— the answer is")} ${B.white(answerStr)}`);
    }

    buf.push("");

    const explanation = getExplanation(q);
    if (explanation) {
      const { cols } = getTermSize();
      const wrapped = wrapText(explanation, Math.max(30, cols - 8));
      for (const line of wrapped.split("\n")) {
        buf.push(`    ${B.muted(line)}`);
      }
    }

    buf.push("");
    buf.push(`  ${B.dim("[press any key for next question]")}`);
    buf.flush();

    function onData(_key: string) {
      if (_key === "\x03") { cleanup(); process.exit(USER_ABORT_EXIT_CODE); }
      cleanup();
      resolve();
    }

    stdin.on("data", onData);
    function cleanup() { stdin.removeListener("data", onData); }
  });
}

function getAnswerString(q: QuizQuestion): string {
  switch (q.type) {
    case "mc": {
      const choice = q.choices.find(c => c.label === q.answer);
      return choice ? `${q.answer}) ${choice.text}` : q.answer;
    }
    case "tf": return q.answer ? "True" : "False";
    case "fill": return q.accepted[0] ?? "";
    case "flash": return q.definition.slice(0, 60);
  }
}

function getExplanation(q: QuizQuestion): string {
  if (q.type === "flash") return q.definition;
  return q.explanation;
}

export function renderScoreScreen(result: QuizResult, courseName: string | null): string {
  const lines: string[] = [];
  const answered = result.answers.filter(a => a !== null);
  const correct = answered.filter(a => a === true).length;
  const total = answered.length;
  const pct = total > 0 ? Math.round((correct / total) * 100) : 0;

  const scoreColor = pct >= 90 ? B.green : pct >= 70 ? B.yellow : B.red;
  const verdict = pct >= 90
    ? "Excellent work!"
    : pct >= 70
      ? "Good — review the topics you missed."
      : "Keep studying — review the topics below.";

  const barWidth = 30;
  const filled = Math.round((correct / Math.max(total, 1)) * barWidth);
  const bar = scoreColor("━".repeat(filled)) + B.dim("━".repeat(barWidth - filled));

  lines.push("");
  lines.push(`  ${B.bold(courseName ? `${courseName} — Quiz Results` : "Quiz Results")}`);
  lines.push("");
  lines.push(`  ${bar}  ${scoreColor(`${correct}/${total}`)} ${B.dim(`(${pct}%)`)}`);
  lines.push("");
  lines.push(`  ${scoreColor(verdict)}`);

  const topics = new Map<string, { correct: number; total: number }>();
  for (let i = 0; i < result.questions.length; i++) {
    const q = result.questions[i]!;
    const a = result.answers[i];
    if (a === null) continue;
    const entry = topics.get(q.topic) ?? { correct: 0, total: 0 };
    entry.total++;
    if (a) entry.correct++;
    topics.set(q.topic, entry);
  }

  if (topics.size > 0) {
    const topicNames = [...topics.keys()];
    const maxTopicLen = Math.max(...topicNames.map(t => t.length));
    const scoreColWidth = Math.max(...[...topics.values()].map(s => `${s.correct}/${s.total}`.length));
    // padding(2) + icon(1) + space(1) + topic + space(2) + score + padding(2)
    const rowWidth = 2 + 1 + 1 + maxTopicLen + 2 + scoreColWidth + 2;
    const headerLabel = " Topics ";
    const dashTotal = Math.max(0, rowWidth - headerLabel.length);
    const dashLeft = Math.floor(dashTotal / 3);
    const dashRight = dashTotal - dashLeft;

    lines.push("");
    lines.push(`  ${B.dim("┌" + "─".repeat(dashLeft) + headerLabel + "─".repeat(dashRight) + "┐")}`);
    for (const [topic, stats] of topics) {
      const topicColor = stats.correct === stats.total ? B.green : stats.correct === 0 ? B.red : B.yellow;
      const icon = stats.correct === stats.total ? "●" : stats.correct === 0 ? "○" : "◐";
      const scoreStr = `${stats.correct}/${stats.total}`;
      const gap = " ".repeat(Math.max(1, maxTopicLen - topic.length + 2 + scoreColWidth - scoreStr.length));
      lines.push(`  ${B.dim("│")}  ${topicColor(icon)} ${B.white(topic)}${gap}${B.dim(scoreStr)}  ${B.dim("│")}`);
    }
    lines.push(`  ${B.dim("└" + "─".repeat(rowWidth) + "┘")}`);
  }

  const avgTime = result.times.length > 0
    ? Math.round(result.times.reduce((a, b) => a + b, 0) / result.times.length)
    : 0;
  if (avgTime > 0) {
    lines.push("");
    lines.push(`  ${B.dim("Time:")} ${B.muted(`${avgTime}s avg`)}`);
  }

  lines.push("");
  lines.push(`  ${B.dim("─".repeat(40))}`);
  lines.push(`  ${B.muted("/quiz")} ${B.dim("new")}  ${B.muted("/quiz retry")} ${B.dim("missed")}`);

  return lines.join("\n");
}
