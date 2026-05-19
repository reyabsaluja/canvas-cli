import { spawn } from "node:child_process";
import chalk from "chalk";
import { C, getTermSize, stripAnsi } from "./screen.js";
import { formatAIError } from "../ai/provider.js";
import type { Observation } from "../agent/observation.js";
import { executeMakePdf } from "./pdf-command.js";
import type {
  ChatMessage,
  CommandDefinition,
  ChatSession,
  ScopeRuntime,
} from "./chat-state.js";
import {
  formatScopeTargets,
  getAvailableCommands,
  resolveCommand,
} from "./commands.js";
import type {
  ShellOpenOption,
  ShellPinOption,
  ShellRuntimeApi,
} from "./app-types.js";
import {
  extractInlinePins,
  mergePinOptions,
} from "./pins.js";
import type { OpenableResource } from "./open-resources.js";
import { searchOpenableResources, getOpenCommand } from "./open-resources.js";
import {
  MAIN_VIEW_BOTTOM_RESERVE,
  buildBannerLines,
  getInputMode,
  getRenderedMessageLines,
  renderChatFrame,
  renderInputFooter,
} from "./chat-shell-render.js";
import { ChatShellPersistence } from "./chat-shell-persistence.js";
import { enterChatShell, leaveChatShell } from "./chat-shell-terminal.js";
import { copyToClipboard } from "./clipboard.js";
import {
  formatConversationForCopy,
  formatLastAssistantForCopy,
  formatLastNForCopy,
} from "./chat-copy.js";
import { createSerialTaskQueue } from "./serial-task-queue.js";
import { exitShellAborted } from "./chat-shell-exit.js";
import { getActivePinPartial } from "./workspace-input.js";

interface ChatShellApi<TExit> extends ShellRuntimeApi {
  addMessage: (message: ChatMessage) => Promise<void>;
  addMessages: (messages: ChatMessage[]) => Promise<void>;
  resolve: (result: TExit | null) => void;
}

interface AskCallbacks {
  onToolCall?: (event: {
    action: string;
    target: string;
    result: string;
    color: "green" | "red";
    observation?: Observation;
  }) => void;
  onTextDelta?: (delta: string) => void;
  abortSignal?: AbortSignal;
}

export interface ChatShellOptions<TExit> {
  session: ChatSession;
  runtime: ScopeRuntime;
  commands: CommandDefinition[];
  modelLabel: string;
  bannerRenderer?: (buf: { push(line?: string): void }) => void;
  extraHelpCommands?: Array<{ cmd: string; desc: string }>;
  getPinOptions?: () => ShellPinOption[];
  getOpenOptions?: () => ShellOpenOption[];
  getLoadedWorkspace?: () => import("../ask/types.js").LoadedWorkspace | null;
  getCourseCache?: () => import("../enrich/cache-loader.js").CourseCache | null;
  onClear?: () => Promise<ChatMessage[]>;
  resolvePinContent?: (pin: ShellPinOption) => Promise<string | null>;
  onAsk: (input: string, callbacks: AskCallbacks) => Promise<{
    content: string;
    bulletPoints?: string[];
    sources?: Array<{ title: string; kind: string; section?: string | null }>;
    confidence?: string;
    verificationNote?: string | null;
  }>;
  onCommand: (
    command: string,
    args: string,
    api: ChatShellApi<TExit>
  ) => Promise<TExit | null | void>;
  onReady?: (api: ShellRuntimeApi) => Promise<void> | void;
}

const inlinePdfPattern = /\s\/(?:make-pdf|pdf)\s*$/i;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const VERBS = [
  "Working",
  "Thinking",
  "Studying",
  "Reading",
  "Analyzing",
  "Exploring",
  "Reviewing",
];
const PAST_TENSE: Record<string, string> = {
  Working: "Worked",
  Thinking: "Thought",
  Studying: "Studied",
  Reading: "Read",
  Analyzing: "Analyzed",
  Exploring: "Explored",
  Reviewing: "Reviewed",
};
const spinnerColor = chalk.hex("#e82429");
const SHIMMER_COLORS = [
  chalk.hex("#6e1114"),
  chalk.hex("#8c1618"),
  chalk.hex("#ab1b1e"),
  chalk.hex("#c92023"),
  chalk.hex("#e82429"),
  chalk.hex("#f25a5e"),
  chalk.hex("#f78e90"),
  chalk.hex("#f25a5e"),
  chalk.hex("#e82429"),
  chalk.hex("#c92023"),
  chalk.hex("#ab1b1e"),
  chalk.hex("#8c1618"),
];

function buildShimmerText(text: string, frame: number): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const colorIndex = (frame + i) % SHIMMER_COLORS.length;
    result += SHIMMER_COLORS[colorIndex]!(text[i]!);
  }
  return result;
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m${remaining}s`;
}
const FULL_RENDER_BATCH_MS = 16;
const CLEAN_TRANSCRIPT_INDEX = Number.MAX_SAFE_INTEGER;

type TranscriptBlock = {
  message: ChatMessage;
  lines: string[];
  lineCount: number;
};

type TranscriptIndexState = {
  contentWidth: number;
  cols: number;
  blocks: TranscriptBlock[];
  cumulativeEnds: number[];
  totalLines: number;
  dirtyFrom: number;
};

type InputState = {
  activeOpenPartial: string | null;
  activePinPartial: string | null;
  openMatches: ShellOpenOption[];
  pinMatches: ShellPinOption[];
  slashMatches: CommandDefinition[];
  hasVisibleOverlay: boolean;
};

export async function runChatShell<TExit>(
  options: ChatShellOptions<TExit>
): Promise<TExit | null> {
  const session = options.session;
  const messages = session.messages;
  const persistence = new ChatShellPersistence(session, messages);
  const availableCommands = getAvailableCommands(
    options.commands,
    options.runtime.scope.type
  );

  let inputBuffer = "";
  let slashSelected = 0;
  let openSelected = 0;
  let pinSelected = 0;
  let showSlashMenu = false;
  let isProcessing = false;
  let pendingPins: ShellPinOption[] = [];
  let toolOutputExpanded = false;
  let currentSpinnerLine = "";
  let spinnerFrame = 0;
  let chatScrollOffset = 0;
  let maxChatScrollOffset = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let renderQueued = false;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let currentVerb = "";
  let shimmerFrame = 0;
  let processingStartTime = 0;
  let processingAbort: AbortController | null = null;
  let preProcessingInput = "";
  let stdinEscHold = "";
  let stdinEscTimer: ReturnType<typeof setTimeout> | null = null;
  let bannerLinesCache: string[] | null = null;
  let bannerCacheCols = -1;
  let openSearchOptionsRef: ShellOpenOption[] | null = null;
  let openSearchResources: OpenableResource[] = [];
  const transcriptIndexes = {
    normal: createTranscriptIndexState(),
    expanded: createTranscriptIndexState(),
  };

  const placeholder =
    options.runtime.placeholder ?? "Type your message or /help for commands";

  function createTranscriptIndexState(): TranscriptIndexState {
    return {
      contentWidth: -1,
      cols: -1,
      blocks: [],
      cumulativeEnds: [],
      totalLines: 0,
      dirtyFrom: 0,
    };
  }

  function markTranscriptDirty(index: number): void {
    const normalized = Math.max(0, index);
    transcriptIndexes.normal.dirtyFrom = Math.min(
      transcriptIndexes.normal.dirtyFrom,
      normalized
    );
    transcriptIndexes.expanded.dirtyFrom = Math.min(
      transcriptIndexes.expanded.dirtyFrom,
      normalized
    );
  }

  function getCachedBannerLines(): string[] {
    const { cols } = getTermSize();
    if (bannerLinesCache && bannerCacheCols === cols) {
      return bannerLinesCache;
    }
    bannerLinesCache = buildBannerLines({
      runtime: options.runtime,
      bannerRenderer: options.bannerRenderer,
    });
    bannerCacheCols = cols;
    return bannerLinesCache;
  }

  function ensureTranscriptIndex(
    state: TranscriptIndexState,
    contentWidth: number,
    cols: number,
    expanded: boolean
  ): void {
    if (state.contentWidth !== contentWidth || state.cols !== cols) {
      state.contentWidth = contentWidth;
      state.cols = cols;
      state.blocks = [];
      state.cumulativeEnds = [];
      state.totalLines = 0;
      state.dirtyFrom = 0;
    }

    if (messages.length === 0) {
      state.blocks = [];
      state.cumulativeEnds = [];
      state.totalLines = 0;
      state.dirtyFrom = CLEAN_TRANSCRIPT_INDEX;
      return;
    }

    if (
      state.dirtyFrom === CLEAN_TRANSCRIPT_INDEX &&
      state.blocks.length === messages.length
    ) {
      return;
    }

    const start = Math.min(state.dirtyFrom, messages.length - 1);
    for (let index = start; index < messages.length; index++) {
      const message = messages[index]!;
      const lines = getRenderedMessageLines(message, contentWidth, cols, expanded);
      state.blocks[index] = {
        message,
        lines,
        lineCount: lines.length,
      };
      const prevEnd = index === 0 ? 0 : state.cumulativeEnds[index - 1]!;
      state.cumulativeEnds[index] = prevEnd + lines.length;
    }

    state.blocks.length = messages.length;
    state.cumulativeEnds.length = messages.length;
    state.totalLines = state.cumulativeEnds[messages.length - 1] ?? 0;
    state.dirtyFrom = CLEAN_TRANSCRIPT_INDEX;
  }

  function findFirstBlockEndingAfter(
    cumulativeEnds: number[],
    lineIndex: number
  ): number {
    let lo = 0;
    let hi = cumulativeEnds.length - 1;
    let found = cumulativeEnds.length;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (cumulativeEnds[mid]! > lineIndex) {
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
      const block = state.blocks[blockIndex]!;
      const blockStart =
        blockIndex === 0 ? 0 : state.cumulativeEnds[blockIndex - 1]!;
      if (blockStart >= endLine) {
        break;
      }

      const sliceStart = Math.max(0, startLine - blockStart);
      const sliceEnd = Math.min(block.lineCount, endLine - blockStart);
      if (sliceStart < sliceEnd) {
        lines.push(...block.lines.slice(sliceStart, sliceEnd));
      }
      blockIndex += 1;
    }

    return lines;
  }

  function getActiveTranscriptIndex(): TranscriptIndexState {
    const { cols } = getTermSize();
    const contentWidth = Math.min(cols - 4, 100);
    const state = toolOutputExpanded
      ? transcriptIndexes.expanded
      : transcriptIndexes.normal;
    ensureTranscriptIndex(state, contentWidth, cols, toolOutputExpanded);
    return state;
  }

  async function appendPersistedMessage(message: ChatMessage): Promise<void> {
    markTranscriptDirty(messages.length);
    await persistence.addMessage(message);
  }

  async function appendPersistedMessages(nextMessages: ChatMessage[]): Promise<void> {
    if (nextMessages.length === 0) {
      return;
    }
    markTranscriptDirty(messages.length);
    await persistence.addMessages(nextMessages);
  }

  function getOpenOptions(): ShellOpenOption[] {
    return options.getOpenOptions?.() ?? [];
  }

  function getOpenSearchResources(
    openOptions: ShellOpenOption[]
  ): OpenableResource[] {
    if (openSearchOptionsRef === openOptions) {
      return openSearchResources;
    }

    openSearchOptionsRef = openOptions;
    openSearchResources = openOptions.map((option, index) => ({
      id: String(index),
      title: option.title,
      kind: option.detail ?? "resource",
      targetType: "file",
      target: option.query,
      detail: option.detail,
      searchTerms:
        option.searchTerms ?? [option.title, option.query, option.detail ?? ""],
    }));
    return openSearchResources;
  }

  function getActiveOpenPartial(value: string): string | null {
    if (options.runtime.scope.type === "global") return null;
    const match = value.match(/\/open(?:\s+(.*))?$/i);
    if (!match) return null;
    return (match[1] ?? "").trim();
  }

  function getInputState(): InputState {
    const activeOpenPartial = getActiveOpenPartial(inputBuffer);
    const activePinPartial = getActivePinPartial(inputBuffer);

    let openMatches: ShellOpenOption[] = [];
    if (activeOpenPartial !== null) {
      const openOptions = getOpenOptions();
      if (!activeOpenPartial) {
        openMatches = openOptions;
      } else {
        const searchableResources = getOpenSearchResources(openOptions);
        const ranked = searchOpenableResources(
          activeOpenPartial,
          searchableResources,
          openOptions.length
        );
        openMatches = ranked
          .map((resource) => openOptions[Number(resource.id)])
          .filter((option): option is ShellOpenOption => option !== undefined);
      }
    }

    let pinMatches: ShellPinOption[] = [];
    if (activePinPartial !== null) {
      if (!activePinPartial) {
        pinMatches = options.getPinOptions?.() ?? [];
      } else {
        const loweredPartial = activePinPartial.toLowerCase();
        pinMatches = (options.getPinOptions?.() ?? []).filter((pin) =>
          pin.label.includes(loweredPartial)
        );
      }
    }

    let slashMatches: CommandDefinition[] = [];
    if (
      showSlashMenu &&
      inputBuffer.startsWith("/") &&
      !(activeOpenPartial !== null && openMatches.length > 0)
    ) {
      const partial = inputBuffer.toLowerCase();
      slashMatches = availableCommands.filter((command) =>
        [command.name, ...(command.aliases ?? [])].some((alias) =>
          alias.startsWith(partial)
        )
      );
    }

    return {
      activeOpenPartial,
      activePinPartial,
      openMatches,
      pinMatches,
      slashMatches,
      hasVisibleOverlay:
        openMatches.length > 0 ||
        pinMatches.length > 0 ||
        slashMatches.length > 0,
    };
  }

  let lastTranscriptTotalLines = 0;

  function renderNow(): void {
    const transcriptIndex = getActiveTranscriptIndex();
    const inputState = getInputState();

    // Keep viewport stable when user is scrolled up and content grows
    if (chatScrollOffset > 0 && transcriptIndex.totalLines > lastTranscriptTotalLines) {
      chatScrollOffset += transcriptIndex.totalLines - lastTranscriptTotalLines;
    }
    lastTranscriptTotalLines = transcriptIndex.totalLines;

    const next = renderChatFrame({
      runtime: options.runtime,
      placeholder,
      inputBuffer,
      chatScrollOffset,
      isProcessing,
      currentSpinnerLine,
      modelLabel: options.modelLabel,
      bannerLines: getCachedBannerLines(),
      transcriptTotalLines: transcriptIndex.totalLines,
      getTranscriptLines: (startLine, endLine) =>
        collectTranscriptRange(transcriptIndex, startLine, endLine),
      slashMatches: inputState.slashMatches,
      openMatches: inputState.openMatches,
      pinMatches: inputState.pinMatches,
      slashSelected,
      openSelected,
      pinSelected,
      availableCommands,
    });
    chatScrollOffset = next.chatScrollOffset;
    maxChatScrollOffset = next.maxScroll;
  }

  function scheduleRender(immediate: boolean = false): void {
    if (immediate) {
      if (renderTimer) {
        clearTimeout(renderTimer);
        renderTimer = null;
      }
      renderQueued = false;
      renderNow();
      return;
    }

    if (renderQueued) {
      return;
    }

    renderQueued = true;
    renderTimer = setTimeout(() => {
      renderQueued = false;
      renderTimer = null;
      renderNow();
    }, FULL_RENDER_BATCH_MS);
  }

  function render(): void {
    scheduleRender(true);
  }

  function renderInputOnly(inputState: InputState = getInputState()): void {
    if (getInputMode() === "flowing") {
      render();
      return;
    }
    renderInputFooter({
      placeholder,
      inputBuffer,
      scopeLabel: options.runtime.scopeLabel,
      statusLabel: options.runtime.statusLabel,
      modelLabel: options.modelLabel,
      slashMatches: inputState.slashMatches,
      openMatches: inputState.openMatches,
      pinMatches: inputState.pinMatches,
      slashSelected,
      openSelected,
      pinSelected,
      availableCommands,
    });
  }

  function hasVisibleOverlay(inputState: InputState = getInputState()): boolean {
    return inputState.hasVisibleOverlay;
  }

  function renderAfterInputMutation(
    hadOverlay: boolean,
    inputState: InputState = getInputState()
  ): void {
    if (getInputMode() === "flowing") {
      render();
      return;
    }
    if (hadOverlay && !inputState.hasVisibleOverlay) {
      scheduleRender(true);
      return;
    }
    renderInputOnly(inputState);
  }

  function isSpinnerVisible(): boolean {
    return chatScrollOffset === 0;
  }

  function buildSpinnerLine(): string {
    const elapsed = formatElapsed(Date.now() - processingStartTime);
    const verbText = `${currentVerb}...`;
    const shimmer = buildShimmerText(verbText, shimmerFrame);
    return `${spinnerColor(SPINNER[spinnerFrame]!)} ${shimmer} ${C.dim(`(${elapsed})`)}  ${C.secondary("(esc to interrupt)")}`;
  }

  function startSpinner(): void {
    stopSpinner();
    spinnerTimer = setInterval(() => {
      if (!isProcessing || !currentSpinnerLine) return;
      if (!isSpinnerVisible()) return;
      spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
      shimmerFrame = (shimmerFrame + 1) % SHIMMER_COLORS.length;
      currentSpinnerLine = buildSpinnerLine();
      scheduleRender();
    }, 80);
  }

  function stopSpinner(): void {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
  }

  async function cleanup(
    stdin: NodeJS.ReadStream,
    onData: (data: string) => void
  ): Promise<string | null> {
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    if (stdinEscTimer) {
      clearTimeout(stdinEscTimer);
      stdinEscTimer = null;
    }
    renderQueued = false;
    return leaveChatShell(
      stdin,
      onData,
      () => persistence.flush(),
      stopSpinner,
      () => persistence.getFailureMessage()
    );
  }

  const stdin = enterChatShell(render);

  return new Promise((resolve) => {
    const keyQueue = createSerialTaskQueue();
    let shellClosed = false;
    let closingPromise: Promise<string | null> | null = null;

    const api: ChatShellApi<TExit> = {
      addMessage: async (message) => {
        await appendPersistedMessage(message);
      },
      addMessages: async (nextMessages) => {
        await appendPersistedMessages(nextMessages);
      },
      resolve: (result) => resolve(result),
      render,
      session,
      runtime: options.runtime,
    };

    async function closeShellOnce(): Promise<string | null> {
      if (closingPromise) {
        return closingPromise;
      }
      shellClosed = true;
      keyQueue.close();
      closingPromise = cleanup(stdin, onData);
      return closingPromise;
    }

    function scrollPageStep(): number {
      const { rows } = getTermSize();
      return Math.max(2, Math.floor((rows - MAIN_VIEW_BOTTOM_RESERVE) * 0.65));
    }

    function setChatScrollOffset(nextOffset: number): boolean {
      const normalized = Math.max(0, Math.min(nextOffset, maxChatScrollOffset));
      if (normalized === chatScrollOffset) {
        return false;
      }
      chatScrollOffset = normalized;
      return true;
    }

    async function handlePrompt(input: string): Promise<void> {
      const extractedPins = extractInlinePins(input, options.getPinOptions?.() ?? []);
      if (extractedPins.missing.length > 0 || extractedPins.ambiguous.length > 0) {
        const lines: string[] = [];
        if (extractedPins.missing.length > 0) {
          lines.push(
            `No pinnable file matched: ${extractedPins.missing
              .map((label) => `\`${label}\``)
              .join(", ")}.`
          );
        }
        for (const item of extractedPins.ambiguous) {
          lines.push(
            `Pin \`${item.query}\` is ambiguous. Matches: ${item.matches
              .slice(0, 5)
              .map((match) => `\`${match.label}\``)
              .join(", ")}.`
          );
        }
        lines.push("Use `@` to see available files, then try again.");
        await appendPersistedMessage({
          role: "system",
          content: lines.join("\n"),
        });
        return;
      }

      const pins = mergePinOptions(pendingPins, extractedPins.resolved);
      const cleanInput = extractedPins.cleanInput;
      const messageCountBeforeAsk = messages.length;
      await appendPersistedMessage({ role: "user", content: input });
      isProcessing = true;
      preProcessingInput = input;
      processingAbort = new AbortController();
      currentVerb = VERBS[Math.floor(Math.random() * VERBS.length)]!;
      spinnerFrame = 0;
      shimmerFrame = 0;
      processingStartTime = Date.now();
      currentSpinnerLine = buildSpinnerLine();
      render();
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
          messages.push({ role: "assistant", content: "" });
          markTranscriptDirty(messages.length - 1);
        }

        streamedText += pendingStreamDelta;
        pendingStreamDelta = "";
        messages[messages.length - 1] = {
          role: "assistant",
          content: streamedText,
        };
        markTranscriptDirty(messages.length - 1);
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

      const abortPromise = new Promise<never>((_, reject) => {
        processingAbort!.signal.addEventListener("abort", () => {
          reject(new DOMException("User interrupted", "AbortError"));
        });
      });

      try {
        let fullInput = cleanInput;
        if (pins.length > 0 && options.resolvePinContent) {
          const attached = (
            await Promise.all(
              pins.map(async (pin) => {
                const content = await options.resolvePinContent!(pin);
                if (!content) {
                  return null;
                }
                return `--- Begin pinned file: ${pin.name} ---\n${content}\n--- End ${pin.name} ---`;
              })
            )
          ).filter((entry): entry is string => entry !== null);

          if (attached.length > 0) {
            fullInput = `${attached.join("\n\n")}\n\nUser question: ${cleanInput}`;
          }
        }

        const signal = processingAbort!.signal;

        const final = await Promise.race([
          options.onAsk(fullInput, {
            abortSignal: signal,
            onToolCall: async (event) => {
              if (signal.aborted) return;
              flushPendingStreamDelta();
              if (streamingStarted) {
                if (streamedText.trim()) {
                  messages[messages.length - 1] = {
                    role: "assistant",
                    content: streamedText.trim(),
                  };
                  markTranscriptDirty(messages.length - 1);
                  persistence.schedule();
                } else {
                  messages.pop();
                  markTranscriptDirty(messages.length);
                }
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
                observation: event.observation,
              });
              markTranscriptDirty(messages.length - 1);
              persistence.schedule();
              currentSpinnerLine = buildSpinnerLine();
              scheduleRender();
              startSpinner();
            },
            onTextDelta: (delta) => {
              if (signal.aborted) return;
              pendingStreamDelta += delta;
              schedulePendingStreamDelta();
            },
          }),
          abortPromise,
        ]);

        flushPendingStreamDelta();
        stopSpinner();
        const elapsed = formatElapsed(Date.now() - processingStartTime);
        const pastVerb = PAST_TENSE[currentVerb] ?? currentVerb;
        if (streamingStarted) {
          messages[messages.length - 1] = {
            role: "assistant",
            content: final.content || streamedText,
            bulletPoints: final.bulletPoints,
            sources: final.sources,
            confidence: final.confidence,
            verificationNote: final.verificationNote,
          };
          markTranscriptDirty(messages.length - 1);
        } else {
          messages.push({
            role: "assistant",
            content: final.content,
            bulletPoints: final.bulletPoints,
            sources: final.sources,
            confidence: final.confidence,
            verificationNote: final.verificationNote,
          });
          markTranscriptDirty(messages.length - 1);
        }
        messages.push({
          role: "system",
          content: `${pastVerb} for ${elapsed}`,
        });
        markTranscriptDirty(messages.length - 1);
        persistence.schedule(0);
        pendingPins = [];
      } catch (error) {
        flushPendingStreamDelta();
        stopSpinner();
        streamingStarted = false;
        streamedText = "";

        if (error instanceof DOMException && error.name === "AbortError") {
          messages.splice(messageCountBeforeAsk);
          markTranscriptDirty(messageCountBeforeAsk);
          persistence.schedule(0);
          inputBuffer = preProcessingInput;
        } else {
          if (messages.length > messageCountBeforeAsk + 1) {
            const lastMsg = messages[messages.length - 1];
            if (lastMsg && lastMsg.role !== "user") {
              // keep partial tool/assistant messages as-is
            }
          }
          await appendPersistedMessage({
            role: "system",
            content: `Error: ${formatAIError(error)}`,
          });
        }
      }

      isProcessing = false;
      processingAbort = null;
      preProcessingInput = "";
      currentSpinnerLine = "";
      render();
    }

    async function runCopy(arg: string): Promise<void> {
      const lower = arg.toLowerCase();
      let payload: string | null;
      let label: string;
      if (!lower) {
        payload = formatLastAssistantForCopy(messages);
        label = "last response";
      } else if (lower === "all") {
        payload = formatConversationForCopy(messages);
        label = "full conversation";
      } else {
        const match = lower.match(/^last\s+(\d+)$/) ?? lower.match(/^(\d+)$/);
        const n = match ? parseInt(match[1]!, 10) : NaN;
        if (!Number.isFinite(n) || n <= 0) {
          await appendPersistedMessage({
            role: "system",
            content: "Usage: /copy | /copy all | /copy last N",
          });
          render();
          return;
        }
        payload = formatLastNForCopy(messages, n);
        label = `last ${n} messages`;
      }

      if (!payload) {
        await appendPersistedMessage({
          role: "system",
          content: "Nothing to copy yet.",
        });
        render();
        return;
      }

      try {
        await copyToClipboard(payload);
        await appendPersistedMessage({
          role: "system",
          content: `Copied ${label} to clipboard (${payload.length.toLocaleString()} chars).`,
        });
      } catch (error) {
        await appendPersistedMessage({
          role: "system",
          content: `Error: clipboard copy failed (${
            error instanceof Error ? error.message : "unknown"
          })`,
        });
      }
      render();
    }

    async function handleCommandInput(
      rawInput: string,
      commandName: string,
      args: string
    ): Promise<void> {
      await appendPersistedMessage({ role: "user", content: rawInput });

      if (commandName === "/help") {
        const helpLines = availableCommands.map(
          (command) =>
            `${C.text(command.name.padEnd(16))}${command.description}`
        );
        for (const extra of options.extraHelpCommands ?? []) {
          helpLines.push(`${C.text(extra.cmd.padEnd(16))}${extra.desc}`);
        }
        await appendPersistedMessage({
          role: "assistant",
          content: helpLines.join("\n"),
        });
        render();
        return;
      }

      if (commandName === "/copy") {
        await runCopy(args.trim());
        return;
      }

      if (commandName === "/clear") {
        const resetMessages = (await options.onClear?.()) ?? [];
        pendingPins = [];
        slashSelected = 0;
        openSelected = 0;
        pinSelected = 0;
        showSlashMenu = false;
        isProcessing = false;
        currentSpinnerLine = "";
        stopSpinner();
        messages.splice(0, messages.length, ...resetMessages);
        markTranscriptDirty(0);
        chatScrollOffset = 0;
        lastTranscriptTotalLines = 0;
        await persistence.flush();
        render();
        return;
      }


      const resolvedCommand = resolveCommand(options.commands, commandName);
      if (!resolvedCommand) {
        await appendPersistedMessage({
          role: "system",
          content: `Unknown command: ${commandName}. Type /help for options.`,
        });
        render();
        return;
      }

      if (!resolvedCommand.scopes.includes(options.runtime.scope.type)) {
        await appendPersistedMessage({
          role: "system",
          content: `${commandName} is only available in ${formatScopeTargets(
            resolvedCommand.scopes
          )}.`,
        });
        render();
        return;
      }

      try {
        const exit = await options.onCommand(commandName, args, api);
        if (exit !== undefined) {
          const persistError = await closeShellOnce();
          if (persistError) {
            console.error(`Failed to save chat session: ${persistError}`);
          }
          resolve(exit ?? null);
          return;
        }
        render();
      } catch (error) {
        await appendPersistedMessage({
          role: "system",
          content: `Error: ${error instanceof Error ? error.message : "unknown"}`,
        });
        render();
      }
    }

    function launchPdfGeneration(
      rawInput: string,
      instruction: string
    ): void {
      isProcessing = true;
      processingAbort = new AbortController();
      currentVerb = "Generating PDF";
      spinnerFrame = 0;
      shimmerFrame = 0;
      processingStartTime = Date.now();
      currentSpinnerLine = buildSpinnerLine();

      messages.push({ role: "user", content: rawInput });
      markTranscriptDirty(messages.length - 1);
      persistence.schedule();
      render();
      startSpinner();

      void (async () => {
        try {
          const result = await executeMakePdf({
            instruction,
            session,
            runtime: options.runtime,
            getLoadedWorkspace: options.getLoadedWorkspace,
            getCourseCache: options.getCourseCache,
            abortSignal: processingAbort!.signal,
          });

          stopSpinner();
          const elapsed = formatElapsed(Date.now() - processingStartTime);

          const lines = [`PDF saved to \`${result.pdfPath}\``];
          if (result.usedLatex) {
            lines.push("Rendered with LaTeX for high-quality math and code formatting.");
          }
          if (result.warning) {
            lines.push(result.warning);
          }

          await appendPersistedMessage({
            role: "assistant",
            content: lines.join("\n"),
          });
          await appendPersistedMessage({
            role: "system",
            content: `Generated in ${elapsed}`,
          });

          openFile(result.pdfPath, (msg) => {
            void appendPersistedMessage({ role: "system", content: msg });
          });
        } catch (error) {
          stopSpinner();
          if (error instanceof DOMException && error.name === "AbortError") {
            await appendPersistedMessage({
              role: "system",
              content: "PDF generation cancelled.",
            });
          } else {
            await appendPersistedMessage({
              role: "system",
              content: `PDF generation failed: ${error instanceof Error ? error.message : "unknown error"}`,
            });
          }
        }

        isProcessing = false;
        processingAbort = null;
        currentSpinnerLine = "";
        render();
      })();
    }

    async function handleKey(key: string): Promise<void> {
      if (shellClosed) return;

      if (key === "\x03") {
        if (inputBuffer.length > 0) {
          inputBuffer = "";
          slashSelected = 0;
          showSlashMenu = false;
          render();
          return;
        }
        await exitShellAborted(closeShellOnce, (code) => process.exit(code));
      }

      if (key === "\x0F") {
        toolOutputExpanded = !toolOutputExpanded;
        render();
        return;
      }

      if (key === "\x19") {
        await runCopy("");
        return;
      }

      if (key === "\x1b[5~" || key === "\x1B[5~" || key === "\x10") {
        if (setChatScrollOffset(chatScrollOffset + scrollPageStep())) {
          render();
        }
        return;
      }
      if (key === "\x1b[6~" || key === "\x1B[6~" || key === "\x0e") {
        if (setChatScrollOffset(chatScrollOffset - scrollPageStep())) {
          render();
        }
        return;
      }
      if (key === "\x1b[4~" || key === "\x1B[4~") {
        if (setChatScrollOffset(0)) {
          render();
        }
        return;
      }
      if (key === "\x1b[1~" || key === "\x1B[1~") {
        if (setChatScrollOffset(maxChatScrollOffset)) {
          render();
        }
        return;
      }

      if (key === "\x1B") {
        if (isProcessing && processingAbort) {
          processingAbort.abort();
          return;
        }
        if (showSlashMenu) {
          const hadOverlay = hasVisibleOverlay();
          showSlashMenu = false;
          renderAfterInputMutation(hadOverlay, getInputState());
        }
        return;
      }

      if (key === "\r" || key === "\n") {
        if (isProcessing) return;
        setChatScrollOffset(0);
        const inputState = getInputState();

        if (inputState.activeOpenPartial !== null) {
          if (inputState.openMatches.length > 0) {
            const selected = inputState.openMatches[openSelected]!;
            await handleCommandInput(
              `/open ${selected.query}`,
              "/open",
              selected.query
            );
            return;
          }
        }

        if (inputState.activePinPartial !== null) {
          const isComplete = (options.getPinOptions?.() ?? []).some(
            (pin) => pin.label === inputState.activePinPartial
          );
          if (!isComplete && inputState.pinMatches.length > 0) {
            const selected = inputState.pinMatches[pinSelected]!;
            inputBuffer = inputBuffer.replace(
              /@\S*$/,
              `@${selected.label}`
            );
            pinSelected = 0;
            renderAfterInputMutation(true, getInputState());
            return;
          }
        }

        if (inputState.slashMatches.length > 0) {
          inputBuffer = inputState.slashMatches[slashSelected]!.name;
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
          const [commandName, ...rest] = input.split(/\s+/);
          const normalizedCmd = commandName.toLowerCase();
          if (normalizedCmd === "/make-pdf" || normalizedCmd === "/pdf") {
            launchPdfGeneration(input, rest.join(" "));
          } else {
            await handleCommandInput(input, commandName, rest.join(" "));
          }
          return;
        }

        if (inlinePdfPattern.test(input)) {
          const cleaned = input
            .replace(inlinePdfPattern, "")
            .replace(/\s+/g, " ")
            .trim();
          launchPdfGeneration(input, cleaned);
          return;
        }

        await handlePrompt(input);
        render();
        return;
      }

      const inputState = getInputState();

      if (
        key === "\x1B[A" &&
        inputState.activeOpenPartial !== null &&
        inputState.openMatches.length > 0
      ) {
        openSelected = Math.max(0, openSelected - 1);
        renderInputOnly(inputState);
        return;
      }
      if (
        key === "\x1B[B" &&
        inputState.activeOpenPartial !== null &&
        inputState.openMatches.length > 0
      ) {
        openSelected = Math.min(inputState.openMatches.length - 1, openSelected + 1);
        renderInputOnly(inputState);
        return;
      }
      if (
        key === "\x1B[A" &&
        inputState.activePinPartial !== null &&
        inputState.pinMatches.length > 0
      ) {
        pinSelected = Math.max(0, pinSelected - 1);
        renderInputOnly(inputState);
        return;
      }
      if (
        key === "\x1B[B" &&
        inputState.activePinPartial !== null &&
        inputState.pinMatches.length > 0
      ) {
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
        if (setChatScrollOffset(chatScrollOffset + 3)) {
          render();
        }
        return;
      }
      if (key === "\x1B[B") {
        if (setChatScrollOffset(chatScrollOffset - 3)) {
          render();
        }
        return;
      }

      if (key === "\x7F" || key === "\b") {
        if (inputBuffer.length > 0) {
          const hadOverlay = hasVisibleOverlay();
          inputBuffer = inputBuffer.slice(0, -1);
          showSlashMenu = inputBuffer.startsWith("/");
          const nextInputState = getInputState();
          if (nextInputState.activeOpenPartial !== null) {
            openSelected = 0;
          } else if (nextInputState.activePinPartial !== null) {
            pinSelected = 0;
          } else {
            slashSelected = 0;
          }
          renderAfterInputMutation(hadOverlay, nextInputState);
        }
        return;
      }

      if (key === "\t" && inputState.activeOpenPartial !== null) {
        if (inputState.openMatches.length > 0) {
          const selected = inputState.openMatches[openSelected]!;
          inputBuffer = `/open ${selected.query}`;
          openSelected = 0;
          renderAfterInputMutation(true, getInputState());
        }
        return;
      }

      if (key === "\t" && inputState.activePinPartial !== null) {
        if (inputState.pinMatches.length > 0) {
          const selected = inputState.pinMatches[pinSelected]!;
          inputBuffer = inputBuffer.replace(
            /@\S*$/,
            `@${selected.label}`
          );
          pinSelected = 0;
          renderAfterInputMutation(true, getInputState());
        }
        return;
      }

      if (key === "\t" && inputState.slashMatches.length > 0) {
        inputBuffer = inputState.slashMatches[slashSelected]!.name + " ";
        slashSelected = 0;
        const hadOverlay = inputState.hasVisibleOverlay;
        showSlashMenu = false;
        renderAfterInputMutation(hadOverlay, getInputState());
        return;
      }

      if (key.length === 1 && key >= " ") {
        handleTextInputChunk(key);
      }
    }

    function handleTextInputChunk(text: string): void {
      if (shellClosed || !text) return;

      const hadOverlay = hasVisibleOverlay();
      inputBuffer += text;
      showSlashMenu = inputBuffer.startsWith("/");

      const nextInputState = getInputState();
      if (nextInputState.activeOpenPartial !== null) {
        openSelected = 0;
      } else if (nextInputState.activePinPartial !== null) {
        pinSelected = 0;
      } else if (showSlashMenu) {
        slashSelected = 0;
      }

      renderAfterInputMutation(hadOverlay, nextInputState);
    }

    function flushEscHold(): void {
      if (stdinEscTimer) {
        clearTimeout(stdinEscTimer);
        stdinEscTimer = null;
      }
      if (!stdinEscHold) return;
      const held = stdinEscHold;
      stdinEscHold = "";
      if (held === "\x1B") {
        if (isProcessing && processingAbort) {
          processingAbort.abort();
          return;
        }
        keyQueue.enqueue(() => handleKey(held));
      }
    }

    function scheduleEscHoldFlush(): void {
      if (stdinEscTimer) clearTimeout(stdinEscTimer);
      stdinEscTimer = setTimeout(flushEscHold, 50);
    }

    function enqueueInputChunk(chunk: string): void {
      if (!chunk) return;

      let textBuffer = "";
      const flushTextBuffer = (): void => {
        if (!textBuffer) return;
        const next = textBuffer;
        textBuffer = "";
        if (isProcessing) {
          handleTextInputChunk(next);
        } else {
          keyQueue.enqueue(() => handleTextInputChunk(next));
        }
      };

      for (const char of Array.from(chunk)) {
        if (!/[\x00-\x1f\x7f]/.test(char)) {
          textBuffer += char;
          continue;
        }
        flushTextBuffer();
        if (isProcessing) {
          void handleKey(char);
        } else {
          keyQueue.enqueue(() => handleKey(char));
        }
      }

      flushTextBuffer();
    }

    function onData(data: string): void {
      if (shellClosed) return;
      if (stdinEscTimer) { clearTimeout(stdinEscTimer); stdinEscTimer = null; }
      let input = stdinEscHold + data;
      stdinEscHold = "";

      while (input.length > 0) {
        const escIdx = input.indexOf("\x1b");
        if (escIdx < 0) {
          enqueueInputChunk(input);
          return;
        }

        enqueueInputChunk(input.slice(0, escIdx));
        input = input.slice(escIdx);

        if (input.length === 1) {
          stdinEscHold = input;
          scheduleEscHoldFlush();
          return;
        }

        if (input[1] === "[") {
          const mouseMatch = input.match(/^\x1b\[<(\d+);\d+;\d+[Mm]/);
          if (mouseMatch) {
            const button = parseInt(mouseMatch[1]!, 10);
            const handleMouse = async () => {
              if (shellClosed) return;
              let didScroll = false;
              if (button === 64) {
                didScroll = setChatScrollOffset(chatScrollOffset + 3);
              } else if (button === 65) {
                didScroll = setChatScrollOffset(chatScrollOffset - 3);
              }
              if (didScroll) {
                render();
              }
            };
            if (isProcessing) {
              void handleMouse();
            } else {
              keyQueue.enqueue(handleMouse);
            }
            input = input.slice(mouseMatch[0].length);
            continue;
          }

          const match = input.match(/^\x1b\[[\d;]*[~A-Za-z]/);
          if (match) {
            const key = match[0];
            if (isProcessing) {
              void handleKey(key);
            } else {
              keyQueue.enqueue(() => handleKey(key));
            }
            input = input.slice(match[0].length);
            continue;
          }
          stdinEscHold = input;
          scheduleEscHoldFlush();
          return;
        }

        if (input[1] === "O" && input.length >= 3) {
          const key = input.slice(0, 3);
          if (isProcessing) {
            void handleKey(key);
          } else {
            keyQueue.enqueue(() => handleKey(key));
          }
          input = input.slice(3);
          continue;
        }

        const key = input.slice(0, 2);
        if (isProcessing) {
          void handleKey(key);
        } else {
          keyQueue.enqueue(() => handleKey(key));
        }
        input = input.slice(2);
      }
    }

    stdin.on("data", onData);

    if (options.onReady) {
      queueMicrotask(() => {
        if (shellClosed) return;
        void Promise.resolve(options.onReady!(api))
          .then(() => {
            if (!shellClosed) {
              render();
            }
          })
          .catch(async (error: unknown) => {
            if (shellClosed) return;
            await appendPersistedMessage({
              role: "system",
              content: `Error: ${error instanceof Error ? error.message : "unknown"}`,
            });
            if (!shellClosed) {
              render();
            }
          });
      });
    }
  });
}

function openFile(filePath: string, onError?: (msg: string) => void): void {
  const { command, args } = getOpenCommand(filePath);
  const child = spawn(command, args, {
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  child.on("error", (err) => {
    onError?.(`Could not open file: ${err.message}`);
  });
  child.unref();
}
