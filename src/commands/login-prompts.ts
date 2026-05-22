import * as readline from "node:readline";

const ESCAPED = Symbol("escaped");
export { ESCAPED };

export function promptLine(question: string): Promise<string | typeof ESCAPED> {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
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
        for (const c of str) {
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
      rl.on("line", (line) => { rl.close(); resolve(line.trim()); });
      rl.on("close", () => resolve(ESCAPED));
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
        for (const c of str) {
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
