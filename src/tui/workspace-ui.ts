import chalk from "chalk";
import type { AssignmentWorkup } from "../work/types.js";
import type { LoadedWorkspace } from "../ask/types.js";
import type { AIProviderConfig } from "../ai/provider.js";
import { askWorkspaceQuestion, createChatContext, type ToolCallEvent } from "./services.js";
import {
  C,
  clearScreen,
  createBuffer,
  getTermSize,
  padAnsiToWidth,
  stripAnsi,
  tailPlainToWidth,
  truncatePlainToWidth,
  visibleWidth,
  wrapPlainText,
} from "./screen.js";
import { startTerminalSession } from "./terminal.js";

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
  toolAction?: string;
  toolTarget?: string;
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

const inputBg = chalk.bgHex("#2d3342");
const workspaceTitleBold = chalk.hex("#a8b8d8").bold;
const INPUT_PLACEHOLDER = "Type your message or /help for commands";
const inputPlaceholderFg = chalk.hex("#8b95a8");
const toolBgGreen = chalk.bgHex("#1a2e1a");
const toolBgRed = chalk.bgHex("#2e1a1a");
const toolActionColor = chalk.hex("#e0af68").bold;
const toolTargetGreen = chalk.hex("#9ece6a");
const toolTargetRed = chalk.hex("#f7768e");
const statusBarGrey = chalk.hex("#9ca3af");

const NORMAL_FOOTER_ROWS = 4;
const TRANSCRIPT_FOOTER_ROWS = 3;
const MAX_OVERLAY_ROWS = 8;
const MAX_TOOL_CONTENT_CHARS = 8000;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const VERBS = ["Working", "Thinking", "Studying", "Reading", "Analyzing", "Exploring", "Reviewing"];

type Buf = { push(line: string): void };
type RenderCacheEntry = { width: number; expanded: boolean; lines: string[] };

export async function runWorkspaceUI(
  ctx: WorkspaceContext
): Promise<"back" | "courses" | "quit" | "refresh"> {
  const messages: ChatMessage[] = [];
  const chatCtx = ctx.aiConfig
    ? createChatContext(ctx.aiConfig, ctx.loaded, ctx.agentContext)
    : null;

  if (ctx.workup?.overview) {
    messages.push({ role: "system", content: ctx.workup.overview });
  }

  let inputBuffer = "";
  let slashSelected = 0;
  let showSlashMenu = false;
  let isProcessing = false;
  let toolOutputExpanded = false;
  let pinSelected = 0;
  let spinnerFrame = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let currentSpinnerLine = "";
  let currentVerb = "";
  let chatScrollOffset = 0;
  let destroyed = false;
  let renderQueued = false;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;

  let renderCache = new WeakMap<ChatMessage, RenderCacheEntry>();

  const pinOptions: Array<{ name: string; label: string }> = [];
  for (const ef of ctx.loaded.extractedFiles) {
    const label = ef.name.replace(/\.txt$/, "").replace(/[._]/g, "_").toLowerCase();
    pinOptions.push({ name: ef.name, label });
  }
  if (ctx.agentContext?.cache) {
    for (const att of (ctx.agentContext.cache as any).attachments ?? []) {
      if (att.status === "downloaded" || att.status === "skipped") {
        const label = att.originalFilename
          .replace(/\.[^.]+$/, "")
          .replace(/[.\s-]/g, "_")
          .toLowerCase();
        if (!pinOptions.some((p) => p.label === label)) {
          pinOptions.push({ name: att.originalFilename, label });
        }
      }
    }
  }
  if (ctx.loaded.assignmentMd) pinOptions.push({ name: "assignment.md", label: "assignment" });
  if (ctx.loaded.planMd) pinOptions.push({ name: "plan.md", label: "plan" });
  if (ctx.loaded.workupJson) pinOptions.push({ name: "workup.json", label: "workup" });

  function invalidateRender(message?: ChatMessage): void {
    if (message) {
      renderCache.delete(message);
      return;
    }
    renderCache = new WeakMap<ChatMessage, RenderCacheEntry>();
  }

  function clipToolContent(content: string): string {
    return content.length <= MAX_TOOL_CONTENT_CHARS
      ? content
      : content.slice(0, MAX_TOOL_CONTENT_CHARS) +
          `\n\n[truncated ${content.length - MAX_TOOL_CONTENT_CHARS} chars for UI performance]`;
  }

  function getActivePinPartial(): string | null {
    const match = inputBuffer.match(/\/pin(\s+(\S*))?$/);
    if (!match) return null;
    return match[2] ?? "";
  }

  function getPinMatches(): typeof pinOptions {
    const partial = getActivePinPartial();
    if (partial === null) return [];
    if (!partial) return pinOptions;
    return pinOptions.filter((p) => p.label.includes(partial.toLowerCase()));
  }

  function getSlashMatches(): typeof SLASH_COMMANDS {
    if (!inputBuffer.startsWith("/")) return [];
    if (getActivePinPartial() !== null && !inputBuffer.startsWith("/pin")) return [];
    const partial = inputBuffer.toLowerCase();
    return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(partial));
  }

  function startSpinner(): void {
    stopSpinner();
    spinnerTimer = setInterval(() => {
      if (destroyed || !isProcessing || !currentSpinnerLine) return;
      spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
      currentSpinnerLine = `  ${C.primary(SPINNER[spinnerFrame])} ${C.accent(currentVerb)}${chalk.white("...")}`;
      scheduleRender();
    }, 80);
  }

  function stopSpinner(): void {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
  }

  function scheduleRender(immediate: boolean = false): void {
    if (destroyed) return;
    if (immediate) {
      if (renderTimer) {
        clearTimeout(renderTimer);
        renderTimer = null;
      }
      renderQueued = false;
      renderNow();
      return;
    }
    if (renderQueued) return;
    renderQueued = true;
    renderTimer = setTimeout(() => {
      renderQueued = false;
      renderTimer = null;
      renderNow();
    }, 16);
  }

  function writeFrame(lines: string[]): void {
    const { cols, rows } = getTermSize();
    const frame = lines.slice(0, rows).map((line) => padAnsiToWidth(line, cols));
    while (frame.length < rows) {
      frame.push(" ".repeat(cols));
    }
    process.stdout.write("\x1B[H" + frame.join("\n"));
  }

  function buildHeaderLines(showScrollHint: boolean): string[] {
    const name = ctx.loaded.assignmentName;
    const course = ctx.courseDisplayName ?? ctx.loaded.courseName;
    const lines = ["", "", `  ${workspaceTitleBold(name)}  ${statusBarGrey(course)}`, ""];
    if (showScrollHint) {
      lines.push(
        C.dim("  ↑ Older · PgUp / PgDn · Ctrl+P up / Ctrl+N down · End latest · Home oldest")
      );
    }
    return lines;
  }

  function buildNormalFooterLines(cols: number): string[] {
    const boxWidth = Math.max(1, cols - 1);
    const cursor = chalk.white("█");
    const inputText = inputBuffer || "";
    const visibleInput = tailPlainToWidth(inputText, Math.max(0, boxWidth - 1));
    const colored = visibleInput.replace(/\/pin\s+\S+/g, (m) => C.accent(m));
    const coloredWithPartial = colored.replace(/\/pin(\s+\S*)?$/, (m) => C.accent(m));
    const visibleLen = visibleWidth(coloredWithPartial);
    const emptyLine = inputBg(" ".repeat(boxWidth + 1));

    let displayText: string;
    if (!inputText) {
      const phPlain = truncatePlainToWidth(INPUT_PLACEHOLDER, Math.max(0, boxWidth - 1));
      const phStyled = inputPlaceholderFg(phPlain);
      const padAfter = Math.max(0, boxWidth - 1 - visibleWidth(phStyled));
      displayText = cursor + phStyled + " ".repeat(padAfter);
    } else {
      const remaining = Math.max(0, boxWidth - visibleLen - 1);
      displayText = coloredWithPartial + cursor + " ".repeat(remaining);
    }

    const courseName = ctx.courseDisplayName ?? ctx.loaded.courseName;
    const assignmentName = ctx.loaded.assignmentName;
    let leftStatus = `${courseName}/${assignmentName}`;
    let modelName = ctx.aiConfig?.model ?? "no model";
    const gapMin = 1;
    if (visibleWidth(leftStatus) + gapMin + visibleWidth(modelName) > cols) {
      if (visibleWidth(modelName) + gapMin + 4 > cols) {
        modelName = truncatePlainToWidth(modelName, Math.max(0, cols - gapMin));
      }
      const maxLeft = cols - gapMin - visibleWidth(modelName);
      leftStatus = truncatePlainToWidth(leftStatus, Math.max(0, maxLeft));
    }
    let statusGap = cols - visibleWidth(leftStatus) - visibleWidth(modelName);
    if (statusGap < gapMin) {
      const take = Math.max(0, cols - gapMin - visibleWidth(leftStatus));
      modelName = truncatePlainToWidth(modelName, take);
      statusGap = cols - visibleWidth(leftStatus) - visibleWidth(modelName);
    }
    statusGap = Math.max(0, cols - visibleWidth(leftStatus) - visibleWidth(modelName));
    const statusLine =
      statusBarGrey(leftStatus) + " ".repeat(statusGap) + statusBarGrey(modelName);

    return [
      emptyLine,
      inputBg(` ${displayText}`),
      emptyLine,
      statusLine,
    ];
  }

  function buildTranscriptFooterLines(width: number): string[] {
    return [
      "",
      `  ${C.dimmer("─".repeat(Math.min(width, 50)))}`,
      `  ${C.dim("Showing detailed transcript")}  ${C.dimmer("·")}  ${C.dimmer("ctrl+o")} ${C.dim("to toggle")}`,
    ];
  }

  function buildOverlayLines(cols: number, maxRows: number): string[] {
    if (isProcessing || toolOutputExpanded || maxRows <= 0) return [];

    const padFull = (line: string): string => padAnsiToWidth(line, cols);
    const pinMatches = getPinMatches();

    if (pinMatches.length > 0) {
      const maxShow = Math.min(pinMatches.length, Math.min(MAX_OVERLAY_ROWS, maxRows));
      let start = 0;
      if (pinMatches.length > maxShow) {
        start = Math.max(0, Math.min(pinSelected - Math.floor(maxShow / 2), pinMatches.length - maxShow));
      }
      const pinIdx = inputBuffer.search(/\/pin/i);
      const colStart = pinIdx >= 0 ? 2 + pinIdx : 2;
      const indent = " ".repeat(Math.max(0, colStart - 1));
      const lines: string[] = [];
      for (let i = 0; i < maxShow; i++) {
        const p = pinMatches[start + i];
        const sel = start + i === pinSelected;
        const ptr = sel ? C.primary("❯ ") : "  ";
        const label = sel ? C.primaryBold(p.label) : C.accent(p.label);
        lines.push(padFull(indent + `${ptr}${label}  ${C.dim(p.name)}`));
      }
      if (pinMatches.length > maxShow && lines.length < maxRows) {
        lines.push(padFull(indent + C.dim(`... ${pinMatches.length - maxShow} more`)));
      }
      return lines;
    }

    const matches = showSlashMenu ? getSlashMatches() : [];
    if (matches.length === 0) return [];

    const maxShow = Math.min(matches.length, Math.min(MAX_OVERLAY_ROWS, maxRows));
    let start = 0;
    if (matches.length > maxShow) {
      start = Math.max(0, Math.min(slashSelected - Math.floor(maxShow / 2), matches.length - maxShow));
    }
    const indent = " ";
    const lines: string[] = [];
    for (let i = 0; i < maxShow; i++) {
      const m = matches[start + i];
      const sel = start + i === slashSelected;
      const ptr = sel ? C.primary("❯ ") : "  ";
      const cmd = sel ? C.primaryBold(m.cmd) : C.accent(m.cmd);
      lines.push(padFull(indent + `${ptr}${cmd}  ${C.dim(m.desc)}`));
    }
    return lines;
  }

  function renderNow(): void {
    const { cols, rows } = getTermSize();
    if (cols <= 0 || rows <= 0) return;

    const contentWidth = Math.max(20, Math.min(cols - 4, 100));
    const headerLines = buildHeaderLines(chatScrollOffset > 0);

    if (toolOutputExpanded) {
      const footerLines = buildTranscriptFooterLines(contentWidth);
      const transcriptRows = Math.max(1, rows - headerLines.length - footerLines.length);
      const transcript = getVisibleTranscriptLines(contentWidth, transcriptRows, chatScrollOffset, true);
      writeFrame([...headerLines, ...transcript.lines, ...footerLines]);
      return;
    }

    const overlayBudget = Math.max(0, rows - headerLines.length - NORMAL_FOOTER_ROWS - 1);
    const overlayLines = buildOverlayLines(cols, overlayBudget);
    const transcriptRows = Math.max(
      1,
      rows - headerLines.length - overlayLines.length - NORMAL_FOOTER_ROWS
    );
    const transcript = getVisibleTranscriptLines(contentWidth, transcriptRows, chatScrollOffset, false);
    const footerLines = buildNormalFooterLines(cols);
    writeFrame([...headerLines, ...transcript.lines, ...overlayLines, ...footerLines]);
  }

  function getVisibleTranscriptLines(
    width: number,
    maxRows: number,
    offsetFromBottom: number,
    expanded: boolean
  ): { lines: string[]; totalLines: number } {
    const blocks = messages.map((msg) => getRenderedMessageLines(msg, width, expanded));
    if (isProcessing && currentSpinnerLine) {
      blocks.push(["", currentSpinnerLine, ""]);
    }

    const totalLines = blocks.reduce((sum, block) => sum + block.length, 0);
    const maxScroll = Math.max(0, totalLines - maxRows);
    chatScrollOffset = Math.max(0, Math.min(offsetFromBottom, maxScroll));

    let remainingSkip = chatScrollOffset;
    let remainingRows = maxRows;
    const collected: string[][] = [];

    for (let i = blocks.length - 1; i >= 0 && remainingRows > 0; i--) {
      const block = blocks[i];
      if (remainingSkip >= block.length) {
        remainingSkip -= block.length;
        continue;
      }

      const endExclusive = block.length - remainingSkip;
      remainingSkip = 0;
      const startInclusive = Math.max(0, endExclusive - remainingRows);
      collected.push(block.slice(startInclusive, endExclusive));
      remainingRows -= endExclusive - startInclusive;
    }

    const lines = collected.reverse().flat();
    while (lines.length < maxRows) {
      lines.unshift("");
    }

    return { lines, totalLines };
  }

  function getRenderedMessageLines(
    message: ChatMessage,
    width: number,
    expanded: boolean
  ): string[] {
    const cached = renderCache.get(message);
    if (cached && cached.width === width && cached.expanded === expanded) {
      return cached.lines;
    }

    const lines: string[] = [];
    renderMessage(message, { push: (line: string) => lines.push(line) }, width, expanded);
    renderCache.set(message, { width, expanded, lines });
    return lines;
  }

  function keyOkWhileProcessing(key: string): boolean {
    if (key === "\x03" || key === "\x0F") return true;
    if (key === "\x10" || key === "\x0e") return true;
    if (key === "\x1B[A" || key === "\x1B[B") return true;
    return (
      key === "\x1b[5~" ||
      key === "\x1B[5~" ||
      key === "\x1b[6~" ||
      key === "\x1B[6~" ||
      key === "\x1b[4~" ||
      key === "\x1B[4~" ||
      key === "\x1b[1~" ||
      key === "\x1B[1~" ||
      /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(key)
    );
  }

  function scrollPageStep(): number {
    const { rows: rowsT } = getTermSize();
    return Math.max(2, Math.floor((rowsT - NORMAL_FOOTER_ROWS - 5) * 0.65));
  }

  return new Promise((resolve) => {
    async function handleKey(key: string): Promise<void> {
      if (destroyed) return;

      const mouseMatch = key.match(/^\x1b\[<(\d+);\d+;\d+[Mm]/);
      if (mouseMatch) {
        const btn = parseInt(mouseMatch[1], 10);
        if (btn === 64) {
          chatScrollOffset += 3;
          scheduleRender(true);
        } else if (btn === 65) {
          chatScrollOffset = Math.max(0, chatScrollOffset - 3);
          scheduleRender(true);
        }
        return;
      }

      if (isProcessing && !keyOkWhileProcessing(key)) return;

      if (key === "\x03") {
        cleanup();
        process.exit(0);
      }

      if (key === "\x0F") {
        toolOutputExpanded = !toolOutputExpanded;
        chatScrollOffset = 0;
        scheduleRender(true);
        return;
      }

      if (key === "\x1b[5~" || key === "\x1B[5~" || key === "\x10") {
        chatScrollOffset += scrollPageStep();
        scheduleRender(true);
        return;
      }
      if (key === "\x1b[6~" || key === "\x1B[6~" || key === "\x0e") {
        chatScrollOffset = Math.max(0, chatScrollOffset - scrollPageStep());
        scheduleRender(true);
        return;
      }
      if (key === "\x1b[4~" || key === "\x1B[4~") {
        chatScrollOffset = 0;
        scheduleRender(true);
        return;
      }
      if (key === "\x1b[1~" || key === "\x1B[1~") {
        chatScrollOffset = Number.MAX_SAFE_INTEGER;
        scheduleRender(true);
        return;
      }

      if (key === "\x1B") {
        if (showSlashMenu) {
          showSlashMenu = false;
          scheduleRender(true);
        }
        return;
      }

      if (key === "\r" || key === "\n") {
        chatScrollOffset = 0;

        const pinPartial = getActivePinPartial();
        if (pinPartial !== null) {
          const pinMatches = getPinMatches();
          const isComplete = pinOptions.some((p) => p.label === pinPartial);
          if (!isComplete && pinMatches.length > 0) {
            const selected = pinMatches[pinSelected];
            inputBuffer = inputBuffer.replace(/\/pin(\s+\S*)?$/, `/pin ${selected.label}`);
            pinSelected = 0;
            scheduleRender(true);
            return;
          }
        }

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
          scheduleRender(true);
          return;
        }

        if (input.startsWith("/")) {
          const msg: ChatMessage = { role: "user", content: input };
          messages.push(msg);
          invalidateRender(msg);
          const navResult = handleSlashCommand(cmdFromInput(input), ctx, messages, invalidateRender);
          if (navResult) {
            cleanup();
            resolve(navResult);
            return;
          }
          scheduleRender(true);
          return;
        }

        const fullQuestion = buildPinnedQuestion(input, ctx, pinOptions);

        const userMessage: ChatMessage = { role: "user", content: input };
        messages.push(userMessage);
        invalidateRender(userMessage);

        if (!ctx.aiConfig) {
          const systemMessage: ChatMessage = {
            role: "system",
            content: "AI unavailable (no ANTHROPIC_API_KEY). Slash commands still work — type /help",
          };
          messages.push(systemMessage);
          invalidateRender(systemMessage);
          scheduleRender(true);
          return;
        }

        isProcessing = true;
        currentVerb = VERBS[Math.floor(Math.random() * VERBS.length)];
        spinnerFrame = 0;
        currentSpinnerLine = `  ${C.primary(SPINNER[0])} ${C.accent(currentVerb)}${chalk.white("...")}`;
        scheduleRender(true);
        startSpinner();

        let streamingStarted = false;
        let streamedText = "";

        try {
          const answer = await askWorkspaceQuestion(
            ctx.aiConfig,
            ctx.loaded,
            fullQuestion,
            (event: ToolCallEvent) => {
              if (streamingStarted && streamedText.trim()) {
                const partialMessage: ChatMessage = {
                  role: "assistant",
                  content: streamedText.trim(),
                };
                messages[messages.length - 1] = partialMessage;
                invalidateRender();
                streamingStarted = false;
                streamedText = "";
              }

              const toolMessage: ChatMessage = {
                role: "tool",
                content: clipToolContent(event.result),
                toolAction: event.action,
                toolTarget: event.target,
                toolColor: event.color,
              };
              messages.push(toolMessage);
              invalidateRender(toolMessage);
              currentSpinnerLine = `  ${C.primary(SPINNER[spinnerFrame])} ${C.accent(currentVerb)}${chalk.white("...")}`;
              scheduleRender();
            },
            ctx.agentContext,
            chatCtx,
            (delta: string) => {
              if (!streamingStarted) {
                streamingStarted = true;
                stopSpinner();
                currentSpinnerLine = "";
                const assistantMessage: ChatMessage = { role: "assistant", content: "" };
                messages.push(assistantMessage);
                invalidateRender(assistantMessage);
              }

              streamedText += delta;
              const assistantMessage: ChatMessage = {
                role: "assistant",
                content: streamedText,
              };
              messages[messages.length - 1] = assistantMessage;
              invalidateRender();
              scheduleRender();
            }
          );

          stopSpinner();

          if (streamingStarted) {
            const finalAssistant: ChatMessage = {
              role: "assistant",
              content: answer.answer || streamedText,
            };
            messages[messages.length - 1] = finalAssistant;
            invalidateRender();
          } else {
            const assistantMessage: ChatMessage = {
              role: "assistant",
              content: answer.answer,
              bulletPoints: answer.bulletPoints,
              sources: answer.sources,
              confidence: answer.confidence,
            };
            messages.push(assistantMessage);
            invalidateRender(assistantMessage);
          }
        } catch (err) {
          stopSpinner();
          const errorMessage: ChatMessage = {
            role: "system",
            content: `Error: ${err instanceof Error ? err.message : "unknown"}`,
          };
          messages.push(errorMessage);
          invalidateRender(errorMessage);
        }

        isProcessing = false;
        currentSpinnerLine = "";
        scheduleRender(true);
        return;
      }

      if (key === "\x1B[A" && getActivePinPartial() !== null && getPinMatches().length > 0) {
        pinSelected = Math.max(0, pinSelected - 1);
        scheduleRender(true);
        return;
      }
      if (key === "\x1B[B" && getActivePinPartial() !== null && getPinMatches().length > 0) {
        pinSelected = Math.min(getPinMatches().length - 1, pinSelected + 1);
        scheduleRender(true);
        return;
      }
      if (key === "\x1B[A" && showSlashMenu) {
        slashSelected = Math.max(0, slashSelected - 1);
        scheduleRender(true);
        return;
      }
      if (key === "\x1B[B" && showSlashMenu) {
        const matches = getSlashMatches();
        slashSelected = Math.min(matches.length - 1, slashSelected + 1);
        scheduleRender(true);
        return;
      }

      if (key === "\x1B[A") {
        chatScrollOffset += 3;
        scheduleRender(true);
        return;
      }
      if (key === "\x1B[B") {
        chatScrollOffset = Math.max(0, chatScrollOffset - 3);
        scheduleRender(true);
        return;
      }

      if (key === "\x7F" || key === "\b") {
        if (inputBuffer.length > 0) {
          inputBuffer = inputBuffer.slice(0, -1);
          showSlashMenu = inputBuffer.startsWith("/");
          slashSelected = 0;
          scheduleRender(true);
        }
        return;
      }

      if (key === "\t" && showSlashMenu) {
        const matches = getSlashMatches();
        if (matches.length > 0) {
          inputBuffer = matches[slashSelected].cmd;
          showSlashMenu = true;
          scheduleRender(true);
        }
        return;
      }

      if (key.length === 1 && key >= " ") {
        inputBuffer += key;
        showSlashMenu = inputBuffer.startsWith("/");
        if (getActivePinPartial() !== null) {
          pinSelected = 0;
        } else if (showSlashMenu) {
          slashSelected = 0;
        }
        scheduleRender(true);
      }
    }

    const cleanupSession = startTerminalSession(
      (key) => {
        void handleKey(key);
      },
      {
        alternateScreen: true,
        mouseTracking: true,
        onResize: () => scheduleRender(true),
      }
    );
    scheduleRender(true);

    function cleanup(): void {
      destroyed = true;
      stopSpinner();
      if (renderTimer) {
        clearTimeout(renderTimer);
        renderTimer = null;
      }
      cleanupSession();
      clearScreen();
    }
  });
}

function cmdFromInput(input: string): string {
  return input.toLowerCase().split(/\s/)[0];
}

function buildPinnedQuestion(
  input: string,
  ctx: WorkspaceContext,
  pinOptions: Array<{ label: string; name: string }>
): string {
  const pinRegex = /\/pin\s+(\S+)/g;
  const pins: Array<{ label: string; name: string }> = [];
  let pinMatch: RegExpExecArray | null;
  while ((pinMatch = pinRegex.exec(input)) !== null) {
    const label = pinMatch[1].toLowerCase();
    const opt = pinOptions.find((p) => p.label === label || p.label.includes(label));
    if (opt) pins.push(opt);
  }

  const cleanInput = input.replace(/\/pin\s+\S+/g, "").replace(/\s+/g, " ").trim();
  if (pins.length === 0) return cleanInput;

  const pinContext: string[] = [];
  for (const pin of pins) {
    let content = "";
    for (const ef of ctx.loaded.extractedFiles) {
      if (ef.name === pin.name || ef.name.includes(pin.label)) {
        content = ef.content.slice(0, 15000);
        break;
      }
    }
    if (!content && pin.name === "assignment.md" && ctx.loaded.assignmentMd) {
      content = ctx.loaded.assignmentMd.slice(0, 15000);
    }
    if (!content && pin.name === "plan.md" && ctx.loaded.planMd) {
      content = ctx.loaded.planMd.slice(0, 15000);
    }
    if (!content && pin.name === "workup.json" && ctx.loaded.workupJson) {
      content = JSON.stringify(ctx.loaded.workupJson, null, 2).slice(0, 15000);
    }
    if (content) {
      pinContext.push(`--- Attached file: ${pin.name} ---\n${content}\n--- End ${pin.name} ---`);
    }
  }

  if (pinContext.length === 0) return cleanInput;
  return pinContext.join("\n\n") + "\n\nUser question: " + cleanInput;
}

function handleSlashCommand(
  cmd: string,
  ctx: WorkspaceContext,
  messages: ChatMessage[],
  invalidateRender: (message?: ChatMessage) => void
): "back" | "courses" | "quit" | "refresh" | null {
  const pushMessage = (message: ChatMessage): null => {
    messages.push(message);
    invalidateRender(message);
    return null;
  };

  switch (cmd) {
    case "/overview":
      return ctx.workup
        ? pushMessage({ role: "assistant", content: ctx.workup.overview })
        : pushMessage({ role: "system", content: "No workup data available." });

    case "/requirements":
    case "/reqs": {
      if (!ctx.workup) {
        return pushMessage({ role: "system", content: "No workup data available." });
      }
      const parts: string[] = [];
      if (ctx.workup.deliverables.length > 0) {
        parts.push("**Deliverables**\n" + ctx.workup.deliverables.map((d) => `• ${d}`).join("\n"));
      }
      if (ctx.workup.constraints.length > 0) {
        parts.push("**Constraints**\n" + ctx.workup.constraints.map((c) => `• ${c}`).join("\n"));
      }
      return pushMessage({
        role: "assistant",
        content: parts.join("\n\n") || "No deliverables or constraints found.",
      });
    }

    case "/plan":
      if (ctx.workup && ctx.workup.actionPlan.length > 0) {
        const planText = ctx.workup.actionPlan
          .map((s) => `${s.step}. ${s.action}${s.detail ? `\n   ${s.detail}` : ""}`)
          .join("\n");
        return pushMessage({ role: "assistant", content: planText });
      }
      return pushMessage({ role: "system", content: "No action plan available." });

    case "/resources":
      if (ctx.workup && ctx.workup.relevantResources.length > 0) {
        const resText = ctx.workup.relevantResources
          .map((r) => `• **${r.title}** (${r.type}) — ${r.why}`)
          .join("\n");
        return pushMessage({ role: "assistant", content: resText });
      }
      return pushMessage({ role: "system", content: "No resources listed." });

    case "/evidence":
      if (ctx.workup && ctx.workup.sourceTrace.length > 0) {
        let text = ctx.workup.sourceTrace
          .map((e) => `• ${e.conclusion}\n  ${C.dim(`source: ${e.source}`)}`)
          .join("\n");
        if (ctx.workup.uncertainties.length > 0) {
          text += "\n\n**Open questions**\n" + ctx.workup.uncertainties.map((u) => `? ${u}`).join("\n");
        }
        return pushMessage({ role: "assistant", content: text });
      }
      return pushMessage({ role: "system", content: "No source trace available." });

    case "/status": {
      const w = ctx.workup;
      const lines = [
        `Assignment: ${ctx.loaded.assignmentName}`,
        `Course: ${ctx.courseDisplayName ?? ctx.loaded.courseName}`,
        `Path: ${ctx.workspacePath}`,
        `Workup: ${w ? "loaded" : "not available"}`,
        `Extracted: ${ctx.loaded.extractedFiles.length} documents`,
      ].filter(Boolean);
      return pushMessage({ role: "assistant", content: lines.join("\n") });
    }

    case "/help":
      return pushMessage({
        role: "assistant",
        content: SLASH_COMMANDS.map((c) => `${C.accent(c.cmd.padEnd(16))}${c.desc}`).join("\n"),
      });

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
      return pushMessage({
        role: "system",
        content: `Unknown command: ${cmd}. Type /help for options.`,
      });
  }
}

function renderMessage(
  msg: ChatMessage,
  buf: Buf,
  maxWidth: number,
  expanded: boolean = false
): void {
  buf.push("");

  switch (msg.role) {
    case "user": {
      const { cols: termCols } = getTermSize();
      const boxWidth = Math.max(1, termCols - 1);
      const emptyLine = " ".repeat(boxWidth + 1);
      const padInner = (line: string) =>
        line + " ".repeat(Math.max(0, boxWidth - visibleWidth(line)));
      const lines = wrapLines(msg.content, boxWidth);
      buf.push(padAnsiToWidth(inputBg(emptyLine), termCols));
      for (const line of lines) {
        buf.push(padAnsiToWidth(inputBg(` ${padInner(line)}`), termCols));
      }
      buf.push(padAnsiToWidth(inputBg(emptyLine), termCols));
      break;
    }

    case "assistant": {
      renderWrappedContent(msg.content, buf, maxWidth);
      if (msg.bulletPoints && msg.bulletPoints.length > 0) {
        buf.push("");
        for (const bp of msg.bulletPoints) {
          buf.push(`  ${C.dim("•")} ${chalk.white(bp)}`);
        }
      }
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
        buf.push(`  ${chalk.white(line)}`);
      });
      break;

    case "tool": {
      const bg = msg.toolColor === "red" ? toolBgRed : toolBgGreen;
      const targetColor = msg.toolColor === "red" ? toolTargetRed : toolTargetGreen;
      const boxWidth = Math.max(maxWidth, 40);
      const empty = " ".repeat(boxWidth);

      buf.push("  " + bg(empty));

      const headerText = `${msg.toolAction ?? "tool"} ${msg.toolTarget ?? ""}`;
      const headerPad = " ".repeat(Math.max(0, boxWidth - visibleWidth(headerText) - 1));
      buf.push(
        "  " +
          bg(
            ` ${toolActionColor(msg.toolAction ?? "tool")} ${targetColor(msg.toolTarget ?? "")}${headerPad}`
          )
      );

      const contentLines = msg.content.split("\n");
      const maxPreview = 8;
      const showLines = expanded ? contentLines : contentLines.slice(0, maxPreview);
      const remaining = expanded ? 0 : Math.max(0, contentLines.length - maxPreview);

      buf.push("  " + bg(empty));
      for (const line of showLines) {
        const trimmed = truncatePlainToWidth(line, boxWidth - 3);
        const linePad = " ".repeat(Math.max(0, boxWidth - visibleWidth(trimmed) - 3));
        buf.push("  " + bg(`  ${chalk.white(trimmed)}${linePad} `));
      }

      if (remaining > 0) {
        const moreText = `... (${remaining} more lines, `;
        const ctrlO = "ctrl+o";
        const toExpand = " to expand)";
        const totalLen = moreText.length + ctrlO.length + toExpand.length;
        const morePad = " ".repeat(Math.max(0, boxWidth - totalLen - 3));
        buf.push("  " + bg(`  ${C.dim(moreText)}${C.dimmer(ctrlO)}${C.dim(toExpand)}${morePad} `));
      }

      buf.push("  " + bg(empty));
      break;
    }
  }
}

function renderWrappedContent(content: string, buf: Buf, maxWidth: number): void {
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      buf.push("");
      continue;
    }

    if (/^[-*_]{3,}$/.test(trimmed) || trimmed === "***") {
      buf.push(`  ${C.dimmer("─".repeat(Math.min(maxWidth - 4, 40)))}`);
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      const text = applyInlineFormatting(headingMatch[2]);
      buf.push("");
      buf.push(`  ${C.primaryBold(text)}`);
      continue;
    }

    const bulletMatch = trimmed.match(/^[*\-•]\s+(.+)/);
    if (bulletMatch) {
      const text = applyInlineFormatting(bulletMatch[1]);
      const indent = line.match(/^\s*/)?.[0]?.length ?? 0;
      const indentStr = indent > 2 ? "      " : "    ";
      const symbol = indent > 2 ? C.dim("◦") : C.dim("•");
      wrapLines(stripAnsi(text), maxWidth - indentStr.length - 2).forEach((wrapped, index) => {
        const colored = applyInlineFormatting(wrapped);
        buf.push(
          index === 0
            ? `  ${indentStr.slice(2)}${symbol} ${colored}`
            : `  ${indentStr}  ${colored}`
        );
      });
      continue;
    }

    const numMatch = trimmed.match(/^(\d+)\.\s+(.+)/);
    if (numMatch) {
      const num = numMatch[1];
      const text = applyInlineFormatting(numMatch[2]);
      wrapLines(stripAnsi(text), maxWidth - 6).forEach((wrapped, index) => {
        const colored = applyInlineFormatting(wrapped);
        buf.push(index === 0 ? `  ${C.primaryBold(num + ".")} ${colored}` : `      ${colored}`);
      });
      continue;
    }

    const plainText = stripAnsi(trimmed);
    wrapLines(plainText, maxWidth - 2).forEach((wrapped) => {
      buf.push(`  ${applyInlineFormatting(wrapped)}`);
    });
  }
}

function applyInlineFormatting(text: string): string {
  let result = text;
  result = result.replace(/\*\*(.+?)\*\*/g, (_m, t) => chalk.white.bold(t));
  result = result.replace(/__(.+?)__/g, (_m, t) => chalk.white.bold(t));
  result = result.replace(/`([^`]+)`/g, (_m, t) => C.accent(t));
  result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_m, t) => chalk.white.italic(t));
  if (result === text) {
    result = chalk.white(text);
  }
  return result;
}

function wrapLines(text: string, maxWidth: number): string[] {
  return wrapPlainText(text, maxWidth);
}
