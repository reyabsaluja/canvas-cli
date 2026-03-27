import chalk from "chalk";
import type { AssignmentWorkup } from "../work/types.js";
import type { LoadedWorkspace, WorkspaceAnswer } from "../ask/types.js";
import type { AIProviderConfig } from "../ai/provider.js";
import { askWorkspaceQuestion } from "./services.js";
import {
  clearScreen,
  showCursor,
  hideCursor,
  createBuffer,
  getTermSize,
  fmtConfidence,
  C,
  stripAnsi,
} from "./screen.js";

export interface WorkspaceContext {
  workspacePath: string;
  workup: AssignmentWorkup | null;
  loaded: LoadedWorkspace;
  aiConfig: AIProviderConfig | null;
  courseDisplayName?: string;
}

interface ChatMessage {
  role: "user" | "assistant" | "system" | "action";
  content: string;
  actions?: string[];
  sources?: Array<{ title: string; kind: string }>;
  confidence?: string;
  bulletPoints?: string[];
}

const SLASH_COMMANDS: Array<{ cmd: string; desc: string }> = [
  { cmd: "/overview", desc: "Show assignment overview" },
  { cmd: "/requirements", desc: "Show deliverables and constraints" },
  { cmd: "/plan", desc: "Show the action plan" },
  { cmd: "/resources", desc: "Show key resources" },
  { cmd: "/evidence", desc: "Show confirmed vs inferred sources" },
  { cmd: "/status", desc: "Show workspace status" },
  { cmd: "/help", desc: "Show available commands" },
  { cmd: "/back", desc: "Return to assignment selection" },
  { cmd: "/courses", desc: "Return to course selection" },
  { cmd: "/quit", desc: "Exit canvas-cli" },
];

// Background color for the input box
const inputBg = chalk.bgHex("#1e2030");
// Background color for user messages
const userBg = chalk.bgHex("#2a2e3f");

export async function runWorkspaceUI(
  ctx: WorkspaceContext
): Promise<"back" | "courses" | "quit"> {
  const messages: ChatMessage[] = [];

  if (ctx.workup?.overview) {
    messages.push({
      role: "system",
      content: ctx.workup.overview,
    });
  }

  let inputBuffer = "";
  let slashSelected = 0;
  let showSlashMenu = false;
  let isProcessing = false;

  function getSlashMatches(): typeof SLASH_COMMANDS {
    if (!inputBuffer.startsWith("/")) return [];
    const partial = inputBuffer.toLowerCase();
    return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(partial));
  }

  // Track the row where the input box starts so we can update it in-place
  let inputBoxRow = 0;
  let lastContentWidth = 80;

  function render(): void {
    const buf = createBuffer();
    const { cols } = getTermSize();
    const contentWidth = Math.min(cols - 4, 100);
    lastContentWidth = contentWidth;
    let lineCount = 0;

    // Header
    buf.push("");
    buf.push("");
    const name = ctx.loaded.assignmentName;
    const course = ctx.courseDisplayName ?? ctx.loaded.courseName;
    buf.push(`  ${C.primaryBold(name)}  ${C.dim(course)}`);
    buf.push("");

    // Chat messages
    for (const msg of messages) {
      renderMessage(msg, buf, contentWidth);
    }

    // Processing indicator
    if (isProcessing) {
      buf.push("");
      buf.push(`  ${C.primary("∷")} ${C.dim("Working...")}`);
    }

    // Slash command popup
    const matches = showSlashMenu ? getSlashMatches() : [];
    if (matches.length > 0 && !isProcessing) {
      buf.push("");
      for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        const sel = i === slashSelected;
        const ptr = sel ? C.primary("❯ ") : "  ";
        const cmd = sel ? C.primaryBold(m.cmd) : C.accent(m.cmd);
        buf.push(`  ${ptr}${cmd}  ${C.dim(m.desc)}`);
      }
    }

    // Input box
    buf.push("");
    inputBoxRow = buf.length; // row index where input box starts (0-based)
    renderInputBox(buf, contentWidth);

    buf.flush();
  }

  /** Render just the 3 input box lines into a buffer. */
  function renderInputBox(buf: { push(line: string): void }, contentWidth: number): void {
    const inputText = inputBuffer || "";
    const boxWidth = Math.max(contentWidth, 40);
    const emptyInputLine = " ".repeat(boxWidth + 1);
    const displayText = inputText + " ".repeat(Math.max(0, boxWidth - inputText.length));
    buf.push("  " + inputBg(emptyInputLine));
    buf.push("  " + inputBg(` ${displayText}`));
    buf.push("  " + inputBg(emptyInputLine));
  }

  /**
   * Fast path: only rewrite the input box lines in-place.
   * Moves cursor to the input box row and overwrites just those 3 lines.
   * No full screen redraw — eliminates typing lag.
   */
  function renderInputOnly(): void {
    const { cols } = getTermSize();
    const contentWidth = Math.min(cols - 4, 100);
    const boxWidth = Math.max(contentWidth, 40);
    const inputText = inputBuffer || "";
    const emptyInputLine = " ".repeat(boxWidth + 1);
    const displayText = inputText + " ".repeat(Math.max(0, boxWidth - inputText.length));

    const line1 = "  " + inputBg(emptyInputLine);
    const line2 = "  " + inputBg(` ${displayText}`);
    const line3 = "  " + inputBg(emptyInputLine);

    // Pad each line to terminal width to clear any old content
    const pad = (s: string) => {
      const vis = stripAnsi(s).length;
      return vis < cols ? s + " ".repeat(cols - vis) : s;
    };

    // Move to input box row (1-indexed) and overwrite 3 lines
    const row = inputBoxRow + 1; // ANSI rows are 1-based
    process.stdout.write(
      `\x1B[${row};1H` +
      pad(line1) + "\n" +
      pad(line2) + "\n" +
      pad(line3)
    );
  }

  render();
  showCursor();

  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise((resolve) => {
    async function handleKey(key: string): Promise<void> {
      if (isProcessing) return;

      if (key === "\x03") {
        cleanup();
        process.exit(0);
      }

      if (key === "\x1B") {
        if (showSlashMenu) {
          showSlashMenu = false;
          render();
        }
        return;
      }

      if (key === "\r" || key === "\n") {
        if (showSlashMenu && getSlashMatches().length > 0) {
          const matches = getSlashMatches();
          inputBuffer = matches[slashSelected].cmd;
          showSlashMenu = false;
        }

        const input = inputBuffer.trim();
        inputBuffer = "";
        slashSelected = 0;
        showSlashMenu = false;

        if (!input) {
          render();
          return;
        }

        if (input.startsWith("/")) {
          messages.push({ role: "user", content: input });
          const cmd = input.toLowerCase().split(/\s/)[0];
          const navResult = handleSlashCommand(cmd, ctx, messages);
          if (navResult) {
            cleanup();
            resolve(navResult);
            return;
          }
          render();
          return;
        }

        messages.push({ role: "user", content: input });

        if (!ctx.aiConfig) {
          messages.push({
            role: "system",
            content: "AI unavailable (no ANTHROPIC_API_KEY). Slash commands still work — type /help",
          });
          render();
          return;
        }

        isProcessing = true;
        render();

        try {
          const answer = await askWorkspaceQuestion(ctx.aiConfig, ctx.loaded, input);
          messages.push({
            role: "assistant",
            content: answer.answer,
            bulletPoints: answer.bulletPoints,
            sources: answer.sources,
            confidence: answer.confidence,
            actions: ["searched workspace", "retrieved context", "generated answer"],
          });
        } catch (err) {
          messages.push({
            role: "system",
            content: `Error: ${err instanceof Error ? err.message : "unknown"}`,
          });
        }

        isProcessing = false;
        render();
        return;
      }

      if (key === "\x1B[A" && showSlashMenu) {
        slashSelected = Math.max(0, slashSelected - 1);
        render();
        return;
      }
      if (key === "\x1B[B" && showSlashMenu) {
        const matches = getSlashMatches();
        slashSelected = Math.min(matches.length - 1, slashSelected + 1);
        render();
        return;
      }

      if (key === "\x7F" || key === "\b") {
        if (inputBuffer.length > 0) {
          inputBuffer = inputBuffer.slice(0, -1);
          const wasSlash = showSlashMenu;
          showSlashMenu = inputBuffer.startsWith("/");
          slashSelected = 0;
          // Full render only if slash menu state changed
          if (wasSlash !== showSlashMenu) {
            render();
          } else if (!showSlashMenu) {
            renderInputOnly();
          } else {
            render();
          }
        }
        return;
      }

      if (key === "\t" && showSlashMenu) {
        const matches = getSlashMatches();
        if (matches.length > 0) {
          inputBuffer = matches[slashSelected].cmd;
          render();
        }
        return;
      }

      if (key.length === 1 && key >= " ") {
        inputBuffer += key;
        const wasSlash = showSlashMenu;
        showSlashMenu = inputBuffer.startsWith("/");
        if (showSlashMenu) {
          slashSelected = 0;
          render(); // need full render for slash menu
        } else if (wasSlash) {
          render(); // slash menu just closed, full render
        } else {
          renderInputOnly(); // fast path — just update the input box
        }
      }
    }

    function onData(key: string): void {
      handleKey(key).catch(() => {});
    }

    function cleanup(): void {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      showCursor();
      clearScreen();
    }

    stdin.on("data", onData);
  });
}

// --- Slash command handler ---

function handleSlashCommand(
  cmd: string,
  ctx: WorkspaceContext,
  messages: ChatMessage[]
): "back" | "courses" | "quit" | null {
  switch (cmd) {
    case "/overview":
      if (ctx.workup) {
        messages.push({ role: "assistant", content: ctx.workup.overview });
      } else {
        messages.push({ role: "system", content: "No workup data available." });
      }
      return null;

    case "/requirements":
    case "/reqs": {
      if (!ctx.workup) {
        messages.push({ role: "system", content: "No workup data available." });
        return null;
      }
      const parts: string[] = [];
      if (ctx.workup.deliverables.length > 0) {
        parts.push("**Deliverables**\n" + ctx.workup.deliverables.map((d) => `• ${d}`).join("\n"));
      }
      if (ctx.workup.constraints.length > 0) {
        parts.push("**Constraints**\n" + ctx.workup.constraints.map((c) => `• ${c}`).join("\n"));
      }
      messages.push({ role: "assistant", content: parts.join("\n\n") || "No deliverables or constraints found." });
      return null;
    }

    case "/plan":
      if (ctx.workup && ctx.workup.actionPlan.length > 0) {
        const planText = ctx.workup.actionPlan
          .map((s) => `${s.step}. ${s.action}${s.detail ? `\n   ${s.detail}` : ""}`)
          .join("\n");
        messages.push({ role: "assistant", content: planText });
      } else {
        messages.push({ role: "system", content: "No action plan available." });
      }
      return null;

    case "/resources":
      if (ctx.workup && ctx.workup.relevantResources.length > 0) {
        const resText = ctx.workup.relevantResources
          .map((r) => `• **${r.title}** (${r.type}) — ${r.why}`)
          .join("\n");
        messages.push({ role: "assistant", content: resText });
      } else {
        messages.push({ role: "system", content: "No resources listed." });
      }
      return null;

    case "/evidence":
      if (ctx.workup && ctx.workup.sourceTrace.length > 0) {
        let text = ctx.workup.sourceTrace
          .map((e) => `• ${e.conclusion}\n  ${C.dim(`source: ${e.source}`)}`)
          .join("\n");
        if (ctx.workup.uncertainties.length > 0) {
          text += "\n\n**Open questions**\n" + ctx.workup.uncertainties.map((u) => `? ${u}`).join("\n");
        }
        messages.push({ role: "assistant", content: text });
      } else {
        messages.push({ role: "system", content: "No source trace available." });
      }
      return null;

    case "/status": {
      const w = ctx.workup;
      const lines = [
        `Assignment: ${ctx.loaded.assignmentName}`,
        `Course: ${ctx.courseDisplayName ?? ctx.loaded.courseName}`,
        `Path: ${ctx.workspacePath}`,
        `Workup: ${w ? "loaded" : "not available"}`,
        `Extracted: ${ctx.loaded.extractedFiles.length} documents`,
      ].filter(Boolean);
      messages.push({ role: "assistant", content: lines.join("\n") });
      return null;
    }

    case "/help":
      messages.push({
        role: "assistant",
        content: SLASH_COMMANDS.map((c) => `${C.accent(c.cmd.padEnd(16))}${c.desc}`).join("\n"),
      });
      return null;

    case "/back":
      return "back";
    case "/courses":
      return "courses";
    case "/quit":
    case "/exit":
    case "/q":
      return "quit";

    default:
      messages.push({ role: "system", content: `Unknown command: ${cmd}. Type /help for options.` });
      return null;
  }
}

// --- Message renderers ---

type Buf = { push(line: string): void };

function renderMessage(msg: ChatMessage, buf: Buf, maxWidth: number): void {
  buf.push("");

  switch (msg.role) {
    case "user": {
      // User message in a highlighted background box with vertical padding
      const text = msg.content;
      const boxWidth = Math.max(maxWidth, 40);
      const emptyLine = " ".repeat(boxWidth + 1);
      const padded = text + " ".repeat(Math.max(0, boxWidth - text.length));
      buf.push("  " + userBg(emptyLine));
      buf.push("  " + userBg(` ${padded}`));
      buf.push("  " + userBg(emptyLine));
      break;
    }

    case "assistant": {
      // Actions (tool calls) shown dimly above
      if (msg.actions && msg.actions.length > 0) {
        for (const action of msg.actions) {
          buf.push(`  ${C.dim("›")} ${C.dim(action)}`);
        }
        buf.push("");
      }

      // Main content — word-wrapped, no box
      renderWrappedContent(msg.content, buf, maxWidth);

      // Bullet points
      if (msg.bulletPoints && msg.bulletPoints.length > 0) {
        buf.push("");
        for (const bp of msg.bulletPoints) {
          buf.push(`  ${C.dim("•")} ${C.text(bp)}`);
        }
      }

      // Sources
      if (msg.sources && msg.sources.length > 0) {
        buf.push("");
        for (const src of msg.sources) {
          buf.push(`  ${C.dimmer(`[${src.kind}]`)} ${C.dim(src.title)}`);
        }
      }
      break;
    }

    case "system":
      // System messages — word-wrapped, dim
      wrapLines(msg.content, maxWidth).forEach((line) => {
        buf.push(`  ${C.dim(line)}`);
      });
      break;

    case "action":
      buf.push(`  ${C.dim("›")} ${C.dim(msg.content)}`);
      break;
  }
}

/** Render content with markdown-like formatting, word-wrapped to maxWidth. */
function renderWrappedContent(content: string, buf: Buf, maxWidth: number): void {
  const paragraphs = content.split("\n");

  for (const para of paragraphs) {
    if (!para.trim()) {
      buf.push("");
      continue;
    }

    let rendered = para;
    // Bold: **text**
    rendered = rendered.replace(/\*\*(.+?)\*\*/g, (_m, t) => C.bold(t));

    // Bullet points
    if (rendered.trim().startsWith("•") || rendered.trim().startsWith("?")) {
      const symbol = rendered.trim().startsWith("?") ? C.warn("?") : C.dim("•");
      const text = rendered.trim().slice(1).trim();
      wrapLines(text, maxWidth - 4).forEach((line, i) => {
        buf.push(i === 0 ? `  ${symbol} ${C.text(line)}` : `    ${C.text(line)}`);
      });
    } else if (/^\d+\.\s/.test(rendered.trim())) {
      // Numbered list
      const match = rendered.trim().match(/^(\d+)\.\s(.+)/);
      if (match) {
        const num = match[1];
        wrapLines(match[2], maxWidth - 5).forEach((line, i) => {
          buf.push(i === 0 ? `  ${C.primaryBold(num + ".")} ${C.text(line)}` : `     ${C.text(line)}`);
        });
      }
    } else {
      // Regular text — wrap
      wrapLines(stripAnsi(rendered), maxWidth - 2).forEach((line) => {
        // Re-apply bold after wrapping (since we stripped for measurement)
        let coloredLine = line;
        // Simple re-bold: if the original had bold markers around this text
        coloredLine = coloredLine.replace(/\*\*(.+?)\*\*/g, (_m, t) => C.bold(t));
        buf.push(`  ${C.text(coloredLine)}`);
      });
    }
  }
}

/** Word-wrap plain text to a given width. Returns array of lines. */
function wrapLines(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (!word) continue;
    if (current.length + word.length + 1 > maxWidth && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = current ? current + " " + word : word;
    }
  }
  if (current) lines.push(current);
  if (lines.length === 0) lines.push("");
  return lines;
}
