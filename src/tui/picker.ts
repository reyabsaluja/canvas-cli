import chalk from "chalk";
import { hideCursor, showCursor, createBuffer, C, getTermSize } from "./screen.js";
import { USER_ABORT_EXIT_CODE } from "./chat-shell-exit.js";

export interface PickerItem {
  label: string;
  sublabel?: string;
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
          (item.sublabel?.toLowerCase().includes(q) ?? false)
      );
    }

    function render(): void {
      const buf = createBuffer();
      filtered = getFiltered();
      if (selected >= filtered.length) selected = Math.max(0, filtered.length - 1);
      if (selected < windowStart) {
        windowStart = selected;
      }

      const { rows } = getTermSize();
      const reservedRows =
        5 + (subtitle ? 1 : 0) + (filterable && filter ? 2 : 0) + 2;
      const visibleCount = Math.max(4, rows - reservedRows);
      if (selected >= windowStart + visibleCount) {
        windowStart = selected - visibleCount + 1;
      }
      const maxWindowStart = Math.max(0, filtered.length - visibleCount);
      windowStart = Math.max(0, Math.min(windowStart, maxWindowStart));
      const windowEnd = Math.min(filtered.length, windowStart + visibleCount);
      const visibleItems = filtered.slice(windowStart, windowEnd);

      buf.push("");
      buf.push(C.primaryBold(`  ${title}`));
      if (subtitle) buf.push(C.dim(`  ${subtitle}`));
      buf.push("");

      if (filterable && filter) {
        buf.push(C.dim("  search: ") + C.text(filter) + chalk.white("█"));
        buf.push("");
      }

      if (filtered.length === 0) {
        buf.push(C.dim("  No items match your search."));
      } else {
        if (windowStart > 0) {
          buf.push(C.dim(`  ↑ ${windowStart} earlier item${windowStart === 1 ? "" : "s"}`));
        }

        for (let i = 0; i < visibleItems.length; i++) {
          const item = visibleItems[i];
          const absoluteIndex = windowStart + i;
          const isSelected = absoluteIndex === selected;
          const pointer = isSelected ? C.primary("❯ ") : "  ";
          const label = item.dimmed
            ? C.dim(item.label)
            : isSelected
              ? C.bold(item.label)
              : C.text(item.label);
          const sub = item.sublabel
            ? C.dim(` — ${item.sublabel}`)
            : "";
          buf.push(`  ${pointer}${label}${sub}`);
        }

        const remaining = filtered.length - windowEnd;
        if (remaining > 0) {
          buf.push(C.dim(`  ↓ ${remaining} more item${remaining === 1 ? "" : "s"}`));
        }
      }

      buf.push("");
      buf.push(
        C.dimmer(
          `  ↑↓ navigate  enter select${backLabel ? `  esc ${backLabel}` : ""}${filterable ? "  type to filter" : ""}`
        )
      );

      buf.flush();
    }

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
          resolve(filtered[selected].value);
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
      stdin.setRawMode(false);
      stdin.pause();
      showCursor();
    }

    stdin.on("data", onData);
  });
}
