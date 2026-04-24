import { spawn } from "node:child_process";

type Command = readonly [string, ...string[]];

function candidatesForPlatform(): Command[] {
  if (process.platform === "darwin") return [["pbcopy"]];
  if (process.platform === "win32") return [["clip"]];
  return [
    ["wl-copy"],
    ["xclip", "-selection", "clipboard"],
    ["xsel", "--clipboard", "--input"],
  ];
}

export async function copyToClipboard(text: string): Promise<void> {
  let lastError: Error | null = null;
  for (const [cmd, ...args] of candidatesForPlatform()) {
    try {
      await runClipboardCommand(cmd, args, text);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error("No clipboard command available");
}

function runClipboardCommand(
  cmd: string,
  args: string[],
  text: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"] });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code ?? "unknown"}`));
    });
    proc.stdin.write(text);
    proc.stdin.end();
  });
}
