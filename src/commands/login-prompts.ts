import * as readline from "node:readline";

const ESCAPED = Symbol("escaped");
export { ESCAPED };

/**
 * Length of the terminal escape sequence starting at `index` (which must be
 * an ESC byte), as the index just past it; or `index` itself when the ESC is
 * bare. Arrow keys ("\x1b[A", "\x1bOA") and bracketed-paste markers
 * ("\x1b[200~") arrive in the same chunk as the ESC, so they must not be
 * mistaken for the user pressing Esc.
 */
export function skipEscapeSequence(str: string, index: number): number {
  const next = str[index + 1];
  if (next === "[") {
    // CSI: ESC [ <params 0x30-0x3f> <intermediates 0x20-0x2f> <final 0x40-0x7e>
    let i = index + 2;
    while (i < str.length && str.charCodeAt(i) >= 0x20 && str.charCodeAt(i) <= 0x3f) i += 1;
    if (i < str.length && str.charCodeAt(i) >= 0x40 && str.charCodeAt(i) <= 0x7e) return i + 1;
    return i < str.length ? i : str.length;
  }
  if (next === "O" && index + 2 < str.length) {
    // SS3: application-mode cursor keys ("\x1bOA") and keypad keys.
    return index + 3;
  }
  return index;
}

export function promptLine(question: string): Promise<string | typeof ESCAPED> {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      let settled = false;
      rl.question(question, (answer) => { settled = true; rl.close(); resolve(answer.trim()); });
      rl.on("close", () => { if (!settled) resolve(ESCAPED); });
    });
  }

  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    let input = "";

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
    };

    const onData = (buf: Buffer) => {
      try {
        const str = buf.toString();
        let i = 0;
        while (i < str.length) {
          const c = str[i]!;
          const code = c.charCodeAt(0);
          if (c === "\r" || c === "\n") {
            cleanup();
            process.stdout.write("\n");
            resolve(input.trim());
            return;
          }
          if (code === 3) {
            cleanup();
            process.stdout.write("\n");
            process.exit(130);
            return;
          }
          if (code === 27) {
            const next = skipEscapeSequence(str, i);
            if (next > i) {
              i = next;
              continue;
            }
            cleanup();
            process.stdout.write("\n");
            resolve(ESCAPED);
            return;
          }
          if (code === 127 || code === 8) {
            if (input.length > 0) {
              input = input.slice(0, -1);
              process.stdout.write("\b \b");
            }
          } else if (code >= 32) {
            input += c;
            process.stdout.write(c);
          }
          i += 1;
        }
      } catch {
        cleanup();
        process.stdout.write("\n");
        resolve(ESCAPED);
      }
    };

    process.stdin.on("data", onData);
  });
}

export function promptSecret(question: string): Promise<string | typeof ESCAPED> {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    return new Promise((resolve) => {
      let settled = false;
      rl.on("line", (line) => { settled = true; rl.close(); resolve(line.trim()); });
      rl.on("close", () => { if (!settled) resolve(ESCAPED); });
    });
  }

  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    let input = "";

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
    };

    const onData = (buf: Buffer) => {
      try {
        const str = buf.toString();
        let i = 0;
        while (i < str.length) {
          const c = str[i]!;
          const code = c.charCodeAt(0);
          if (c === "\r" || c === "\n") {
            cleanup();
            process.stdout.write("\n");
            resolve(input.trim());
            return;
          }
          if (code === 3) {
            cleanup();
            process.stdout.write("\n");
            process.exit(130);
            return;
          }
          if (code === 27) {
            const next = skipEscapeSequence(str, i);
            if (next > i) {
              i = next;
              continue;
            }
            cleanup();
            process.stdout.write("\n");
            resolve(ESCAPED);
            return;
          }
          if (code === 127 || code === 8) {
            if (input.length > 0) {
              input = input.slice(0, -1);
              process.stdout.write("\b \b");
            }
          } else if (code >= 32) {
            input += c;
            process.stdout.write("•");
          }
          i += 1;
        }
      } catch {
        cleanup();
        process.stdout.write("\n");
        resolve(ESCAPED);
      }
    };

    process.stdin.on("data", onData);
  });
}
