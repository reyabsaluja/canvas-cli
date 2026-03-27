import chalk from "chalk";
import type { AssignmentWorkup } from "../work/types.js";
import type { LoadedWorkspace, WorkspaceAnswer } from "../ask/types.js";
import type { AIProviderConfig } from "../ai/provider.js";
import { askWorkspaceQuestion, type ToolCallEvent } from "./services.js";
import { ActivityIndicator } from "./activity.js";
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
  agentContext?: {
    cache: any;
    client: any;
    config: any;
    courseId: number | null;
  };
}

interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  sources?: Array<{ title: string; kind: string }>;
  confidence?: string;
  bulletPoints?: string[];
  /** For tool messages: the tool action verb (read, search, list, download). */
  toolAction?: string;
  /** For tool messages: the target (filename, query, etc). */
  toolTarget?: string;
  /** For tool messages: color scheme — green for reads, red for errors. */
  toolColor?: "green" | "red";
}

const SLASH_COMMANDS: Array<{ cmd: string; desc: string }> = [
  { cmd: "/overview", desc: "Show assignment overview" },
  { cmd: "/requirements", desc: "Show deliverables and constraints" },
  { cmd: "/plan", desc: "Show the action plan" },
  { cmd: "/resources", desc: "Show key resources" },
  { cmd: "/evidence", desc: "Show confirmed vs inferred sources" },
  { cmd: "/status", desc: "Show workspace status" },
  { cmd: "/refresh", desc: "Re-ingest course and rebuild workspace" },
  { cmd: "/help", desc: "Show available commands" },
  { cmd: "/back", desc: "Return to assignment selection" },
  { cmd: "/courses", desc: "Return to course selection" },
  { cmd: "/quit", desc: "Exit canvas-cli" },
];

// Background color for the input box
const inputBg = chalk.bgHex("#1e2030");
// Background for tool call blocks (green-tinted for reads, red-tinted for errors)
const toolBgGreen = chalk.bgHex("#1a2e1a");
const toolBgRed = chalk.bgHex("#2e1a1a");
// Tool action text colors
const toolActionColor = chalk.hex("#e0af68").bold; // bold yellow/tan
const toolTargetGreen = chalk.hex("#9ece6a"); // green for file targets
const toolTargetRed = chalk.hex("#f7768e"); // red for errors
// Background color for user messages
const userBg = chalk.bgHex("#2a2e3f");

export async function runWorkspaceUI(
  ctx: WorkspaceContext
): Promise<"back" | "courses" | "quit" | "refresh"> {
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

    // Processing: ActivityIndicator renders itself directly via cursor positioning,
    // so we just leave space here — the indicator overlays this area.
    if (isProcessing) {
      // Reserve space for the activity indicator (it renders independently)
      buf.push("");
      buf.push("");
      buf.push("");
      buf.push("");
      buf.push("");
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
   * Uses the stored row if it fits, otherwise uses a fixed offset
   * from the bottom of the terminal. Never falls back to full render.
   */
  function renderInputOnly(): void {
    const { cols, rows: termRows } = getTermSize();

    // Determine which row to write to.
    // If inputBoxRow fits on screen, use it. Otherwise, pin to bottom.
    let row: number;
    if (inputBoxRow + 3 <= termRows) {
      row = inputBoxRow + 1; // ANSI rows are 1-based
    } else {
      // Pin to 3 rows from the bottom of the terminal
      row = Math.max(1, termRows - 2);
    }

    const contentWidth = Math.min(cols - 4, 100);
    const boxWidth = Math.max(contentWidth, 40);
    const inputText = inputBuffer || "";
    const emptyInputLine = " ".repeat(boxWidth + 1);
    const displayText = inputText + " ".repeat(Math.max(0, boxWidth - inputText.length));

    const line1 = "  " + inputBg(emptyInputLine);
    const line2 = "  " + inputBg(` ${displayText}`);
    const line3 = "  " + inputBg(emptyInputLine);

    const pad = (s: string) => {
      const vis = stripAnsi(s).length;
      return vis < cols ? s + " ".repeat(cols - vis) : s;
    };

    process.stdout.write(
      `\x1B[${row};1H` +
      pad(line1) + "\n" +
      pad(line2) + "\n" +
      pad(line3)
    );
  }

  /**
   * Fast path for slash menu: redraws only the slash menu + input box.
   * Writes directly at the position where the menu starts.
   */
  function renderSlashAndInput(): void {
    const { cols, rows: termRows } = getTermSize();
    const contentWidth = Math.min(cols - 4, 100);
    const boxWidth = Math.max(contentWidth, 40);

    const matches = showSlashMenu ? getSlashMatches() : [];
    const menuLines: string[] = [];

    // Slash menu
    if (matches.length > 0) {
      menuLines.push(""); // blank before menu
      for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        const sel = i === slashSelected;
        const ptr = sel ? C.primary("❯ ") : "  ";
        const cmd = sel ? C.primaryBold(m.cmd) : C.accent(m.cmd);
        menuLines.push(`  ${ptr}${cmd}  ${C.dim(m.desc)}`);
      }
    }

    // Input box
    menuLines.push("");
    const inputText = inputBuffer || "";
    const emptyInputLine = " ".repeat(boxWidth + 1);
    const displayText = inputText + " ".repeat(Math.max(0, boxWidth - inputText.length));
    menuLines.push("  " + inputBg(emptyInputLine));
    menuLines.push("  " + inputBg(` ${displayText}`));
    menuLines.push("  " + inputBg(emptyInputLine));

    // Calculate start row — position just before the slash menu
    // The menu area starts where we'd normally put the slash menu (right before inputBoxRow)
    const totalLines = menuLines.length;
    let startRow: number;
    const menuStartRow = inputBoxRow - matches.length - (matches.length > 0 ? 1 : 0);
    if (menuStartRow > 0 && menuStartRow + totalLines <= termRows) {
      startRow = menuStartRow;
    } else {
      startRow = Math.max(1, termRows - totalLines);
    }

    const pad = (s: string) => {
      const vis = stripAnsi(s).length;
      return vis < cols ? s + " ".repeat(cols - vis) : s;
    };

    let output = `\x1B[${startRow};1H`;
    for (const line of menuLines) {
      output += pad(line) + "\n";
    }
    // Clear any leftover lines below
    for (let i = 0; i < 3; i++) {
      output += " ".repeat(cols) + "\n";
    }
    process.stdout.write(output);
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
        render(); // Re-render with user message visible + processing space

        // Start spinner AFTER the render so it appears below the user message
        const activity = new ActivityIndicator(inputBoxRow);
        activity.start();

        try {
          const answer = await askWorkspaceQuestion(
            ctx.aiConfig,
            ctx.loaded,
            input,
            (event: ToolCallEvent) => {
              activity.stop();
              messages.push({
                role: "tool",
                content: event.result,
                toolAction: event.action,
                toolTarget: event.target,
                toolColor: event.color,
              });
              render();
              // Restart spinner at fresh position (after new content)
              activity.updateBaseRow(inputBoxRow);
              activity.start();
            },
            ctx.agentContext
          );

          activity.stop();

          messages.push({
            role: "assistant",
            content: answer.answer,
            bulletPoints: answer.bulletPoints,
            sources: answer.sources,
            confidence: answer.confidence,
          });
        } catch (err) {
          activity.stop();
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
        renderSlashAndInput();
        return;
      }
      if (key === "\x1B[B" && showSlashMenu) {
        const matches = getSlashMatches();
        slashSelected = Math.min(matches.length - 1, slashSelected + 1);
        renderSlashAndInput();
        return;
      }

      if (key === "\x7F" || key === "\b") {
        if (inputBuffer.length > 0) {
          inputBuffer = inputBuffer.slice(0, -1);
          const wasSlash = showSlashMenu;
          showSlashMenu = inputBuffer.startsWith("/");
          slashSelected = 0;
          if (wasSlash && !showSlashMenu) {
            render(); // slash menu just closed, full render to remove it
          } else if (showSlashMenu) {
            renderSlashAndInput(); // still in slash mode, fast update
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
          if (!wasSlash) {
            render(); // first time opening slash menu — full render to clear input area
          } else {
            renderSlashAndInput(); // already in slash mode, fast update
          }
        } else if (wasSlash) {
          render(); // slash menu just closed, full render to remove it
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
): "back" | "courses" | "quit" | "refresh" | null {
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

    case "/refresh":
      return "refresh";
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
      wrapLines(msg.content, maxWidth).forEach((line) => {
        buf.push(`  ${C.dim(line)}`);
      });
      break;

    case "tool": {
      // Tool call block with background box — shows what the agent did
      const bg = msg.toolColor === "red" ? toolBgRed : toolBgGreen;
      const targetColor = msg.toolColor === "red" ? toolTargetRed : toolTargetGreen;
      const boxWidth = Math.max(maxWidth, 40);

      // Header line: bold action + colored target
      const headerText = `${msg.toolAction ?? "tool"} ${msg.toolTarget ?? ""}`;
      const headerPad = " ".repeat(Math.max(0, boxWidth - headerText.length - 1));
      buf.push("  " + bg(` ${toolActionColor(msg.toolAction ?? "tool")} ${targetColor(msg.toolTarget ?? "")}${headerPad}`));

      // Content preview — max 8 lines, then "... (N more lines)"
      const contentLines = msg.content.split("\n");
      const MAX_PREVIEW = 8;
      const previewLines = contentLines.slice(0, MAX_PREVIEW);
      const remaining = contentLines.length - MAX_PREVIEW;

      buf.push("  " + bg(" ".repeat(boxWidth))); // blank line after header
      for (const line of previewLines) {
        const trimmed = line.slice(0, boxWidth - 4);
        const linePad = " ".repeat(Math.max(0, boxWidth - trimmed.length - 3));
        buf.push("  " + bg(`  ${C.dim(trimmed)}${linePad} `));
      }

      if (remaining > 0) {
        const moreText = `... (${remaining} more lines)`;
        const morePad = " ".repeat(Math.max(0, boxWidth - moreText.length - 3));
        buf.push("  " + bg(`  ${C.dimmer(moreText)}${morePad} `));
      }

      // Bottom padding
      buf.push("  " + bg(" ".repeat(boxWidth)));
      break;
    }
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
