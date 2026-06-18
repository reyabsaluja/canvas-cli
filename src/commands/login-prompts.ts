import * as readline from "node:readline";

const ESCAPED = Symbol("escaped");
export { ESCAPED };

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
            if (i + 1 < str.length && str[i + 1] === "[") {
              // CSI sequence (arrow keys, bracketed paste, etc.) — skip it
              i += 2;
              while (i < str.length && str.charCodeAt(i) >= 0x20 && str.charCodeAt(i) <= 0x3f) i++;
              if (i < str.length) i++; // skip final byte
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
          i++;
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
            if (i + 1 < str.length && str[i + 1] === "[") {
              i += 2;
              while (i < str.length && str.charCodeAt(i) >= 0x20 && str.charCodeAt(i) <= 0x3f) i++;
              if (i < str.length) i++;
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
          i++;
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
