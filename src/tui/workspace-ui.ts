import chalk from "chalk";
import type { AssignmentWorkup } from "../work/types.js";
import type { LoadedWorkspace, WorkspaceAnswer } from "../ask/types.js";
import type { AIProviderConfig } from "../ai/provider.js";
import { askWorkspaceQuestion, createChatContext, type ToolCallEvent } from "./services.js";
import { ActivityIndicator } from "./activity.js";
import {
  clearScreen,
  showCursor,
  hideCursor,
  enterAlternateScreen,
  leaveAlternateScreen,
  enableMouseTracking,
  disableMouseTracking,
  createBuffer,
  getTermSize,
  fmtConfidence,
  C,
  stripAnsi,
  truncateAnsiToWidth,
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

// Background color for the input box (soft neutral blue-gray, not saturated navy)
const inputBg = chalk.bgHex("#2d3342");
/** Foreground for workspace assignment title — same hue family as the input bar. */
const workspaceTitleBold = chalk.hex("#a8b8d8").bold;
/** Dim placeholder inside the input row */
const INPUT_PLACEHOLDER = "Type your message or /help for commands";
const inputPlaceholderFg = chalk.hex("#8b95a8");
// Background for tool call blocks (green-tinted for reads, red-tinted for errors)
const toolBgGreen = chalk.bgHex("#1a2e1a");
const toolBgRed = chalk.bgHex("#2e1a1a");
// Tool action text colors
const toolActionColor = chalk.hex("#e0af68").bold; // bold yellow/tan
const toolTargetGreen = chalk.hex("#9ece6a"); // green for file targets
const toolTargetRed = chalk.hex("#f7768e"); // red for errors
/** Neutral grey for workspace footer (course/assignment + model); avoids bluish C.dim. */
const statusBarGrey = chalk.hex("#9ca3af");
/** Sticky footer: 3 input rows + 1 status row (overdrawn after main buffer flush). */
const STICKY_BOTTOM_ROWS = 4;
/** Blank lines between chat and the input bar (included in main buffer + flush reserve). */
const CHAT_GAP_ROWS = 2;
/** Rows reserved at bottom of main view: gap + sticky (flush leaves these; sticky redraws last 4). */
const MAIN_VIEW_BOTTOM_RESERVE = STICKY_BOTTOM_ROWS + CHAT_GAP_ROWS;

export async function runWorkspaceUI(
  ctx: WorkspaceContext
): Promise<"back" | "courses" | "quit" | "refresh"> {
  const messages: ChatMessage[] = [];

  // Create a persistent chat context that maintains conversation history
  const chatCtx = ctx.aiConfig
    ? createChatContext(ctx.aiConfig, ctx.loaded, ctx.agentContext)
    : null;

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
  let toolOutputExpanded = false;
  let currentSpinnerLine = "";
  let pinSelected = 0;

  // Build pin options from workspace + cache
  const pinOptions: Array<{ name: string; label: string }> = [];
  for (const ef of ctx.loaded.extractedFiles) {
    const label = ef.name.replace(/\.txt$/, "").replace(/[._]/g, "_").toLowerCase();
    pinOptions.push({ name: ef.name, label });
  }
  if (ctx.agentContext?.cache) {
    for (const att of (ctx.agentContext.cache as any).attachments ?? []) {
      if (att.status === "downloaded" || att.status === "skipped") {
        const label = att.originalFilename.replace(/\.[^.]+$/, "").replace(/[.\s-]/g, "_").toLowerCase();
        if (!pinOptions.some((p) => p.label === label)) {
          pinOptions.push({ name: att.originalFilename, label });
        }
      }
    }
  }
  if (ctx.loaded.assignmentMd) pinOptions.push({ name: "assignment.md", label: "assignment" });
  if (ctx.loaded.planMd) pinOptions.push({ name: "plan.md", label: "plan" });
  if (ctx.loaded.workupJson) pinOptions.push({ name: "workup.json", label: "workup" });
  let spinnerFrame = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  /** Row where the spinner line was last rendered (1-based for ANSI). */
  let spinnerRow = 0;
  /** Lines scrolled up from the bottom of the chat viewport (PgUp/PgDn). */
  let chatScrollOffset = 0;
  const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const VERBS = ["Working", "Thinking", "Studying", "Reading", "Analyzing", "Exploring", "Reviewing"];
  let currentVerb = "";

  /** Start the spinner animation timer. Writes directly to spinnerRow. */
  function startSpinner(): void {
    // Always clear any existing timer first
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    spinnerTimer = setInterval(() => {
      // Only animate if we have a valid position and are still in processing mode
      if (!isProcessing || !currentSpinnerLine || spinnerRow <= 0) return;
      spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
      currentSpinnerLine = `  ${C.primary(SPINNER[spinnerFrame])} ${C.accent(currentVerb)}${chalk.white("...")}`;
      const { cols, rows: termRows } = getTermSize();
      if (spinnerRow <= termRows && spinnerRow < (inputBoxRow > 0 ? inputBoxRow : termRows)) {
        const vis = stripAnsi(currentSpinnerLine).length;
        const padded = vis < cols ? currentSpinnerLine + " ".repeat(cols - vis) : currentSpinnerLine;
        process.stdout.write(`\x1B[${spinnerRow};1H` + padded);
      }
    }, 80);
  }

  /** Stop the spinner animation timer. */
  function stopSpinner(): void {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    spinnerRow = 0;
  }

  /**
   * Check if there's an active /pin being typed mid-message.
   * Returns the partial text after "/pin " if active, null otherwise.
   * e.g., "explain part 1 /pin lab" → "lab"
   * e.g., "explain part 1 /pin" → ""
   */
  function getActivePinPartial(): string | null {
    const match = inputBuffer.match(/\/pin(\s+(\S*))?$/);
    if (!match) return null;
    return match[2] ?? "";
  }

  /** Get matching pin files for the active /pin partial. */
  function getPinMatches(): typeof pinOptions {
    const partial = getActivePinPartial();
    if (partial === null) return [];
    if (!partial) return pinOptions;
    return pinOptions.filter((p) => p.label.includes(partial.toLowerCase()));
  }

  function getSlashMatches(): typeof SLASH_COMMANDS {
    // Only show slash menu when / is at the START of input
    if (!inputBuffer.startsWith("/")) return [];
    if (getActivePinPartial() !== null && !inputBuffer.startsWith("/pin")) return [];
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
    buf.push(`  ${workspaceTitleBold(name)}  ${statusBarGrey(course)}`);
    buf.push("");

    if (chatScrollOffset > 0) {
      buf.push(
        C.dim(
          `  ↑ Older · PgUp / PgDn · Ctrl+P up / Ctrl+N down · End latest · Home oldest`
        )
      );
    }

    // Full message history — flush() + chatScrollOffset clip to the viewport above the sticky input
    for (const msg of messages) {
      renderMessage(msg, buf, contentWidth, toolOutputExpanded);
    }

    // Working indicator — reserve space in buffer, timer handles actual rendering
    if (isProcessing && currentSpinnerLine) {
      buf.push("");
      spinnerRow = buf.length + 1; // +1 because ANSI rows are 1-based
      buf.push(""); // empty line — timer will overwrite this with the spinner
      buf.push("");
    } else {
      spinnerRow = 0;
    }

    for (let g = 0; g < CHAT_GAP_ROWS; g++) {
      buf.push("");
    }

    // Pin/slash menus are drawn in renderSlashPinOverlay() (fixed above the input, not in scrollback)

    const bufLenBeforeFlush = buf.length;
    const { rows: tr } = getTermSize();
    const maxContent = Math.max(1, tr - MAIN_VIEW_BOTTOM_RESERVE);
    const maxScroll = Math.max(0, bufLenBeforeFlush - maxContent);
    chatScrollOffset = Math.min(Math.max(0, chatScrollOffset), maxScroll);

    const off = chatScrollOffset;
    const end = bufLenBeforeFlush - off;
    const start = Math.max(0, end - maxContent);

    buf.flush(MAIN_VIEW_BOTTOM_RESERVE, chatScrollOffset);

    // Map spinner line from pre-slice buffer row to on-screen row
    if (spinnerRow > 0) {
      const sIdx = spinnerRow - 1;
      if (sIdx < start || sIdx >= end) {
        spinnerRow = 0;
      } else {
        spinnerRow = spinnerRow - start;
      }
    }

    // Sticky input box + status bar at bottom of terminal
    renderStickyBottom();
    renderSlashPinOverlay();
  }

  /** Draw slash / pin menus just above the input, aligned with the `/` column. */
  function renderSlashPinOverlay(): void {
    if (isProcessing) return;
    const { cols, rows: termRows } = getTermSize();
    const lastRowAboveInput = termRows - STICKY_BOTTOM_ROWS;
    if (lastRowAboveInput < 1) return;

    const padToCols = (s: string): string => {
      const v = stripAnsi(s).length;
      if (v > cols) return truncateAnsiToWidth(s, cols);
      return s + " ".repeat(cols - v);
    };

    const maxVis = lastRowAboveInput;
    const pinMatches = getPinMatches();

    if (pinMatches.length > 0) {
      const cap = Math.min(pinMatches.length, 8);
      const maxShow = Math.min(cap, maxVis);
      let start = 0;
      if (pinMatches.length > maxShow) {
        start = Math.max(0, Math.min(pinSelected - Math.floor(maxShow / 2), pinMatches.length - maxShow));
      }
      const pinIdx = inputBuffer.search(/\/pin/i);
      const colStart = pinIdx >= 0 ? 2 + pinIdx : 2;
      const indent = " ".repeat(Math.max(0, colStart - 1));
      const menuRows = Math.min(maxShow, maxVis);
      const firstMenuRow = lastRowAboveInput - menuRows + 1;
      for (let i = 0; i < menuRows; i++) {
        const p = pinMatches[start + i];
        const sel = start + i === pinSelected;
        const ptr = sel ? C.primary("❯ ") : "  ";
        const label = sel ? C.primaryBold(p.label) : C.accent(p.label);
        const inner = `${ptr}${label}  ${C.dim(p.name)}`;
        const row = firstMenuRow + i;
        process.stdout.write(`\x1B[${row};1H` + padToCols(indent + inner));
      }
      if (pinMatches.length > maxShow && menuRows < maxVis) {
        const row = firstMenuRow + menuRows;
        if (row >= 1 && row <= lastRowAboveInput) {
          const more = indent + C.dim(`... ${pinMatches.length - maxShow} more`);
          process.stdout.write(`\x1B[${row};1H` + padToCols(more));
        }
      }
      return;
    }

    const matches = showSlashMenu ? getSlashMatches() : [];
    if (matches.length === 0) return;

    const maxShow = Math.min(matches.length, maxVis);
    let start = 0;
    if (matches.length > maxShow) {
      start = Math.max(0, Math.min(slashSelected - Math.floor(maxShow / 2), matches.length - maxShow));
    }
    const colStart = 2;
    const indent = " ".repeat(Math.max(0, colStart - 1));
    const menuRows = Math.min(maxShow, maxVis);
    const firstMenuRow = lastRowAboveInput - menuRows + 1;
    for (let i = 0; i < menuRows; i++) {
      const m = matches[start + i];
      const sel = start + i === slashSelected;
      const ptr = sel ? C.primary("❯ ") : "  ";
      const cmd = sel ? C.primaryBold(m.cmd) : C.accent(m.cmd);
      const inner = `${ptr}${cmd}  ${C.dim(m.desc)}`;
      const row = firstMenuRow + i;
      process.stdout.write(`\x1B[${row};1H` + padToCols(indent + inner));
    }
  }

  /** Render the sticky input box + status bar at the bottom of the terminal. */
  function renderStickyBottom(): void {
    const { cols, rows: termRows } = getTermSize();
    // Full-width input: inner row is ` ${displayText}` with displayText length boxWidth = cols - 1
    const boxWidth = Math.max(1, cols - 1);
    const cursor = chalk.white("█");

    // Input box: 3 lines (empty, text, empty)
    const inputText = inputBuffer || "";
    const colored = inputText.replace(/\/pin\s+\S+/g, (m) => C.accent(m));
    const coloredWithPartial = colored.replace(/\/pin(\s+\S*)?$/, (m) => C.accent(m));
    const visibleLen = stripAnsi(coloredWithPartial).length;
    const emptyLine = " ".repeat(boxWidth + 1);
    const remaining = Math.max(0, boxWidth - visibleLen - 1);
    let displayText: string;
    if (!inputText) {
      const phMax = Math.max(0, boxWidth - 1);
      let phPlain = INPUT_PLACEHOLDER;
      if (phPlain.length > phMax) {
        phPlain = phMax > 3 ? phPlain.slice(0, phMax - 3) + "..." : phPlain.slice(0, phMax);
      }
      const phStyled = inputPlaceholderFg(phPlain);
      const phVis = stripAnsi(phStyled).length;
      const padAfter = Math.max(0, boxWidth - 1 - phVis);
      displayText = cursor + phStyled + " ".repeat(padAfter);
    } else {
      displayText = coloredWithPartial + cursor + " ".repeat(remaining);
    }

    // Status bar: course/assignment on left, model on right (same width as input; truncate left if needed)
    const courseName = ctx.courseDisplayName ?? ctx.loaded.courseName;
    const assignmentName = ctx.loaded.assignmentName;
    let leftStatus = `${courseName}/${assignmentName}`;
    let modelName = ctx.aiConfig?.model ?? "no model";
    const gapMin = 1;
    if (leftStatus.length + gapMin + modelName.length > cols) {
      if (modelName.length + gapMin + 4 > cols) {
        modelName = modelName.slice(0, Math.max(0, cols - gapMin - 3)) + "...";
      }
      const maxLeft = cols - gapMin - modelName.length;
      if (leftStatus.length > maxLeft && maxLeft > 3) {
        leftStatus = leftStatus.slice(0, maxLeft - 3) + "...";
      } else if (leftStatus.length > maxLeft) {
        leftStatus = leftStatus.slice(0, Math.max(0, maxLeft));
      }
    }
    let statusGap = cols - leftStatus.length - modelName.length;
    if (statusGap < gapMin) {
      const take = Math.max(0, cols - gapMin - leftStatus.length);
      modelName = take > 3 ? modelName.slice(0, take - 3) + "..." : modelName.slice(0, take);
      statusGap = cols - leftStatus.length - modelName.length;
    }
    statusGap = Math.max(0, cols - leftStatus.length - modelName.length);
    const statusLine =
      statusBarGrey(leftStatus) + " ".repeat(statusGap) + statusBarGrey(modelName);

    // Position: input box starts at termRows - 4
    // Row layout: termRows-4=emptyBg, termRows-3=textBg, termRows-2=emptyBg, termRows-1=statusBar
    const startRow = termRows - 3;

    const pad = (s: string) => {
      const vis = stripAnsi(s).length;
      return vis < cols ? s + " ".repeat(cols - vis) : s;
    };

    // Record input box position for fast path
    inputBoxRow = startRow;

    process.stdout.write(
      `\x1B[${startRow};1H` +
      pad(inputBg(emptyLine)) + "\n" +
      pad(inputBg(` ${displayText}`)) + "\n" +
      pad(inputBg(emptyLine)) + "\n" +
      pad(statusLine)
    );
  }

  /** Render just the 3 input box lines into a buffer (used by non-sticky contexts). */
  function renderInputBox(buf: { push(line: string): void }, contentWidth: number): void {
    const inputText = inputBuffer || "";
    const boxWidth = Math.max(contentWidth, 40);
    const emptyInputLine = " ".repeat(boxWidth + 1);
    const cursor = chalk.white("█");

    // Color /pin parts in accent
    const colored = inputText.replace(/\/pin\s+\S+/g, (m) => C.accent(m));
    // Also highlight partial /pin being typed
    const coloredWithPartial = colored.replace(/\/pin(\s+\S*)?$/, (m) => C.accent(m));

    const visibleLen = stripAnsi(coloredWithPartial).length;
    const remaining = Math.max(0, boxWidth - visibleLen - 1);
    const displayText = coloredWithPartial + cursor + " ".repeat(remaining);

    buf.push("  " + inputBg(emptyInputLine));
    buf.push("  " + inputBg(` ${displayText}`));
    buf.push("  " + inputBg(emptyInputLine));
  }

  /**
   * Fast path: only rewrite the sticky input box at the bottom.
   */
  function renderInputOnly(): void {
    renderStickyBottom();
  }

  /**
   * Fast path for slash menu. Uses full render since the slash menu
   * needs proper layout coordination with the content above it.
   * The screen buffer approach prevents flicker.
   */
  function renderSlashAndInput(): void {
    render();
  }

  enterAlternateScreen();
  enableMouseTracking();
  clearScreen();
  hideCursor();
  render();
  showCursor();

  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise((resolve) => {
    /** Must work while streaming — otherwise the view feels “stuck” at the bottom. */
    function keyOkWhileProcessing(key: string): boolean {
      if (key === "\x03" || key === "\x0F") return true;
      if (key === "\x10" || key === "\x0e") return true;
      if (key === "\x1B[A" || key === "\x1B[B") return true;
      if (
        key === "\x1b[5~" ||
        key === "\x1B[5~" ||
        key === "\x1b[6~" ||
        key === "\x1B[6~" ||
        key === "\x1b[4~" ||
        key === "\x1B[4~" ||
        key === "\x1b[1~" ||
        key === "\x1B[1~"
      ) {
        return true;
      }
      return false;
    }

    function scrollPageStep(): number {
      const { rows: rowsT } = getTermSize();
      return Math.max(2, Math.floor((rowsT - MAIN_VIEW_BOTTOM_RESERVE) * 0.65));
    }

    async function handleKey(key: string): Promise<void> {
      if (isProcessing && !keyOkWhileProcessing(key)) return;

      if (key === "\x03") {
        cleanup();
        process.exit(0);
      }

      // Ctrl+O — toggle detailed transcript view
      if (key === "\x0F") {
        toolOutputExpanded = !toolOutputExpanded;

        if (toolOutputExpanded) {
          // Show detailed transcript: all messages, all tool output, no input box
          clearScreen();
          const { cols } = getTermSize();
          const cw = Math.min(cols - 4, 100);
          console.log("");
          console.log("");
          const name = ctx.loaded.assignmentName;
          const course = ctx.courseDisplayName ?? ctx.loaded.courseName;
          console.log(`  ${workspaceTitleBold(name)}  ${statusBarGrey(course)}`);
          console.log("");

          // Show ALL messages (no limit) with expanded tool output
          for (const msg of messages) {
            const tmpBuf = { lines: [] as string[], push(l: string) { this.lines.push(l); } };
            renderMessage(msg, tmpBuf, cw, true);
            for (const l of tmpBuf.lines) console.log(l);
          }

          // Transcript footer instead of input box
          console.log("");
          console.log(`  ${C.dimmer("─".repeat(Math.min(cw, 50)))}`);
          console.log(`  ${C.dim("Showing detailed transcript")}  ${C.dimmer("·")}  ${C.dimmer("ctrl+o")} ${C.dim("to toggle")}`);
          console.log("");
        } else {
          chatScrollOffset = 0;
          // Return to normal view
          render();
        }
        return;
      }

      // Scroll chat transcript (viewport is shorter than full history)
      if (key === "\x1b[5~" || key === "\x1B[5~" || key === "\x10") {
        chatScrollOffset += scrollPageStep();
        render();
        return;
      }
      if (key === "\x1b[6~" || key === "\x1B[6~" || key === "\x0e") {
        chatScrollOffset = Math.max(0, chatScrollOffset - scrollPageStep());
        render();
        return;
      }
      if (key === "\x1b[4~" || key === "\x1B[4~") {
        chatScrollOffset = 0;
        render();
        return;
      }
      if (key === "\x1b[1~" || key === "\x1B[1~") {
        chatScrollOffset = 999999;
        render();
        return;
      }

      if (key === "\x1B") {
        if (showSlashMenu) {
          showSlashMenu = false;
          render();
        }
        return;
      }

      if (key === "\r" || key === "\n") {
        chatScrollOffset = 0;
        // If pin dropdown is showing, check if the pin is already complete
        const pinPartial = getActivePinPartial();
        if (pinPartial !== null) {
          const pinMatches = getPinMatches();
          // Check if the partial is already a complete label (pin is finished)
          const isComplete = pinOptions.some((p) => p.label === pinPartial);
          if (!isComplete && pinMatches.length > 0) {
            // Autocomplete the pin
            const selected = pinMatches[pinSelected];
            inputBuffer = inputBuffer.replace(/\/pin(\s+\S*)?$/, `/pin ${selected.label}`);
            pinSelected = 0;
            render();
            return;
          }
          // If complete or no matches, fall through to send the message
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

        // Parse /pin <label> from the input and resolve file content
        const pinRegex = /\/pin\s+(\S+)/g;
        const pins: Array<{ label: string; name: string }> = [];
        let pinMatch;
        while ((pinMatch = pinRegex.exec(input)) !== null) {
          const label = pinMatch[1].toLowerCase();
          const opt = pinOptions.find((p) => p.label === label || p.label.includes(label));
          if (opt) pins.push(opt);
        }

        // Build the question: strip /pin parts from visible text, prepend file content
        const cleanInput = input.replace(/\/pin\s+\S+/g, "").replace(/\s+/g, " ").trim();
        let fullQuestion = cleanInput;

        if (pins.length > 0) {
          const pinContext: string[] = [];
          for (const pin of pins) {
            let content = "";
            for (const ef of ctx.loaded.extractedFiles) {
              if (ef.name === pin.name || ef.name.includes(pin.label)) {
                content = ef.content.slice(0, 15000);
                break;
              }
            }
            if (!content && pin.name === "assignment.md" && ctx.loaded.assignmentMd) content = ctx.loaded.assignmentMd.slice(0, 15000);
            if (!content && pin.name === "plan.md" && ctx.loaded.planMd) content = ctx.loaded.planMd.slice(0, 15000);
            if (!content && pin.name === "workup.json" && ctx.loaded.workupJson) content = JSON.stringify(ctx.loaded.workupJson, null, 2).slice(0, 15000);
            if (content) pinContext.push(`--- Attached file: ${pin.name} ---\n${content}\n--- End ${pin.name} ---`);
          }
          if (pinContext.length > 0) {
            fullQuestion = pinContext.join("\n\n") + "\n\nUser question: " + cleanInput;
          }
        }

        // Show the original input (with colored /pin parts) as user message
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
        currentVerb = VERBS[Math.floor(Math.random() * VERBS.length)];
        spinnerFrame = 0;
        currentSpinnerLine = `  ${C.primary(SPINNER[0])} ${C.accent(currentVerb)}${chalk.white("...")}`;
        render(); // This sets spinnerRow
        startSpinner(); // Start the independent animation timer

        // Streaming state
        let streamingStarted = false;
        let streamedText = "";
        let lastRenderTime = 0;
        const RENDER_INTERVAL = 80; // ms between stream renders

        try {
          const answer = await askWorkspaceQuestion(
            ctx.aiConfig,
            ctx.loaded,
            fullQuestion,
            (event: ToolCallEvent) => {
              // If text was streaming before this tool call, save it
              if (streamingStarted && streamedText.trim()) {
                messages[messages.length - 1] = {
                  role: "system",
                  content: streamedText.trim(),
                };
                streamingStarted = false;
                streamedText = "";
              }
              stopSpinner();
              messages.push({
                role: "tool",
                content: event.result,
                toolAction: event.action,
                toolTarget: event.target,
                toolColor: event.color,
              });
              // Keep isProcessing true, restore spinner line for next render
              currentSpinnerLine = `  ${C.primary(SPINNER[spinnerFrame])} ${C.accent(currentVerb)}${chalk.white("...")}`;
              render();
              startSpinner();
            },
            ctx.agentContext,
            chatCtx,
            (delta: string) => {
              // First delta: stop spinner, switch to streaming mode
              if (!streamingStarted) {
                streamingStarted = true;
                stopSpinner();
                // Clear spinner but keep isProcessing true (hides input box)
                currentSpinnerLine = "";
                messages.push({ role: "assistant", content: "" });
              }

              streamedText += delta;

              // Throttled render: update message content periodically
              const now = Date.now();
              if (now - lastRenderTime > RENDER_INTERVAL) {
                lastRenderTime = now;
                messages[messages.length - 1] = {
                  role: "assistant",
                  content: streamedText,
                };
                render();
              }
            }
          );

          stopSpinner();

          // Final render with complete text
          if (streamingStarted) {
            messages[messages.length - 1] = {
              role: "assistant",
              content: answer.answer || streamedText,
            };
          } else {
            messages.push({
              role: "assistant",
              content: answer.answer,
              bulletPoints: answer.bulletPoints,
              sources: answer.sources,
              confidence: answer.confidence,
            });
          }
        } catch (err) {
          stopSpinner();
          messages.push({
            role: "system",
            content: `Error: ${err instanceof Error ? err.message : "unknown"}`,
          });
        }

        isProcessing = false;
        currentSpinnerLine = "";
        spinnerRow = 0;
        render();
        return;
      }

      // Arrow keys — pin dropdown or slash menu
      if (key === "\x1B[A" && getActivePinPartial() !== null && getPinMatches().length > 0) {
        pinSelected = Math.max(0, pinSelected - 1);
        render();
        return;
      }
      if (key === "\x1B[B" && getActivePinPartial() !== null && getPinMatches().length > 0) {
        pinSelected = Math.min(getPinMatches().length - 1, pinSelected + 1);
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

      // Arrow up/down → scroll chat when no menu is active
      if (key === "\x1B[A") {
        chatScrollOffset += 3;
        render();
        return;
      }
      if (key === "\x1B[B") {
        chatScrollOffset = Math.max(0, chatScrollOffset - 3);
        render();
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
        const hasPinPartial = getActivePinPartial() !== null;

        if (hasPinPartial) {
          // Pin dropdown needs full render to show/update
          pinSelected = 0;
          render();
        } else if (showSlashMenu) {
          slashSelected = 0;
          if (!wasSlash) {
            render();
          } else {
            renderSlashAndInput();
          }
        } else if (wasSlash) {
          render();
        } else {
          renderInputOnly();
        }
      }
    }

    /**
     * Reassemble CSI keys split across stdin reads (e.g. ESC then "[5~"),
     * otherwise Page Up never matches and scrolling appears broken.
     */
    let stdinEscHold = "";
    function onData(data: string): void {
      let input = stdinEscHold + data;
      stdinEscHold = "";
      while (input.length > 0) {
        const escIdx = input.indexOf("\x1b");
        if (escIdx < 0) {
          for (let i = 0; i < input.length; i++) {
            handleKey(input[i]!).catch(() => {});
          }
          return;
        }
        for (let i = 0; i < escIdx; i++) {
          handleKey(input[i]!).catch(() => {});
        }
        input = input.slice(escIdx);
        if (input.length === 1) {
          stdinEscHold = input;
          return;
        }
        if (input[1] === "[") {
          // SGR mouse events: \x1B[<button;col;row[Mm]
          const mouseMatch = input.match(/^\x1b\[<(\d+);\d+;\d+[Mm]/);
          if (mouseMatch) {
            const btn = parseInt(mouseMatch[1], 10);
            if (btn === 64) {
              chatScrollOffset += 3;
              render();
            } else if (btn === 65) {
              chatScrollOffset = Math.max(0, chatScrollOffset - 3);
              render();
            }
            input = input.slice(mouseMatch[0].length);
            continue;
          }
          const m = input.match(/^\x1b\[[\d;]*[~A-Za-z]/);
          if (m) {
            handleKey(m[0]).catch(() => {});
            input = input.slice(m[0].length);
            continue;
          }
          if (input.length > 48) {
            handleKey("\x1b").catch(() => {});
            input = input.slice(1);
            continue;
          }
          stdinEscHold = input;
          return;
        }
        if (input[1] === "O" && input.length >= 3) {
          handleKey(input.slice(0, 3)).catch(() => {});
          input = input.slice(3);
          continue;
        }
        handleKey(input.slice(0, 2)).catch(() => {});
        input = input.slice(2);
      }
    }

    function cleanup(): void {
      stopSpinner();
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      disableMouseTracking();
      leaveAlternateScreen();
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

function renderMessage(msg: ChatMessage, buf: Buf, maxWidth: number, expanded: boolean = false): void {
  buf.push("");

  switch (msg.role) {
    case "user": {
      // Same full-width bar as sticky input (inputBg + boxWidth = cols − 1 inner text)
      const { cols: termCols } = getTermSize();
      const boxWidth = Math.max(1, termCols - 1);
      const emptyLine = " ".repeat(boxWidth + 1);
      const padRow = (s: string) => {
        const v = stripAnsi(s).length;
        return v < termCols ? s + " ".repeat(termCols - v) : s;
      };
      const padInner = (line: string) => {
        const v = stripAnsi(line).length;
        return line + " ".repeat(Math.max(0, boxWidth - v));
      };
      const lines = wrapLines(msg.content, boxWidth);
      buf.push(padRow(inputBg(emptyLine)));
      for (const wl of lines) {
        buf.push(padRow(inputBg(` ${padInner(wl)}`)));
      }
      buf.push(padRow(inputBg(emptyLine)));
      break;
    }

    case "assistant": {
      // Main content — word-wrapped, no box
      renderWrappedContent(msg.content, buf, maxWidth);

      // Bullet points
      if (msg.bulletPoints && msg.bulletPoints.length > 0) {
        buf.push("");
        for (const bp of msg.bulletPoints) {
          buf.push(`  ${C.dim("•")} ${chalk.white(bp)}`);
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
        buf.push(`  ${chalk.white(line)}`);
      });
      break;

    case "tool": {
      const bg = msg.toolColor === "red" ? toolBgRed : toolBgGreen;
      const targetColor = msg.toolColor === "red" ? toolTargetRed : toolTargetGreen;
      const boxWidth = Math.max(maxWidth, 40);
      const empty = " ".repeat(boxWidth);

      // Top padding
      buf.push("  " + bg(empty));

      // Header line: bold action + colored target
      const headerText = `${msg.toolAction ?? "tool"} ${msg.toolTarget ?? ""}`;
      const headerPad = " ".repeat(Math.max(0, boxWidth - headerText.length - 1));
      buf.push("  " + bg(` ${toolActionColor(msg.toolAction ?? "tool")} ${targetColor(msg.toolTarget ?? "")}${headerPad}`));

      // Content preview — show all if expanded, otherwise max 8 lines
      // Use ALL lines (including empty) for accurate count
      const contentLines = msg.content.split("\n");
      const MAX_PREVIEW = 8;
      const showLines = expanded ? contentLines : contentLines.slice(0, MAX_PREVIEW);
      const remaining = expanded ? 0 : Math.max(0, contentLines.length - MAX_PREVIEW);

      buf.push("  " + bg(empty)); // blank line after header
      for (const line of showLines) {
        const trimmed = line.slice(0, boxWidth - 4);
        const linePad = " ".repeat(Math.max(0, boxWidth - trimmed.length - 3));
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

      // Bottom padding
      buf.push("  " + bg(empty));
      break;
    }
  }
}

/** Render content with markdown-like formatting, word-wrapped to maxWidth. */
function renderWrappedContent(content: string, buf: Buf, maxWidth: number): void {
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Empty lines
    if (!trimmed) {
      buf.push("");
      continue;
    }

    // --- Horizontal rule ---
    if (/^[-*_]{3,}$/.test(trimmed) || trimmed === "***") {
      buf.push(`  ${C.dimmer("─".repeat(Math.min(maxWidth - 4, 40)))}`);
      continue;
    }

    // ### Headings
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      const text = applyInlineFormatting(headingMatch[2]);
      buf.push("");
      buf.push(`  ${C.primaryBold(text)}`);
      continue;
    }

    // Bullet points: *, -, •
    const bulletMatch = trimmed.match(/^[*\-•]\s+(.+)/);
    if (bulletMatch) {
      const text = applyInlineFormatting(bulletMatch[1]);
      const indent = line.match(/^\s*/)?.[0]?.length ?? 0;
      const indentStr = indent > 2 ? "      " : "    ";
      const symbol = indent > 2 ? C.dim("◦") : C.dim("•");
      wrapLines(stripAnsi(text), maxWidth - indentStr.length - 2).forEach((wl, i) => {
        const colored = applyInlineFormatting(wl);
        buf.push(i === 0 ? `  ${indentStr.slice(2)}${symbol} ${colored}` : `  ${indentStr}  ${colored}`);
      });
      continue;
    }

    // Numbered lists
    const numMatch = trimmed.match(/^(\d+)\.\s+(.+)/);
    if (numMatch) {
      const num = numMatch[1];
      const text = applyInlineFormatting(numMatch[2]);
      wrapLines(stripAnsi(text), maxWidth - 6).forEach((wl, i) => {
        const colored = applyInlineFormatting(wl);
        buf.push(i === 0 ? `  ${C.primaryBold(num + ".")} ${colored}` : `      ${colored}`);
      });
      continue;
    }

    // Regular text — wrap and apply inline formatting
    const plainText = stripAnsi(trimmed);
    wrapLines(plainText, maxWidth - 2).forEach((wl) => {
      buf.push(`  ${applyInlineFormatting(wl)}`);
    });
  }
}

/** Apply inline markdown formatting: **bold**, `code`, *italic* */
function applyInlineFormatting(text: string): string {
  let result = text;
  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, (_m, t) => chalk.white.bold(t));
  result = result.replace(/__(.+?)__/g, (_m, t) => chalk.white.bold(t));
  // Inline code: `code`
  result = result.replace(/`([^`]+)`/g, (_m, t) => C.accent(t));
  // Italic: *text* (but not ** which is bold)
  result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_m, t) => chalk.white.italic(t));
  // If no formatting was applied, make it white
  if (result === text) {
    result = chalk.white(text);
  }
  return result;
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
