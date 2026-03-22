import chalk from "chalk";
import { clearScreen, hideCursor, showCursor, divider } from "./screen.js";

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
  /** Allow typing to filter items. */
  filterable?: boolean;
  /** Show a back hint. */
  backLabel?: string;
}

/**
 * Show an interactive arrow-key picker.
 * Returns the selected item's value, or null if user pressed Escape.
 */
export function showPicker(options: PickerOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const { title, subtitle, items, filterable, backLabel } = options;
    let selected = 0;
    let filter = "";
    let filtered = items;

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
      clearScreen();
      filtered = getFiltered();
      if (selected >= filtered.length) selected = Math.max(0, filtered.length - 1);

      // Title
      console.log("");
      console.log(chalk.bold(`  ${title}`));
      if (subtitle) console.log(chalk.dim(`  ${subtitle}`));
      console.log("");

      if (filterable && filter) {
        console.log(chalk.dim(`  Search: `) + filter + chalk.dim("│"));
        console.log("");
      }

      // Items
      if (filtered.length === 0) {
        console.log(chalk.dim("  No items match your search."));
      } else {
        for (let i = 0; i < filtered.length; i++) {
          const item = filtered[i];
          const isSelected = i === selected;
          const pointer = isSelected ? chalk.cyan("❯ ") : "  ";
          const label = item.dimmed
            ? chalk.dim(item.label)
            : isSelected
              ? chalk.white.bold(item.label)
              : item.label;
          const sub = item.sublabel
            ? (isSelected ? chalk.dim(` — ${item.sublabel}`) : chalk.dim(` — ${item.sublabel}`))
            : "";
          console.log(`  ${pointer}${label}${sub}`);
        }
      }

      // Footer
      console.log("");
      console.log(
        chalk.dim(
          `  ↑↓ navigate  Enter select${backLabel ? `  Esc ${backLabel}` : ""}${filterable ? "  Type to filter" : ""}`
        )
      );
    }

    hideCursor();
    render();

    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    function onData(key: string): void {
      // Escape
      if (key === "\x1B" || key === "\x1B\x1B") {
        cleanup();
        resolve(null);
        return;
      }

      // Enter
      if (key === "\r" || key === "\n") {
        if (filtered.length > 0) {
          cleanup();
          resolve(filtered[selected].value);
          return;
        }
      }

      // Arrow up
      if (key === "\x1B[A") {
        selected = Math.max(0, selected - 1);
        render();
        return;
      }

      // Arrow down
      if (key === "\x1B[B") {
        selected = Math.min(filtered.length - 1, selected + 1);
        render();
        return;
      }

      // Backspace
      if (key === "\x7F" || key === "\b") {
        if (filterable && filter.length > 0) {
          filter = filter.slice(0, -1);
          selected = 0;
          render();
        }
        return;
      }

      // Ctrl+C
      if (key === "\x03") {
        cleanup();
        process.exit(0);
      }

      // Regular character for filtering
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
      clearScreen();
    }

    stdin.on("data", onData);
  });
}
