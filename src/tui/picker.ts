import chalk from "chalk";
import {
  clearScreen,
  createBuffer,
  C,
  enterAlternateScreen,
  getTermSize,
  hideCursor,
  leaveAlternateScreen,
  padAnsiToWidth,
  showCursor,
  stripAnsi,
} from "./screen.js";
import { USER_ABORT_EXIT_CODE } from "./chat-shell-exit.js";

export interface PickerItem {
  label: string;
  sublabel?: string;
  description?: string;
  rightLabel?: string;
  value: string;
  dimmed?: boolean;
}

export interface PickerOptions {
  title: string;
  subtitle?: string;
  items: PickerItem[];
  filterable?: boolean;
  backLabel?: string;
}

/**
 * Show an interactive arrow-key picker. Flicker-free via screen buffer.
 */
export function showPicker(options: PickerOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const { title, subtitle, items, filterable, backLabel } = options;
    let selected = 0;
    let filter = "";
    let filtered = items;
    let windowStart = 0;

    function getFiltered(): PickerItem[] {
      if (!filter) return items;
      const q = filter.toLowerCase();
      return items.filter(
        (item) =>
          item.label.toLowerCase().includes(q) ||
          (item.sublabel?.toLowerCase().includes(q) ?? false) ||
          (item.description?.toLowerCase().includes(q) ?? false)
      );
    }

    const hasCards = items.some((item) => item.description);

    function render(): void {
      const buf = createBuffer();
      filtered = getFiltered();
      if (selected >= filtered.length) selected = Math.max(0, filtered.length - 1);
      if (selected < windowStart) {
        windowStart = selected;
      }

      const { rows, cols } = getTermSize();
      const cardWidth = cols - 6;
      const linesPerItem = hasCards ? 4 : 1;
      const reservedRows = 8 + (subtitle ? 1 : 0);
      const visibleCount = Math.max(2, Math.floor((rows - reservedRows) / linesPerItem));
      if (selected >= windowStart + visibleCount) {
        windowStart = selected - visibleCount + 1;
      }
      const maxWindowStart = Math.max(0, filtered.length - visibleCount);
      windowStart = Math.max(0, Math.min(windowStart, maxWindowStart));
      const windowEnd = Math.min(filtered.length, windowStart + visibleCount);
      const visibleItems = filtered.slice(windowStart, windowEnd);

      buf.push("");
      buf.push(C.bold(`  ${title}`));
      if (subtitle) buf.push(C.dim(`  ${subtitle}`));
      buf.push("");

      if (filterable) {
        const innerWidth = cardWidth - 2;
        const innerStyled = filter
          ? C.dim("⌕ ") + C.text(filter) + chalk.white("█")
          : C.dim("⌕ ") + C.dimmer("Search...");
        const contentLine = padAnsiToWidth(innerStyled, innerWidth);
        buf.push(C.dim("  ╭" + "─".repeat(cardWidth) + "╮"));
        buf.push(`  ${C.dim("│")} ${contentLine} ${C.dim("│")}`);
        buf.push(C.dim("  ╰" + "─".repeat(cardWidth) + "╯"));
        buf.push("");
      }

      if (filtered.length === 0) {
        buf.push(C.dim("  No items match your search."));
      } else {
        if (windowStart > 0) {
          buf.push(C.dim(`  ↑ ${windowStart} more above`));
        }

        for (let i = 0; i < visibleItems.length; i++) {
          const item = visibleItems[i]!;
          const absoluteIndex = windowStart + i;
          const isSelected = absoluteIndex === selected;

          if (hasCards) {
            const topBorder = isSelected
              ? C.accent("  ┌" + "─".repeat(cardWidth) + "┐")
              : C.dimmer("  ┌" + "─".repeat(cardWidth) + "┐");
            const botBorder = isSelected
              ? C.accent("  └" + "─".repeat(cardWidth) + "┘")
              : C.dimmer("  └" + "─".repeat(cardWidth) + "┘");
            const edge = isSelected ? C.accent("│") : C.dimmer("│");

            const label = item.dimmed
              ? C.dim(item.label)
              : isSelected
                ? C.accent(item.label)
                : C.text(item.label);
            const sub = item.sublabel
              ? (isSelected ? C.accent(` · ${item.sublabel}`) : C.dim(` · ${item.sublabel}`))
              : "";
            const innerWidth = cardWidth - 2;
            const labelLine = padAnsiToWidth(`${label}${sub}`, innerWidth);

            const desc = item.description
              ? (isSelected ? C.muted(item.description) : C.dim(item.description))
              : "";
            const right = item.rightLabel
              ? (isSelected ? C.accent(item.rightLabel) : C.dim(item.rightLabel))
              : "";
            const rightPlain = item.rightLabel ?? "";
            const descPlain = item.description ?? "";
            const gapNeeded = innerWidth - descPlain.length - rightPlain.length;
            const descLine = gapNeeded > 0
              ? desc + " ".repeat(gapNeeded) + right
              : padAnsiToWidth(desc, innerWidth);

            buf.push(topBorder);
            buf.push(`  ${edge} ${labelLine} ${edge}`);
            buf.push(`  ${edge} ${descLine} ${edge}`);
            buf.push(botBorder);
          } else {
            const pointer = isSelected ? C.accent("❯ ") : "  ";
            const label = item.dimmed
              ? C.dim(item.label)
              : isSelected
                ? C.accent(item.label)
                : C.text(item.label);
            const sub = item.sublabel
              ? (isSelected ? C.accent(` — ${item.sublabel}`) : C.dim(` — ${item.sublabel}`))
              : "";
            buf.push(`  ${pointer}${label}${sub}`);
          }
        }

        const remaining = filtered.length - windowEnd;
        if (remaining > 0) {
          buf.push(C.dim(`  ↓ ${remaining} more below`));
        }
      }

      buf.push("");
      buf.push(
        C.dimmer(
          `  ↑↓ navigate  enter select${backLabel ? `  esc ${backLabel}` : ""}${filterable ? "  type to search" : ""}`
        )
      );

      buf.flush();
    }

    enterAlternateScreen();
    clearScreen();
    hideCursor();
    render();

    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    function onData(key: string): void {
      if (key === "\x1B" || key === "\x1B\x1B") {
        cleanup();
        resolve(null);
        return;
      }

      if (key === "\r" || key === "\n") {
        if (filtered.length > 0) {
          cleanup();
          resolve(filtered[selected]!.value);
          return;
        }
      }

      if (key === "\x1B[A") {
        selected = Math.max(0, selected - 1);
        render();
        return;
      }

      if (key === "\x1B[B") {
        selected = Math.min(filtered.length - 1, selected + 1);
        render();
        return;
      }

      if (key === "\x7F" || key === "\b") {
        if (filterable && filter.length > 0) {
          filter = filter.slice(0, -1);
          selected = 0;
          render();
        }
        return;
      }

      if (key === "\x03") {
        cleanup();
        process.exit(USER_ABORT_EXIT_CODE);
      }

      if (filterable && key.length === 1 && key >= " ") {
        filter += key;
        selected = 0;
        render();
      }
    }

    function cleanup(): void {
      stdin.removeListener("data", onData);
      try {
        stdin.setRawMode(false);
      } catch {}
      try {
        stdin.pause();
      } catch {}
      try {
        leaveAlternateScreen();
      } catch {}
      try {
        clearScreen();
      } catch {}
      try {
        showCursor();
      } catch {}
    }

    stdin.on("data", onData);
  });
}
