import chalk from "chalk";
import {
  clearScreen,
  createBuffer,
  getTermSize,
  showCursor,
  hideCursor,
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
  showCursor();

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

  hideCursor();
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
  const boxWidth = Math.min(60, cols - 6);
  const innerWidth = boxWidth - 4;
  const buf = createBuffer();

  clearScreen();
  buf.push("");

  const headerLeft = `  Question ${index + 1} of ${total}`;
  const headerRight = `[${tag}]`;
  const headerGap = Math.max(1, boxWidth - headerLeft.length - headerRight.length + 2);

  buf.push(`  ${B.dim("┌" + "─".repeat(boxWidth) + "┐")}`);
  buf.push(`  ${B.dim("│")}  ${B.muted(headerLeft.trim())}${" ".repeat(headerGap)}${B.muted(headerRight)}  ${B.dim("│")}`);
  buf.push(`  ${B.dim("│")}${" ".repeat(boxWidth)}${B.dim("│")}`);

  const stemLines = wrapText(stem, innerWidth).split("\n");
  for (const line of stemLines) {
    const pad = " ".repeat(Math.max(0, boxWidth - visibleWidth(line) - 2));
    buf.push(`  ${B.dim("│")}  ${B.white(line)}${pad}${B.dim("│")}`);
  }

  if (options.length > 0) {
    buf.push(`  ${B.dim("│")}${" ".repeat(boxWidth)}${B.dim("│")}`);
    for (const opt of options) {
      const pad = " ".repeat(Math.max(0, boxWidth - opt.length - 4));
      buf.push(`  ${B.dim("│")}    ${B.white(opt)}${pad}${B.dim("│")}`);
    }
  }

  buf.push(`  ${B.dim("│")}${" ".repeat(boxWidth)}${B.dim("│")}`);
  buf.push(`  ${B.dim("└" + "─".repeat(boxWidth) + "┘")}`);

  if (footer) {
    buf.push(footer);
  } else {
    buf.push(`  ${B.muted("Answer: ")}█`);
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

  const title = courseName ? `Quiz Complete — ${courseName}` : "Quiz Complete";
  const barWidth = 20;
  const filled = Math.round((correct / Math.max(total, 1)) * barWidth);
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);

  const scoreColor = pct >= 90 ? B.green : pct >= 70 ? B.yellow : B.red;
  const verdict = pct >= 90 ? "Excellent!" : pct >= 70 ? "Good — review missed topics." : "Needs work — focus on the areas below.";

  lines.push(`  ${B.dim("━".repeat(50))}`);
  lines.push("");
  lines.push(`  ${B.bold(title)}`);
  lines.push("");
  lines.push(`  ${B.muted("Score:")} ${scoreColor(`${correct}/${total} (${pct}%)`)}`);
  lines.push("");
  lines.push(`  ${scoreColor(bar)}  ${correct}/${total}`);
  lines.push("");
  lines.push(`  ${scoreColor(verdict)}`);

  const topics = new Map<string, { correct: number; total: number }>();
  for (let i = 0; i < result.questions.length; i++) {
    const q = result.questions[i]!;
    const a = result.answers[i];
    if (a === null) continue;
    const topic = q.topic;
    const entry = topics.get(topic) ?? { correct: 0, total: 0 };
    entry.total++;
    if (a) entry.correct++;
    topics.set(topic, entry);
  }

  if (topics.size > 1) {
    lines.push("");
    lines.push(`  ${B.muted("By topic:")}`);
    for (const [topic, stats] of topics) {
      const topicColor = stats.correct === stats.total ? B.green : stats.correct === 0 ? B.red : B.white;
      lines.push(`    ${topicColor(topic.padEnd(22))} ${stats.correct}/${stats.total}`);
    }
  }

  const missed: string[] = [];
  for (let i = 0; i < result.questions.length; i++) {
    if (result.answers[i] === false) {
      const q = result.questions[i]!;
      missed.push(`Q${i + 1} — ${q.topic}`);
    }
  }

  if (missed.length > 0) {
    lines.push("");
    lines.push(`  ${B.muted("Missed questions:")}`);
    for (const m of missed) {
      lines.push(`    ${B.red("·")} ${B.white(m)}`);
    }
  }

  const avgTime = result.times.length > 0
    ? Math.round(result.times.reduce((a, b) => a + b, 0) / result.times.length)
    : 0;
  if (avgTime > 0) {
    lines.push("");
    lines.push(`  ${B.muted(`Average time per question: ${avgTime}s`)}`);
    const slowest = result.times.indexOf(Math.max(...result.times));
    if (result.times[slowest]! > avgTime * 1.5) {
      lines.push(`  ${B.muted(`Slowest: Q${slowest + 1} (${result.times[slowest]}s)`)}`);
    }
  }

  lines.push("");
  lines.push(`  ${B.dim("━".repeat(50))}`);
  lines.push("");
  lines.push(`  ${B.muted("/quiz")}       ${B.dim("→ new questions")}`);
  lines.push(`  ${B.muted("/quiz retry")} ${B.dim("→ retry missed questions")}`);

  return lines.join("\n");
}
