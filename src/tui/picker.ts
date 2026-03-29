import chalk from "chalk";
import { createBuffer, C, keepLineVisible } from "./screen.js";
import { startTerminalSession } from "./terminal.js";

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
    let scrollTop = 0;

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

      buf.push("");
      buf.push(C.primaryBold(`  ${title}`));
      if (subtitle) buf.push(C.dim(`  ${subtitle}`));
      buf.push("");

      if (filterable && filter) {
        buf.push(C.dim("  search: ") + C.text(filter) + chalk.white("█"));
        buf.push("");
      }

      const itemStartLine = buf.length;
      if (filtered.length === 0) {
        buf.push(C.dim("  No items match your search."));
      } else {
        for (let i = 0; i < filtered.length; i++) {
          const item = filtered[i];
          const isSelected = i === selected;
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
      }

      buf.push("");
      buf.push(
        C.dimmer(
          `  ↑↓ navigate  enter select${backLabel ? `  esc ${backLabel}` : ""}${filterable ? "  type to filter" : ""}`
        )
      );

      const selectedLine =
        filtered.length > 0 ? itemStartLine + selected : itemStartLine;
      scrollTop = keepLineVisible(selectedLine, scrollTop, viewRows, buf.length, 2);
      const maxScroll = Math.max(0, buf.length - viewRows);
      const scrollFromBottom = maxScroll - scrollTop;

      buf.flush(0, scrollFromBottom);
    }

    const cleanupSession = startTerminalSession(onData, {
      alternateScreen: true,
      onResize: render,
    });
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
        process.exit(0);
      }

      if (filterable && key.length === 1 && key >= " ") {
        filter += key;
        selected = 0;
        render();
      }
    }

    function cleanup(): void {
      cleanupSession();
    }
  });
}
