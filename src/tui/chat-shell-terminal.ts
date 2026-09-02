import {
  clearScreen,
  disableMouseTracking,
  enableMouseTracking,
  enterAlternateScreen,
  hideCursor,
  leaveAlternateScreen,
  showCursor,
} from "./screen.js";
import { resetChatShellRenderCache } from "./chat-shell-render.js";

export function enterChatShell(render: () => void): NodeJS.ReadStream {
  resetChatShellRenderCache();
  enterAlternateScreen();
  enableMouseTracking();
  clearScreen();
  hideCursor();
  render();

  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return stdin;
}

/**
 * Best-effort synchronous restore of the host terminal: raw mode off, mouse
 * tracking off, back to the main screen buffer, cursor visible. Every step is
 * guarded so a broken stream never prevents the remaining steps from running.
 */
export function restoreTerminal(stdin: NodeJS.ReadStream): void {
  try {
    if (stdin.isTTY) stdin.setRawMode(false);
  } catch {}
  try {
    stdin.pause();
  } catch {}
  try {
    disableMouseTracking();
  } catch {}
  try {
    leaveAlternateScreen();
  } catch {}
  try {
    showCursor();
  } catch {}
  try {
    clearScreen();
  } catch {}
}

const SIGNAL_EXIT_CODES: Record<string, number> = {
  SIGTERM: 143,
  SIGHUP: 129,
};

/**
 * Registers process-level handlers so that a signal or an unexpected error
 * while the chat shell owns the terminal still leaves the terminal usable.
 * Returns a function that removes the handlers again; call it when leaving
 * the shell so re-entering does not stack listeners.
 */
export function installShellCrashHandlers(
  stdin: NodeJS.ReadStream,
  flushPersist: () => Promise<void>,
  exitProcess: (code: number) => void = (code) => process.exit(code),
  logError: (message: string) => void = console.error
): () => void {
  let fired = false;

  const bail = (code: number, message: string | null): void => {
    if (fired) return;
    fired = true;
    remove();
    restoreTerminal(stdin);
    if (message) logError(message);
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1000).unref());
    void Promise.race([flushPersist().catch(() => undefined), timeout]).finally(() =>
      exitProcess(code)
    );
  };

  const onSigterm = (): void => bail(SIGNAL_EXIT_CODES.SIGTERM!, null);
  const onSighup = (): void => bail(SIGNAL_EXIT_CODES.SIGHUP!, null);
  const onUncaught = (error: unknown): void =>
    bail(1, `Unexpected error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  const onUnhandled = (reason: unknown): void =>
    bail(1, `Unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);

  process.once("SIGTERM", onSigterm);
  process.once("SIGHUP", onSighup);
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);

  function remove(): void {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGHUP", onSighup);
    process.removeListener("uncaughtException", onUncaught);
    process.removeListener("unhandledRejection", onUnhandled);
  }

  return remove;
}

export async function leaveChatShell(
  stdin: NodeJS.ReadStream,
  onData: (data: string) => void,
  flushPersist: () => Promise<void>,
  stopSpinner: () => void,
  failureMessage: () => string | null
): Promise<string | null> {
  let persistError: string | null = null;

  try {
    stopSpinner();
    await flushPersist();
  } catch (error) {
    persistError =
      error instanceof Error ? error.message : "unknown persistence error";
  } finally {
    resetChatShellRenderCache();
    stdin.removeListener("data", onData);
    restoreTerminal(stdin);
  }

  return persistError ?? failureMessage();
}
