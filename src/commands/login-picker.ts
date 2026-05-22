import chalk from "chalk";

export const C = {
  primary: chalk.hex("#e82429"),
  primaryBold: chalk.hex("#e82429").bold,
  text: chalk.hex("#d4d4d4"),
  muted: chalk.hex("#a0a0a0"),
  dim: chalk.hex("#606060"),
  success: chalk.hex("#6ec86a"),
  error: chalk.hex("#ff6b6b"),
  warm: chalk.hex("#e8a86d"),
  white: chalk.hex("#ffffff"),
  whiteBold: chalk.hex("#ffffff").bold,
};

export const BACK = Symbol("back");
export type PickerResult = string | null | typeof BACK;

export interface PickerOption {
  label: string;
  value: string;
  description?: string;
}

export async function verticalPicker(
  label: string,
  options: PickerOption[]
): Promise<PickerResult> {
  if (!process.stdin.isTTY) return options[0]?.value ?? null;

  let selected = 0;
  const render = () => {
    process.stdout.write(`\x1b[${options.length + 1}A`);
    process.stdout.write(`  ${C.text(label)}\n`);
    for (let i = 0; i < options.length; i++) {
      const opt = options[i]!;
      const marker = i === selected ? C.primary("▸") : " ";
      const text = i === selected ? C.whiteBold(opt.label) : C.muted(opt.label);
      const desc = opt.description
        ? " " + C.dim(opt.description)
        : "";
      process.stdout.write(`\x1b[2K  ${marker} ${text}${desc}\n`);
    }
  };

  // Print placeholder lines so the first render() can cursor-up over them
  process.stdout.write("\n".repeat(options.length + 1));
  render();

  return new Promise((resolve) => {
    try {
      process.stdin.setRawMode(true);
    } catch {
      resolve(null);
      return;
    }
    process.stdin.resume();

    const cleanup = () => {
      try { process.stdin.setRawMode(false); } catch {}
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
    };

    const onData = (buf: Buffer) => {
      try {
        const str = buf.toString();

        if (str === "\r" || str === "\n") {
          cleanup();
          resolve(options[selected]!.value);
          return;
        }
        if (str === "\x1b" && buf.length === 1) {
          cleanup();
          resolve(BACK);
          return;
        }
        if (str === "\x03") {
          cleanup();
          process.exit(130);
          return;
        }
        if (str === "q") {
          cleanup();
          resolve(null);
          return;
        }
        if (str === "\x1b[A" || str === "k") {
          selected = (selected - 1 + options.length) % options.length;
          render();
        } else if (str === "\x1b[B" || str === "j") {
          selected = (selected + 1) % options.length;
          render();
        }
      } catch {
        cleanup();
        resolve(null);
      }
    };

    process.stdin.on("data", onData);
  });
}

export async function horizontalPicker(
  label: string,
  options: PickerOption[]
): Promise<PickerResult> {
  if (!process.stdin.isTTY) return options[0]?.value ?? null;

  let selected = 0;
  const renderLine = () => {
    process.stdout.write("\x1b[2K\r");
    const parts = options.map((opt, i) => {
      if (i === selected) {
        return C.whiteBold(`[${opt.label}]`);
      }
      return C.dim(opt.label);
    });
    process.stdout.write(`  ${C.text(label)}  ${parts.join(C.dim("  ·  "))}`);
  };

  renderLine();

  return new Promise((resolve) => {
    try {
      process.stdin.setRawMode(true);
    } catch {
      process.stdout.write("\n");
      resolve(null);
      return;
    }
    process.stdin.resume();

    const cleanup = () => {
      try { process.stdin.setRawMode(false); } catch {}
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
    };

    const onData = (buf: Buffer) => {
      try {
        const str = buf.toString();

        if (str === "\r" || str === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(options[selected]!.value);
          return;
        }
        if (str === "\x1b" && buf.length === 1) {
          cleanup();
          process.stdout.write("\n");
          resolve(BACK);
          return;
        }
        if (str === "\x03") {
          cleanup();
          process.stdout.write("\n");
          process.exit(130);
          return;
        }
        if (str === "q") {
          cleanup();
          process.stdout.write("\n");
          resolve(null);
          return;
        }
        if (str === "\x1b[D" || str === "h") {
          selected = (selected - 1 + options.length) % options.length;
          renderLine();
        } else if (str === "\x1b[C" || str === "l") {
          selected = (selected + 1) % options.length;
          renderLine();
        }
      } catch {
        cleanup();
        process.stdout.write("\n");
        resolve(null);
      }
    };

    process.stdin.on("data", onData);
  });
}
