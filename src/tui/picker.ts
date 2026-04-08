import chalk from "chalk";
<<<<<<< HEAD
import {
  clearScreen,
  createBuffer,
  C,
  enterAlternateScreen,
  getTermSize,
  hideCursor,
  leaveAlternateScreen,
  showCursor,
} from "./screen.js";
import { USER_ABORT_EXIT_CODE } from "./chat-shell-exit.js";
=======
import { createBuffer, C } from "./screen.js";
import { startTerminalSession } from "./terminal.js";
>>>>>>> main

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
<<<<<<< HEAD
    let windowStart = 0;
=======
    let windowTop = 0;
>>>>>>> main

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
      const viewRows = process.stdout.rows || 24;
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
      buf.push(C.bold(`  ${title}`));
      if (subtitle) buf.push(C.dim(`  ${subtitle}`));
      buf.push("");

      if (filterable && filter) {
        buf.push(C.dim("  search: ") + C.text(filter) + chalk.white("█"));
        buf.push("");
      }

      const itemStartLine = buf.length;
      const footerRows = 2;
      const availableItemRows = Math.max(1, viewRows - itemStartLine - footerRows);
      if (filtered.length === 0) {
        buf.push(C.dim("  No items match your search."));
      } else {
<<<<<<< HEAD
        if (windowStart > 0) {
          buf.push(C.dim(`  ↑ ${windowStart} earlier item${windowStart === 1 ? "" : "s"}`));
        }

        for (let i = 0; i < visibleItems.length; i++) {
          const item = visibleItems[i];
          const absoluteIndex = windowStart + i;
          const isSelected = absoluteIndex === selected;
          const pointer = isSelected ? C.bold("❯ ") : "  ";
=======
        const selectedLine = selected;
        const totalVirtualRows = filtered.length;
        const margin = 2;
        const minTop = Math.max(0, selectedLine - Math.max(0, availableItemRows - 1 - margin));
        const maxTop = Math.max(0, selectedLine - margin);
        windowTop = Math.max(minTop, Math.min(windowTop, maxTop));
        windowTop = Math.max(0, Math.min(windowTop, Math.max(0, totalVirtualRows - availableItemRows)));

        const hiddenAbove = windowTop;
        const hiddenBelow = Math.max(0, totalVirtualRows - (windowTop + availableItemRows));
        let visibleSlots = availableItemRows;

        if (hiddenAbove > 0 && visibleSlots > 0) {
          buf.push(C.dim(`  ... ${hiddenAbove} more above`));
          visibleSlots -= 1;
        }

        const visibleCount = Math.max(
          0,
          Math.min(filtered.length - windowTop, visibleSlots - (hiddenBelow > 0 ? 1 : 0))
        );

        for (let i = 0; i < visibleCount; i++) {
          const item = filtered[windowTop + i];
          const itemIndex = windowTop + i;
          const isSelected = itemIndex === selected;
          const pointer = isSelected ? C.primary("❯ ") : "  ";
>>>>>>> main
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

<<<<<<< HEAD
        const remaining = filtered.length - windowEnd;
        if (remaining > 0) {
          buf.push(C.dim(`  ↓ ${remaining} more item${remaining === 1 ? "" : "s"}`));
=======
        if (hiddenBelow > 0 && visibleSlots > 0) {
          buf.push(C.dim(`  ... ${hiddenBelow} more below`));
>>>>>>> main
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

<<<<<<< HEAD
    enterAlternateScreen();
    clearScreen();
    hideCursor();
=======
    const cleanupSession = startTerminalSession(onData, {
      onResize: render,
      clearOnEnter: false,
      clearOnExit: false,
    });
>>>>>>> main
    render();

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
<<<<<<< HEAD
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
=======
      cleanupSession();
>>>>>>> main
    }
  });
}
