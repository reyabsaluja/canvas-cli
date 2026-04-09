import chalk from "chalk";
import type { AssignmentWorkup } from "../work/types.js";
import type { LoadedWorkspace } from "../ask/types.js";
import { readWorkspaceExtractedFile } from "../ask/load-workspace.js";
import type { AIProviderConfig } from "../ai/provider.js";
import { askWorkspaceQuestion, createChatContext, type ToolCallEvent } from "./services.js";
import {
  C,
  clearScreen,
  createBuffer,
  getTermSize,
  invalidateScreenRows,
  padAnsiToWidth,
  stripAnsi,
  truncatePlainToWidth,
  visibleWidth,
  wrapPlainText,
} from "./screen.js";
import { startTerminalSession } from "./terminal.js";
import { getActivePinPartial, getPinOverlayIndent, getVisibleInputSegment } from "./workspace-input.js";

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
const MAX_UI_MESSAGES = 120;
const MIN_UI_MESSAGES = 80;
const MAX_UI_MESSAGE_CHARS = 140000;
const FULL_RENDER_BATCH_MS = 16;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const VERBS = ["Working", "Thinking", "Studying", "Reading", "Analyzing", "Exploring", "Reviewing"];

type Buf = { push(line: string): void };
type RenderCacheEntry = { width: number; expanded: boolean; lines: string[] };
type TranscriptBlock = { message: ChatMessage; lines: string[]; lineCount: number };
type TranscriptIndexState = {
  width: number;
  blocks: TranscriptBlock[];
  cumulativeEnds: number[];
  totalLines: number;
  dirtyFrom: number;
};
type CachedRowsState = {
  rows: string[] | null;
  screenSize: string;
  startRow: number;
};
type InputState = {
  activePinPartial: string | null;
  pinMatches: Array<{ name: string; label: string }>;
  slashMatches: Array<{ cmd: string; desc: string }>;
};

export async function runWorkspaceUI(
  ctx: WorkspaceContext
): Promise<"back" | "courses" | "quit" | "refresh"> {
  const messages: ChatMessage[] = [];
  const CLEAN_INDEX = Number.MAX_SAFE_INTEGER;
  const chatCtx = ctx.aiConfig
    ? createChatContext(ctx.aiConfig, ctx.loaded, ctx.agentContext)
    : null;

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
  let pendingTextInput = "";
  let pendingTextInputFlushQueued = false;
  let totalMessageChars = 0;
  let archivedMessageCount = 0;
  let archivedMessageChars = 0;
  let archiveNoticeMessage: ChatMessage | null = null;
  let inputStateCacheKey = "";
  let inputStateCache: InputState | null = null;
  const footerRenderCache = createCachedRowsState();
  const overlayRenderCache = createCachedRowsState();

  let renderCache = new WeakMap<ChatMessage, RenderCacheEntry>();
  const transcriptIndexes = {
    normal: createTranscriptIndexState(),
    expanded: createTranscriptIndexState(),
  };

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

  if (ctx.workup?.overview) {
    appendMessage({ role: "system", content: ctx.workup.overview });
  }

  function clipToolContent(content: string): string {
    return content.length <= MAX_TOOL_CONTENT_CHARS
      ? content
      : content.slice(0, MAX_TOOL_CONTENT_CHARS) +
          `\n\n[truncated ${content.length - MAX_TOOL_CONTENT_CHARS} chars for UI performance]`;
  }

  function getInputState(): InputState {
    const cacheKey = `${showSlashMenu ? "1" : "0"}\n${inputBuffer}`;
    if (inputStateCache && inputStateCacheKey === cacheKey) {
      return inputStateCache;
    }

    const activePinPartial = getActivePinPartial(inputBuffer);
    const pinMatches =
      activePinPartial === null
        ? []
        : !activePinPartial
          ? pinOptions
          : pinOptions.filter((p) => p.label.includes(activePinPartial.toLowerCase()));

    const slashMatches =
      showSlashMenu &&
      inputBuffer.startsWith("/") &&
      (activePinPartial === null || inputBuffer.startsWith("/pin"))
        ? SLASH_COMMANDS.filter((c) => c.cmd.startsWith(inputBuffer.toLowerCase()))
        : [];

    inputStateCache = {
      activePinPartial,
      pinMatches,
      slashMatches,
    };
    inputStateCacheKey = cacheKey;
    return inputStateCache;
  }

  function createTranscriptIndexState(): TranscriptIndexState {
    return {
      width: -1,
      blocks: [],
      cumulativeEnds: [],
      totalLines: 0,
      dirtyFrom: 0,
    };
  }

  function createCachedRowsState(): CachedRowsState {
    return {
      rows: null,
      screenSize: "",
      startRow: -1,
    };
  }

  function markTranscriptDirty(index: number): void {
    transcriptIndexes.normal.dirtyFrom = Math.min(transcriptIndexes.normal.dirtyFrom, index);
    transcriptIndexes.expanded.dirtyFrom = Math.min(transcriptIndexes.expanded.dirtyFrom, index);
  }

  function appendMessage(message: ChatMessage): void {
    messages.push(message);
    totalMessageChars += message.content.length;
    markTranscriptDirty(messages.length - 1);
    compactMessagesIfNeeded();
  }

  function replaceLastMessage(message: ChatMessage): void {
    const index = Math.max(0, messages.length - 1);
    if (messages.length === 0) {
      messages.push(message);
      totalMessageChars += message.content.length;
    } else {
      totalMessageChars += message.content.length - messages[index].content.length;
      messages[index] = message;
    }
    markTranscriptDirty(index);
    compactMessagesIfNeeded();
  }

  function updateArchiveNotice(): void {
    if (archivedMessageCount <= 0) {
      if (archiveNoticeMessage && messages[0] === archiveNoticeMessage) {
        totalMessageChars -= archiveNoticeMessage.content.length;
        messages.shift();
        archiveNoticeMessage = null;
        markTranscriptDirty(0);
      }
      return;
    }

    const content =
      `Earlier transcript compacted for performance.\n` +
      `${archivedMessageCount} messages hidden from live scrollback ` +
      `(${archivedMessageChars.toLocaleString()} chars).`;

    if (archiveNoticeMessage && messages[0] === archiveNoticeMessage) {
      totalMessageChars += content.length - archiveNoticeMessage.content.length;
      archiveNoticeMessage = { role: "system", content };
      messages[0] = archiveNoticeMessage;
    } else {
      archiveNoticeMessage = { role: "system", content };
      messages.unshift(archiveNoticeMessage);
      totalMessageChars += archiveNoticeMessage.content.length;
    }

    markTranscriptDirty(0);
  }

  function compactMessagesIfNeeded(): void {
    const archiveOffset = archiveNoticeMessage && messages[0] === archiveNoticeMessage ? 1 : 0;

    while (
      ((messages.length - archiveOffset > MAX_UI_MESSAGES) ||
        totalMessageChars > MAX_UI_MESSAGE_CHARS) &&
      messages.length - archiveOffset > MIN_UI_MESSAGES
    ) {
      const removed = messages.splice(archiveOffset, 1)[0];
      totalMessageChars -= removed.content.length;
      archivedMessageCount += 1;
      archivedMessageChars += removed.content.length;
      markTranscriptDirty(archiveOffset);
    }

    if (archivedMessageCount > 0) {
      updateArchiveNotice();
    }
  }

  function ensureTranscriptIndex(
    state: TranscriptIndexState,
    width: number,
    expanded: boolean
  ): void {
    if (state.width !== width) {
      state.width = width;
      state.blocks = [];
      state.cumulativeEnds = [];
      state.totalLines = 0;
      state.dirtyFrom = 0;
    }

    if (messages.length === 0) {
      state.blocks = [];
      state.cumulativeEnds = [];
      state.totalLines = 0;
      state.dirtyFrom = CLEAN_INDEX;
      return;
    }

    if (state.dirtyFrom === CLEAN_INDEX && state.blocks.length === messages.length) {
      return;
    }

    const start = Math.min(state.dirtyFrom, messages.length - 1);
    for (let i = start; i < messages.length; i++) {
      const message = messages[i];
      const lines = getRenderedMessageLines(message, width, expanded);
      state.blocks[i] = {
        message,
        lines,
        lineCount: lines.length,
      };
      const prevEnd = i === 0 ? 0 : state.cumulativeEnds[i - 1];
      state.cumulativeEnds[i] = prevEnd + lines.length;
    }

    state.blocks.length = messages.length;
    state.cumulativeEnds.length = messages.length;
    state.totalLines = state.cumulativeEnds[messages.length - 1] ?? 0;
    state.dirtyFrom = CLEAN_INDEX;
  }

  function findFirstBlockEndingAfter(cumulativeEnds: number[], lineIndex: number): number {
    let lo = 0;
    let hi = cumulativeEnds.length - 1;
    let found = cumulativeEnds.length;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (cumulativeEnds[mid] > lineIndex) {
        found = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }

    return found;
  }

  function collectTranscriptRange(
    state: TranscriptIndexState,
    startLine: number,
    endLine: number
  ): string[] {
    if (startLine >= endLine || state.blocks.length === 0) {
      return [];
    }

    const lines: string[] = [];
    let blockIndex = findFirstBlockEndingAfter(state.cumulativeEnds, startLine);
    if (blockIndex >= state.blocks.length) {
      return lines;
    }

    while (blockIndex < state.blocks.length) {
      const block = state.blocks[blockIndex];
      const blockStart = blockIndex === 0 ? 0 : state.cumulativeEnds[blockIndex - 1];
      if (blockStart >= endLine) break;

      const sliceStart = Math.max(0, startLine - blockStart);
      const sliceEnd = Math.min(block.lineCount, endLine - blockStart);
      if (sliceStart < sliceEnd) {
        lines.push(...block.lines.slice(sliceStart, sliceEnd));
      }

      blockIndex += 1;
    }

    return lines;
  }

  function startSpinner(): void {
    stopSpinner();
    spinnerTimer = setInterval(() => {
      if (destroyed || !isProcessing || !currentSpinnerLine) return;
      if (chatScrollOffset > 0) return;
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

  function commitPendingTextInput(): void {
    if (!pendingTextInput) {
      return;
    }

    const previousInputState = getInputState();
    inputBuffer += pendingTextInput;
    pendingTextInput = "";
    showSlashMenu = inputBuffer.startsWith("/");

    const nextInputState = getInputState();
    if (nextInputState.activePinPartial !== null) {
      pinSelected = 0;
    } else if (showSlashMenu) {
      slashSelected = 0;
    }

    renderAfterInputMutation(previousInputState, nextInputState);
  }

  function flushPendingTextInput(): void {
    pendingTextInputFlushQueued = false;
    commitPendingTextInput();
  }

  function schedulePendingTextInputFlush(): void {
    if (pendingTextInputFlushQueued) {
      return;
    }
    pendingTextInputFlushQueued = true;
    queueMicrotask(() => {
      if (destroyed || !pendingTextInputFlushQueued) {
        return;
      }
      flushPendingTextInput();
    });
  }

  function resetPartialRenderCaches(): void {
    resetCachedRowsState(footerRenderCache);
    resetCachedRowsState(overlayRenderCache);
  }

  function resetCachedRowsState(cache: CachedRowsState): void {
    cache.rows = null;
    cache.screenSize = "";
    cache.startRow = -1;
  }

  function writeCachedRows(
    cache: CachedRowsState,
    startRow: number,
    rows: string[]
  ): void {
    const { rows: totalRows, cols } = getTermSize();
    const screenSizeKey = `${totalRows}:${cols}`;
    const normalized = rows.map((line) => padAnsiToWidth(line, cols));

    if (
      cache.screenSize !== screenSizeKey ||
      cache.startRow !== startRow ||
      !cache.rows ||
      cache.rows.length !== normalized.length
    ) {
      cache.rows = null;
      cache.screenSize = screenSizeKey;
      cache.startRow = startRow;
    }

    const writes: string[] = [];
    for (let index = 0; index < normalized.length; index++) {
      if (cache.rows?.[index] === normalized[index]) {
        continue;
      }
      if (writes.length === 0) {
        writes.push("\x1B[0m");
      }
      writes.push(`\x1B[${startRow + index};1H\x1B[0m\x1B[2K${normalized[index]!}`);
    }
    if (writes.length > 0) {
      writes.push("\x1B[0m");
      process.stdout.write(writes.join(""));
      invalidateScreenRows(startRow, startRow + normalized.length - 1);
    }

    cache.rows = normalized.slice();
  }

  function writeFooterRows(rows: string[]): void {
    const { rows: totalRows } = getTermSize();
    writeCachedRows(footerRenderCache, totalRows - NORMAL_FOOTER_ROWS + 1, rows);
  }

  function writeOverlayRows(rows: string[]): void {
    if (rows.length === 0) {
      resetCachedRowsState(overlayRenderCache);
      return;
    }

    const { rows: totalRows } = getTermSize();
    const startRow = totalRows - NORMAL_FOOTER_ROWS - rows.length + 1;
    writeCachedRows(overlayRenderCache, startRow, rows);
  }

  function writeFrame(lines: string[]): void {
    const { cols, rows } = getTermSize();
    const frame = lines.slice(0, rows).map((line) => padAnsiToWidth(line, cols));
    while (frame.length < rows) {
      frame.push(" ".repeat(cols));
    }
    const buf = createBuffer();
    for (const line of frame) {
      buf.push(line);
    }
    buf.flush();
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
    const visibleInput = getVisibleInputSegment(inputText, boxWidth).text;
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

  function buildOverlayLines(cols: number, maxRows: number, inputState: InputState): string[] {
    if (isProcessing || toolOutputExpanded || maxRows <= 0) return [];

    const padFull = (line: string): string => padAnsiToWidth(line, cols);
    const pinMatches = inputState.pinMatches;

    if (pinMatches.length > 0) {
      const maxShow = Math.min(pinMatches.length, Math.min(MAX_OVERLAY_ROWS, maxRows));
      let start = 0;
      if (pinMatches.length > maxShow) {
        start = Math.max(0, Math.min(pinSelected - Math.floor(maxShow / 2), pinMatches.length - maxShow));
      }
      const indent = " ".repeat(Math.max(0, getPinOverlayIndent(inputBuffer, Math.max(1, cols - 1))));
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

    const matches = inputState.slashMatches;
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

  function buildVisibleOverlayLines(inputState: InputState): string[] {
    const { cols, rows } = getTermSize();
    const headerLines = buildHeaderLines(chatScrollOffset > 0);
    const overlayBudget = Math.max(0, rows - headerLines.length - NORMAL_FOOTER_ROWS - 1);
    return buildOverlayLines(cols, overlayBudget, inputState);
  }

  function renderInputOnly(
    inputState: InputState = getInputState(),
    overlayLines: string[] = buildVisibleOverlayLines(inputState)
  ): void {
    if (toolOutputExpanded || isProcessing) {
      scheduleRender(true);
      return;
    }
    const { cols } = getTermSize();
    writeFooterRows(buildNormalFooterLines(cols));
    writeOverlayRows(overlayLines);
  }

  function renderAfterInputMutation(
    previousInputState: InputState,
    nextInputState: InputState = getInputState()
  ): void {
    if (toolOutputExpanded || isProcessing) {
      scheduleRender(true);
      return;
    }

    const previousOverlayLines = buildVisibleOverlayLines(previousInputState);
    const nextOverlayLines = buildVisibleOverlayLines(nextInputState);
    if (previousOverlayLines.length !== nextOverlayLines.length) {
      scheduleRender(true);
      return;
    }

    renderInputOnly(nextInputState, nextOverlayLines);
  }

  function renderNow(): void {
    const { cols, rows } = getTermSize();
    if (cols <= 0 || rows <= 0) return;
    resetPartialRenderCaches();

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
    const overlayLines = buildOverlayLines(cols, overlayBudget, getInputState());
    const transcriptRows = Math.max(
      1,
      rows - headerLines.length - overlayLines.length - NORMAL_FOOTER_ROWS
    );
    const transcript = getVisibleTranscriptLines(contentWidth, transcriptRows, chatScrollOffset, false);
    const footerLines = buildNormalFooterLines(cols);
    writeFrame([...headerLines, ...transcript.lines]);
    writeOverlayRows(overlayLines);
    writeFooterRows(footerLines);
  }

  function getVisibleTranscriptLines(
    width: number,
    maxRows: number,
    offsetFromBottom: number,
    expanded: boolean
  ): { lines: string[]; totalLines: number } {
    const state = expanded ? transcriptIndexes.expanded : transcriptIndexes.normal;
    ensureTranscriptIndex(state, width, expanded);

    const spinnerLines = isProcessing && currentSpinnerLine ? ["", currentSpinnerLine, ""] : [];
    const totalLines = state.totalLines + spinnerLines.length;
    const maxScroll = Math.max(0, totalLines - maxRows);
    chatScrollOffset = Math.max(0, Math.min(offsetFromBottom, maxScroll));

    const startLine = Math.max(0, totalLines - maxRows - chatScrollOffset);
    const endLine = Math.min(totalLines, startLine + maxRows);
    const messageEndLine = Math.min(endLine, state.totalLines);

    const lines = collectTranscriptRange(state, startLine, messageEndLine);
    if (spinnerLines.length > 0 && endLine > state.totalLines) {
      const spinnerStart = Math.max(0, startLine - state.totalLines);
      const spinnerEnd = Math.min(spinnerLines.length, endLine - state.totalLines);
      lines.push(...spinnerLines.slice(spinnerStart, spinnerEnd));
    }

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
      const isPrintableText = key.length === 1 && key >= " ";
      if (!isPrintableText && pendingTextInput) {
        flushPendingTextInput();
      }

      const mouseMatch = key.match(/^\x1b\[<(\d+);\d+;\d+[Mm]/);
      if (mouseMatch) {
        const btn = parseInt(mouseMatch[1], 10);
        if (btn === 64) {
          chatScrollOffset += 3;
          scheduleRender();
        } else if (btn === 65) {
          chatScrollOffset = Math.max(0, chatScrollOffset - 3);
          scheduleRender();
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
        scheduleRender();
        return;
      }

      if (key === "\x1b[5~" || key === "\x1B[5~" || key === "\x10") {
        chatScrollOffset += scrollPageStep();
        scheduleRender();
        return;
      }
      if (key === "\x1b[6~" || key === "\x1B[6~" || key === "\x0e") {
        chatScrollOffset = Math.max(0, chatScrollOffset - scrollPageStep());
        scheduleRender();
        return;
      }
      if (key === "\x1b[4~" || key === "\x1B[4~") {
        chatScrollOffset = 0;
        scheduleRender();
        return;
      }
      if (key === "\x1b[1~" || key === "\x1B[1~") {
        chatScrollOffset = Number.MAX_SAFE_INTEGER;
        scheduleRender();
        return;
      }

      if (key === "\x1B") {
        if (showSlashMenu) {
          const previousInputState = getInputState();
          showSlashMenu = false;
          renderAfterInputMutation(previousInputState, getInputState());
        }
        return;
      }

      if (key === "\r" || key === "\n") {
        chatScrollOffset = 0;

        const inputState = getInputState();
        const pinPartial = inputState.activePinPartial;
        if (pinPartial !== null) {
          const pinMatches = inputState.pinMatches;
          const isComplete = pinOptions.some((p) => p.label === pinPartial);
          if (!isComplete && pinMatches.length > 0) {
            const selected = pinMatches[pinSelected];
            inputBuffer = inputBuffer.replace(/\/pin(\s+\S*)?$/, `/pin ${selected.label}`);
            pinSelected = 0;
            renderAfterInputMutation(inputState, getInputState());
            return;
          }
        }

        if (inputState.slashMatches.length > 0) {
          const matches = inputState.slashMatches;
          inputBuffer = matches[slashSelected].cmd;
          showSlashMenu = false;
        }

        const input = inputBuffer.trim();
        inputBuffer = "";
        slashSelected = 0;
        showSlashMenu = false;

        if (!input) {
          renderAfterInputMutation(inputState, getInputState());
          return;
        }

        if (input.startsWith("/")) {
          const msg: ChatMessage = { role: "user", content: input };
          appendMessage(msg);
          const navResult = handleSlashCommand(cmdFromInput(input), ctx, appendMessage);
          if (navResult) {
            cleanup();
            resolve(navResult);
            return;
          }
          scheduleRender(true);
          return;
        }

        const fullQuestion = await buildPinnedQuestion(input, ctx, pinOptions);

        const userMessage: ChatMessage = { role: "user", content: input };
        appendMessage(userMessage);

        if (!ctx.aiConfig) {
          const systemMessage: ChatMessage = {
            role: "system",
            content: "AI unavailable (no ANTHROPIC_API_KEY). Slash commands still work — type /help",
          };
          appendMessage(systemMessage);
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
        let pendingStreamDelta = "";
        let streamCommitTimer: ReturnType<typeof setTimeout> | null = null;

        function commitPendingStreamDelta(): void {
          if (!pendingStreamDelta) {
            return;
          }

          if (!streamingStarted) {
            streamingStarted = true;
            stopSpinner();
            currentSpinnerLine = "";
            const assistantMessage: ChatMessage = { role: "assistant", content: "" };
            appendMessage(assistantMessage);
          }

          streamedText += pendingStreamDelta;
          pendingStreamDelta = "";
          replaceLastMessage({
            role: "assistant",
            content: streamedText,
          });
          scheduleRender();
        }

        function flushPendingStreamDelta(): void {
          if (streamCommitTimer) {
            clearTimeout(streamCommitTimer);
            streamCommitTimer = null;
          }
          commitPendingStreamDelta();
        }

        function schedulePendingStreamDelta(): void {
          if (streamCommitTimer) {
            return;
          }
          streamCommitTimer = setTimeout(() => {
            streamCommitTimer = null;
            commitPendingStreamDelta();
          }, FULL_RENDER_BATCH_MS);
        }

        try {
          const answer = await askWorkspaceQuestion(
            ctx.aiConfig,
            ctx.loaded,
            fullQuestion,
            (event: ToolCallEvent) => {
              flushPendingStreamDelta();
              if (streamingStarted && streamedText.trim()) {
                const partialMessage: ChatMessage = {
                  role: "assistant",
                  content: streamedText.trim(),
                };
                replaceLastMessage(partialMessage);
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
              appendMessage(toolMessage);
              currentSpinnerLine = `  ${C.primary(SPINNER[spinnerFrame])} ${C.accent(currentVerb)}${chalk.white("...")}`;
              scheduleRender();
            },
            ctx.agentContext,
            chatCtx ?? undefined,
            (delta: string) => {
              pendingStreamDelta += delta;
              schedulePendingStreamDelta();
            }
          );

          flushPendingStreamDelta();
          stopSpinner();

          if (streamingStarted) {
            const finalAssistant: ChatMessage = {
              role: "assistant",
              content: answer.answer || streamedText,
            };
            replaceLastMessage(finalAssistant);
          } else {
            const assistantMessage: ChatMessage = {
              role: "assistant",
              content: answer.answer,
              bulletPoints: answer.bulletPoints,
              sources: answer.sources,
              confidence: answer.confidence,
            };
            appendMessage(assistantMessage);
          }
        } catch (err) {
          flushPendingStreamDelta();
          stopSpinner();
          const errorMessage: ChatMessage = {
            role: "system",
            content: `Error: ${err instanceof Error ? err.message : "unknown"}`,
          };
          appendMessage(errorMessage);
        }

        isProcessing = false;
        currentSpinnerLine = "";
        scheduleRender(true);
        return;
      }

      const inputState = getInputState();

      if (key === "\x1B[A" && inputState.activePinPartial !== null && inputState.pinMatches.length > 0) {
        pinSelected = Math.max(0, pinSelected - 1);
        renderInputOnly(inputState);
        return;
      }
      if (key === "\x1B[B" && inputState.activePinPartial !== null && inputState.pinMatches.length > 0) {
        pinSelected = Math.min(inputState.pinMatches.length - 1, pinSelected + 1);
        renderInputOnly(inputState);
        return;
      }
      if (key === "\x1B[A" && inputState.slashMatches.length > 0) {
        slashSelected = Math.max(0, slashSelected - 1);
        renderInputOnly(inputState);
        return;
      }
      if (key === "\x1B[B" && inputState.slashMatches.length > 0) {
        slashSelected = Math.min(inputState.slashMatches.length - 1, slashSelected + 1);
        renderInputOnly(inputState);
        return;
      }

      if (key === "\x1B[A") {
        chatScrollOffset += 3;
        scheduleRender();
        return;
      }
      if (key === "\x1B[B") {
        chatScrollOffset = Math.max(0, chatScrollOffset - 3);
        scheduleRender();
        return;
      }

      if (key === "\x7F" || key === "\b") {
        if (inputBuffer.length > 0) {
          const previousInputState = inputState;
          inputBuffer = inputBuffer.slice(0, -1);
          showSlashMenu = inputBuffer.startsWith("/");
          slashSelected = 0;
          renderAfterInputMutation(previousInputState, getInputState());
        }
        return;
      }

      if (key === "\t" && inputState.slashMatches.length > 0) {
        inputBuffer = inputState.slashMatches[slashSelected].cmd;
        showSlashMenu = true;
        renderAfterInputMutation(inputState, getInputState());
        return;
      }

      if (isPrintableText) {
        pendingTextInput += key;
        schedulePendingTextInputFlush();
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
      pendingTextInput = "";
      pendingTextInputFlushQueued = false;
      resetPartialRenderCaches();
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

async function buildPinnedQuestion(
  input: string,
  ctx: WorkspaceContext,
  pinOptions: Array<{ label: string; name: string }>
): Promise<string> {
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
        const extracted = await readWorkspaceExtractedFile(ctx.loaded, ef);
        content = extracted?.slice(0, 15000) ?? "";
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
  appendMessage: (message: ChatMessage) => void
): "back" | "courses" | "quit" | "refresh" | null {
  const pushMessage = (message: ChatMessage): null => {
    appendMessage(message);
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
