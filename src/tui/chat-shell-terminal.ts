import {
  clearScreen,
  disableMouseTracking,
  enableMouseTracking,
  enterAlternateScreen,
  hideCursor,
  leaveAlternateScreen,
  showCursor,
} from "./screen.js";

export function enterChatShell(render: () => void): NodeJS.ReadStream {
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
    stdin.removeListener("data", onData);
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

  return persistError ?? failureMessage();
}
