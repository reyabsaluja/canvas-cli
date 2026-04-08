import chalk from "chalk";
import { C, getTermSize } from "./screen.js";
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
  resolvePinReferences,
} from "./pins.js";
import { searchOpenableResources } from "./open-resources.js";
import {
  MAIN_VIEW_BOTTOM_RESERVE,
  buildBannerLines,
  buildTranscriptLines,
  renderChatFrame,
  renderInputFooter,
} from "./chat-shell-render.js";
import { ChatShellPersistence } from "./chat-shell-persistence.js";
import { enterChatShell, leaveChatShell } from "./chat-shell-terminal.js";
import { createSerialTaskQueue } from "./serial-task-queue.js";
import { exitShellAborted } from "./chat-shell-exit.js";

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
  }) => void;
  onTextDelta?: (delta: string) => void;
}

export interface ChatShellOptions<TExit> {
  session: ChatSession;
  runtime: ScopeRuntime;
  commands: CommandDefinition[];
  modelLabel: string;
  bannerRenderer?: (buf: { push(line?: string): void }) => void;
  extraHelpCommands?: Array<{ cmd: string; desc: string }>;
  pinOptions?: ShellPinOption[];
  getOpenOptions?: () => ShellOpenOption[];
  resolvePinContent?: (pin: ShellPinOption) => Promise<string | null>;
  onAsk: (input: string, callbacks: AskCallbacks) => Promise<{
    content: string;
    bulletPoints?: string[];
    sources?: Array<{ title: string; kind: string }>;
    confidence?: string;
  }>;
  onCommand: (
    command: string,
    args: string,
    api: ChatShellApi<TExit>
  ) => Promise<TExit | null | void>;
  onReady?: (api: ShellRuntimeApi) => Promise<void> | void;
}

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
  let currentVerb = "";
  let transcriptLinesCache: string[] | null = null;
  let transcriptCacheKey = "";
  let bannerLinesCache: string[] | null = null;
  let bannerCacheCols = -1;

  const placeholder =
    options.runtime.placeholder ?? "Type your message or /help for commands";

  function markTranscriptDirty(): void {
    transcriptLinesCache = null;
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

  function getCachedTranscriptLines(): string[] {
    const { cols } = getTermSize();
    const contentWidth = Math.min(cols - 4, 100);
    const cacheKey = `${cols}:${contentWidth}:${toolOutputExpanded ? 1 : 0}`;
    if (transcriptLinesCache && transcriptCacheKey === cacheKey) {
      return transcriptLinesCache;
    }
    transcriptLinesCache = buildTranscriptLines({
      messages,
      contentWidth,
      cols,
      expanded: toolOutputExpanded,
    });
    transcriptCacheKey = cacheKey;
    return transcriptLinesCache;
  }

  function getSlashMatches(): CommandDefinition[] {
    if (!inputBuffer.startsWith("/")) return [];
    if (getActiveOpenPartial() !== null && getOpenMatches().length > 0) {
      return [];
    }
    const partial = inputBuffer.toLowerCase();
    return availableCommands.filter((command) =>
      [command.name, ...(command.aliases ?? [])].some((alias) =>
        alias.startsWith(partial)
      )
    );
  }

  function getOpenOptions(): ShellOpenOption[] {
    return options.getOpenOptions?.() ?? [];
  }

  function getActiveOpenPartial(): string | null {
    if (options.runtime.scope.type === "global") return null;
    const match = inputBuffer.match(/\/open(?:\s+(.*))?$/i);
    if (!match) return null;
    return (match[1] ?? "").trim();
  }

  function getOpenMatches(): ShellOpenOption[] {
    const partial = getActiveOpenPartial();
    if (partial === null) return [];
    const openOptions = getOpenOptions();
    if (!partial) return openOptions;
    const ranked = searchOpenableResources(
      partial,
      openOptions.map((option, index) => ({
        id: String(index),
        title: option.title,
        kind: option.detail ?? "resource",
        targetType: "file" as const,
        target: option.query,
        detail: option.detail,
        searchTerms:
          option.searchTerms ?? [option.title, option.query, option.detail ?? ""],
      })),
      openOptions.length
    );
    return ranked
      .map((resource) =>
        openOptions.find(
          (option) =>
            option.title === resource.title && option.query === resource.target
        )
      )
      .filter((option): option is ShellOpenOption => option !== undefined);
  }

  function getActivePinPartial(): string | null {
    const match = inputBuffer.match(/\/pin(\s+(\S*))?$/);
    if (!match) return null;
    return match[2] ?? "";
  }

  function getPinMatches(): ShellPinOption[] {
    const partial = getActivePinPartial();
    if (partial === null) return [];
    if (!partial) return options.pinOptions ?? [];
    return (options.pinOptions ?? []).filter((pin) =>
      pin.label.includes(partial.toLowerCase())
    );
  }

  function render(): void {
    const next = renderChatFrame({
      runtime: options.runtime,
      placeholder,
      inputBuffer,
      chatScrollOffset,
      isProcessing,
      currentSpinnerLine,
      toolOutputExpanded,
      modelLabel: options.modelLabel,
      bannerLines: getCachedBannerLines(),
      transcriptLines: getCachedTranscriptLines(),
      slashMatches: showSlashMenu ? getSlashMatches() : [],
      openMatches: getOpenMatches(),
      pinMatches: getPinMatches(),
      slashSelected,
      openSelected,
      pinSelected,
    });
    chatScrollOffset = next.chatScrollOffset;
    maxChatScrollOffset = next.maxScroll;
  }

  function renderInputOnly(): void {
    renderInputFooter({
      placeholder,
      inputBuffer,
      scopeLabel: options.runtime.scopeLabel,
      statusLabel: options.runtime.statusLabel,
      modelLabel: options.modelLabel,
      currentSpinnerLine,
      slashMatches: showSlashMenu ? getSlashMatches() : [],
      openMatches: getOpenMatches(),
      pinMatches: getPinMatches(),
      slashSelected,
      openSelected,
      pinSelected,
    });
  }

  function startSpinner(): void {
    stopSpinner();
    spinnerTimer = setInterval(() => {
      if (!isProcessing || !currentSpinnerLine) return;
      spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
      currentSpinnerLine = `${C.dim(SPINNER[spinnerFrame])} ${C.text(
        currentVerb
      )}${C.dim("...")}`;
      renderInputOnly();
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
        markTranscriptDirty();
        await persistence.addMessage(message);
      },
      addMessages: async (nextMessages) => {
        markTranscriptDirty();
        await persistence.addMessages(nextMessages);
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

    function keyOkWhileProcessing(key: string): boolean {
      return [
        "\x03",
        "\x0F",
        "\x10",
        "\x0e",
        "\x1B[A",
        "\x1B[B",
        "\x1b[5~",
        "\x1B[5~",
        "\x1b[6~",
        "\x1B[6~",
        "\x1b[4~",
        "\x1B[4~",
        "\x1b[1~",
        "\x1B[1~",
      ].includes(key);
    }

    async function handlePrompt(input: string): Promise<void> {
      const extractedPins = extractInlinePins(input, options.pinOptions ?? []);
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
        lines.push("Use `/pin` to list available files, then try again.");
        markTranscriptDirty();
        await persistence.addMessage({
          role: "system",
          content: lines.join("\n"),
        });
        return;
      }

      const pins = mergePinOptions(pendingPins, extractedPins.resolved);
      const cleanInput = extractedPins.cleanInput;
      let fullInput = cleanInput;

      if (pins.length > 0 && options.resolvePinContent) {
        const attached: string[] = [];
        for (const pin of pins) {
          const content = await options.resolvePinContent(pin);
          if (content) {
            attached.push(
              `--- Begin pinned file: ${pin.name} ---\n${content}\n--- End ${pin.name} ---`
            );
          }
        }
        if (attached.length > 0) {
          fullInput = `${attached.join("\n\n")}\n\nUser question: ${cleanInput}`;
        }
      }
      markTranscriptDirty();
      await persistence.addMessage({ role: "user", content: input });
      isProcessing = true;
      currentVerb = VERBS[Math.floor(Math.random() * VERBS.length)]!;
      spinnerFrame = 0;
      currentSpinnerLine = `${C.dim(SPINNER[0])} ${C.text(
        currentVerb
      )}${C.dim("...")}`;
      render();
      startSpinner();

      let streamingStarted = false;
      let streamedText = "";
      let lastRenderTime = 0;
      const renderInterval = 80;

      try {
        const final = await options.onAsk(fullInput, {
          onToolCall: async (event) => {
            if (streamingStarted && streamedText.trim()) {
              messages[messages.length - 1] = {
                role: "assistant",
                content: streamedText.trim(),
              };
              markTranscriptDirty();
              persistence.schedule();
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
            markTranscriptDirty();
            persistence.schedule();
            currentSpinnerLine = `${C.dim(
              SPINNER[spinnerFrame]
            )} ${C.text(currentVerb)}${C.dim("...")}`;
            render();
            startSpinner();
          },
          onTextDelta: (delta) => {
            if (!streamingStarted) {
              streamingStarted = true;
              stopSpinner();
              currentSpinnerLine = "";
              messages.push({ role: "assistant", content: "" });
              markTranscriptDirty();
            }
            streamedText += delta;
            const now = Date.now();
            if (now - lastRenderTime > renderInterval) {
              lastRenderTime = now;
              messages[messages.length - 1] = {
                role: "assistant",
                content: streamedText,
              };
              markTranscriptDirty();
              render();
            }
          },
        });

        stopSpinner();
        if (streamingStarted) {
          messages[messages.length - 1] = {
            role: "assistant",
            content: final.content || streamedText,
            bulletPoints: final.bulletPoints,
            sources: final.sources,
            confidence: final.confidence,
          };
          markTranscriptDirty();
        } else {
          messages.push({
            role: "assistant",
            content: final.content,
            bulletPoints: final.bulletPoints,
            sources: final.sources,
            confidence: final.confidence,
          });
          markTranscriptDirty();
        }
        await persistence.flush();
        pendingPins = [];
      } catch (error) {
        stopSpinner();
        markTranscriptDirty();
        await persistence.addMessage({
          role: "system",
          content: `Error: ${error instanceof Error ? error.message : "unknown"}`,
        });
      }

      isProcessing = false;
      currentSpinnerLine = "";
      render();
    }

    async function handleCommandInput(
      rawInput: string,
      commandName: string,
      args: string
    ): Promise<void> {
      markTranscriptDirty();
      await persistence.addMessage({ role: "user", content: rawInput });

      if (commandName === "/help") {
        const helpLines = availableCommands.map(
          (command) =>
            `${C.text(command.name.padEnd(16))}${command.description}`
        );
        for (const extra of options.extraHelpCommands ?? []) {
          helpLines.push(`${C.text(extra.cmd.padEnd(16))}${extra.desc}`);
        }
        markTranscriptDirty();
        await persistence.addMessage({
          role: "assistant",
          content: helpLines.join("\n"),
        });
        render();
        return;
      }

      if (commandName === "/pin") {
        const pinCommand = resolveCommand(options.commands, commandName);
        if (
          !pinCommand ||
          !pinCommand.scopes.includes(options.runtime.scope.type)
        ) {
          markTranscriptDirty();
          await persistence.addMessage({
            role: "system",
            content: `${commandName} is only available in ${formatScopeTargets(
              pinCommand?.scopes ?? ["workspace"]
            )}.`,
          });
          render();
          return;
        }

        const availablePins = options.pinOptions ?? [];
        const pinArgs = args.split(/\s+/).filter(Boolean);
        const requested = pinArgs[0]?.toLowerCase() ?? "";

        if (availablePins.length === 0) {
          markTranscriptDirty();
          await persistence.addMessage({
            role: "system",
            content: "No pinnable files are available in this workspace yet.",
          });
          render();
          return;
        }

        if (pinArgs.length === 0 || requested === "list") {
          const lines = [
            "Available pins",
            "",
            ...availablePins.map(
              (pin) => `• \`${pin.label}\` — ${pin.name}`
            ),
          ];
          if (pendingPins.length > 0) {
            lines.push(
              "",
              `Queued for your next prompt: ${pendingPins
                .map((pin) => `\`${pin.label}\``)
                .join(", ")}`
            );
          }
          lines.push(
            "",
            "Use `/pin <label>` to queue a file for your next prompt.",
            "Use `/pin clear` to remove queued pins."
          );
          markTranscriptDirty();
          await persistence.addMessage({
            role: "assistant",
            content: lines.join("\n"),
          });
          render();
          return;
        }

        if (requested === "clear" || requested === "reset") {
          pendingPins = [];
          markTranscriptDirty();
          await persistence.addMessage({
            role: "assistant",
            content: "Cleared queued pins for the next prompt.",
          });
          render();
          return;
        }

        const resolution = resolvePinReferences(pinArgs, availablePins);
        pendingPins = mergePinOptions(pendingPins, resolution.resolved);

        const lines: string[] = [];
        if (resolution.resolved.length > 0) {
          lines.push(
            `Queued for your next prompt: ${resolution.resolved
              .map((pin) => `\`${pin.label}\``)
              .join(", ")}.`
          );
        }
        if (resolution.missing.length > 0) {
          lines.push(
            `No pinnable file matched: ${resolution.missing
              .map((label) => `\`${label}\``)
              .join(", ")}.`
          );
        }
        for (const item of resolution.ambiguous) {
          lines.push(
            `Pin \`${item.query}\` is ambiguous. Matches: ${item.matches
              .slice(0, 5)
              .map((match) => `\`${match.label}\``)
              .join(", ")}.`
          );
        }

        if (pendingPins.length > 0) {
          lines.push(
            `Queued pins now: ${pendingPins
              .map((pin) => `\`${pin.label}\``)
              .join(", ")}.`
          );
          lines.push("Send your question when you're ready.");
        } else if (lines.length === 0) {
          lines.push("Nothing was queued. Use `/pin` to see available files.");
        }

        markTranscriptDirty();
        await persistence.addMessage({
          role: resolution.resolved.length > 0 ? "assistant" : "system",
          content: lines.join("\n"),
        });
        render();
        return;
      }

      const resolvedCommand = resolveCommand(options.commands, commandName);
      if (!resolvedCommand) {
        markTranscriptDirty();
        await persistence.addMessage({
          role: "system",
          content: `Unknown command: ${commandName}. Type /help for options.`,
        });
        render();
        return;
      }

      if (!resolvedCommand.scopes.includes(options.runtime.scope.type)) {
        markTranscriptDirty();
        await persistence.addMessage({
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
        markTranscriptDirty();
        await persistence.addMessage({
          role: "system",
          content: `Error: ${error instanceof Error ? error.message : "unknown"}`,
        });
        render();
      }
    }

    async function handleKey(key: string): Promise<void> {
      if (shellClosed) return;
      if (isProcessing && !keyOkWhileProcessing(key)) return;

      if (key === "\x03") {
        await exitShellAborted(closeShellOnce, (code) => process.exit(code));
      }

      if (key === "\x0F") {
        toolOutputExpanded = !toolOutputExpanded;
        markTranscriptDirty();
        render();
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
        if (showSlashMenu) {
          showSlashMenu = false;
          renderInputOnly();
        }
        return;
      }

      if (key === "\r" || key === "\n") {
        setChatScrollOffset(0);

        const openPartial = getActiveOpenPartial();
        if (openPartial !== null) {
          const openMatches = getOpenMatches();
          if (openMatches.length > 0) {
            const selected = openMatches[openSelected]!;
            await handleCommandInput(
              `/open ${selected.query}`,
              "/open",
              selected.query
            );
            return;
          }
        }

        const pinPartial = getActivePinPartial();
        if (pinPartial !== null) {
          const pinMatches = getPinMatches();
          const isComplete = (options.pinOptions ?? []).some(
            (pin) => pin.label === pinPartial
          );
          if (!isComplete && pinMatches.length > 0) {
            const selected = pinMatches[pinSelected]!;
            inputBuffer = inputBuffer.replace(
              /\/pin(\s+\S*)?$/,
              `/pin ${selected.label}`
            );
            pinSelected = 0;
            renderInputOnly();
            return;
          }
        }

        if (showSlashMenu && getSlashMatches().length > 0) {
          inputBuffer = getSlashMatches()[slashSelected]!.name;
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
          await handleCommandInput(input, commandName, rest.join(" "));
          return;
        }

        await handlePrompt(input);
        render();
        return;
      }

      if (
        key === "\x1B[A" &&
        getActiveOpenPartial() !== null &&
        getOpenMatches().length > 0
      ) {
        openSelected = Math.max(0, openSelected - 1);
        renderInputOnly();
        return;
      }
      if (
        key === "\x1B[B" &&
        getActiveOpenPartial() !== null &&
        getOpenMatches().length > 0
      ) {
        openSelected = Math.min(getOpenMatches().length - 1, openSelected + 1);
        renderInputOnly();
        return;
      }
      if (
        key === "\x1B[A" &&
        getActivePinPartial() !== null &&
        getPinMatches().length > 0
      ) {
        pinSelected = Math.max(0, pinSelected - 1);
        renderInputOnly();
        return;
      }
      if (
        key === "\x1B[B" &&
        getActivePinPartial() !== null &&
        getPinMatches().length > 0
      ) {
        pinSelected = Math.min(getPinMatches().length - 1, pinSelected + 1);
        renderInputOnly();
        return;
      }
      if (key === "\x1B[A" && showSlashMenu) {
        slashSelected = Math.max(0, slashSelected - 1);
        renderInputOnly();
        return;
      }
      if (key === "\x1B[B" && showSlashMenu) {
        slashSelected = Math.min(getSlashMatches().length - 1, slashSelected + 1);
        renderInputOnly();
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
          inputBuffer = inputBuffer.slice(0, -1);
          showSlashMenu = inputBuffer.startsWith("/");
          if (getActiveOpenPartial() !== null) {
            openSelected = 0;
          } else if (getActivePinPartial() !== null) {
            pinSelected = 0;
          } else {
            slashSelected = 0;
          }
          renderInputOnly();
        }
        return;
      }

      if (key === "\t" && getActiveOpenPartial() !== null) {
        const openMatches = getOpenMatches();
        if (openMatches.length > 0) {
          const selected = openMatches[openSelected]!;
          inputBuffer = `/open ${selected.query}`;
          openSelected = 0;
          renderInputOnly();
        }
        return;
      }

      if (key === "\t" && getActivePinPartial() !== null) {
        const pinMatches = getPinMatches();
        if (pinMatches.length > 0) {
          const selected = pinMatches[pinSelected]!;
          inputBuffer = inputBuffer.replace(
            /\/pin(\s+\S*)?$/,
            `/pin ${selected.label}`
          );
          pinSelected = 0;
          renderInputOnly();
        }
        return;
      }

      if (key === "\t" && showSlashMenu) {
        const matches = getSlashMatches();
        if (matches.length > 0) {
          inputBuffer = matches[slashSelected]!.name + " ";
          slashSelected = 0;
          showSlashMenu = false;
          renderInputOnly();
        }
        return;
      }

      if (key.length === 1 && key >= " ") {
        inputBuffer += key;
        showSlashMenu = inputBuffer.startsWith("/");
        if (getActiveOpenPartial() !== null) {
          openSelected = 0;
        } else if (getActivePinPartial() !== null) {
          pinSelected = 0;
        } else if (showSlashMenu) {
          slashSelected = 0;
        }
        renderInputOnly();
      }
    }

    let stdinEscHold = "";
    function onData(data: string): void {
      if (shellClosed) return;
      let input = stdinEscHold + data;
      stdinEscHold = "";

      while (input.length > 0) {
        const escIdx = input.indexOf("\x1b");
        if (escIdx < 0) {
          for (let index = 0; index < input.length; index++) {
            const key = input[index]!;
            keyQueue.enqueue(() => handleKey(key));
          }
          return;
        }

        for (let index = 0; index < escIdx; index++) {
          const key = input[index]!;
          keyQueue.enqueue(() => handleKey(key));
        }
        input = input.slice(escIdx);

        if (input.length === 1) {
          stdinEscHold = input;
          return;
        }

        if (input[1] === "[") {
          const mouseMatch = input.match(/^\x1b\[<(\d+);\d+;\d+[Mm]/);
          if (mouseMatch) {
            const button = parseInt(mouseMatch[1]!, 10);
            keyQueue.enqueue(async () => {
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
            });
            input = input.slice(mouseMatch[0].length);
            continue;
          }

          const match = input.match(/^\x1b\[[\d;]*[~A-Za-z]/);
          if (match) {
            const key = match[0];
            keyQueue.enqueue(() => handleKey(key));
            input = input.slice(match[0].length);
            continue;
          }
          stdinEscHold = input;
          return;
        }

        if (input[1] === "O" && input.length >= 3) {
          const key = input.slice(0, 3);
          keyQueue.enqueue(() => handleKey(key));
          input = input.slice(3);
          continue;
        }

        const key = input.slice(0, 2);
        keyQueue.enqueue(() => handleKey(key));
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
            markTranscriptDirty();
            await persistence.addMessage({
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
