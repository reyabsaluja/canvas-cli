import {
  clearScreen,
  disableMouseTracking,
  enableMouseTracking,
  enterAlternateScreen,
  hideCursor,
  leaveAlternateScreen,
  showCursor,
} from "./screen.js";

export interface TerminalSessionOptions {
  alternateScreen?: boolean;
  mouseTracking?: boolean;
  onResize?: () => void;
  clearOnEnter?: boolean;
  clearOnExit?: boolean;
  hideCursor?: boolean;
}

export function createKeyParser(onKey: (key: string) => void): (data: string) => void {
  let escHold = "";

  return (data: string): void => {
    let input = escHold + data;
    escHold = "";

    while (input.length > 0) {
      const escIdx = input.indexOf("\x1b");
      if (escIdx < 0) {
        for (const ch of input) {
          onKey(ch);
        }
        return;
      }

      for (const ch of input.slice(0, escIdx)) {
        onKey(ch);
      }

      input = input.slice(escIdx);
      if (input.length === 1) {
        escHold = input;
        return;
      }

      if (input[1] === "[") {
        const mouseMatch = input.match(/^\x1b\[<\d+;\d+;\d+[Mm]/);
        if (mouseMatch) {
          onKey(mouseMatch[0]);
          input = input.slice(mouseMatch[0].length);
          continue;
        }

        const csiMatch = input.match(/^\x1b\[[\d;]*[~A-Za-z]/);
        if (csiMatch) {
          onKey(csiMatch[0]);
          input = input.slice(csiMatch[0].length);
          continue;
        }

        if (input.length > 48) {
          onKey("\x1b");
          input = input.slice(1);
          continue;
        }

        escHold = input;
        return;
      }

      if (input[1] === "O") {
        if (input.length < 3) {
          escHold = input;
          return;
        }
        onKey(input.slice(0, 3));
        input = input.slice(3);
        continue;
      }

      onKey(input.slice(0, 2));
      input = input.slice(2);
    }
  };
}

export function startTerminalSession(
  onKey: (key: string) => void,
  options: TerminalSessionOptions = {}
): () => void {
  const {
    alternateScreen = false,
    mouseTracking = false,
    onResize,
    clearOnEnter = true,
    clearOnExit = true,
    hideCursor: shouldHideCursor = true,
  } = options;

  const stdin = process.stdin;
  const handleData = createKeyParser(onKey);
  const handleResize = (): void => {
    onResize?.();
  };

  if (alternateScreen) enterAlternateScreen();
  if (mouseTracking) enableMouseTracking();
  if (clearOnEnter) clearScreen();
  if (shouldHideCursor) hideCursor();

  if (typeof stdin.setRawMode === "function") {
    stdin.setRawMode(true);
  }
  stdin.resume();
  stdin.setEncoding("utf8");
  stdin.on("data", handleData);

  if (onResize) {
    process.stdout.on("resize", handleResize);
  }

  return (): void => {
    stdin.removeListener("data", handleData);
    if (typeof stdin.setRawMode === "function") {
      stdin.setRawMode(false);
    }
    stdin.pause();

    if (onResize) {
      process.stdout.removeListener("resize", handleResize);
    }

    if (mouseTracking) disableMouseTracking();
    if (alternateScreen) leaveAlternateScreen();
    showCursor();
    if (clearOnExit) clearScreen();
  };
}
