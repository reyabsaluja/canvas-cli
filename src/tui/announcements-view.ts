import chalk from "chalk";
import {
  buildLogoBanner,
  clearScreen,
  createBuffer,
  C,
  enterAlternateScreen,
  getTermSize,
  hideCursor,
  leaveAlternateScreen,
  padAnsiToWidth,
  showCursor,
  truncatePlainToWidth,
  wrapPlainText,
} from "./screen.js";
import type { RadarItem, RadarThread } from "./services.js";
import type { RadarService } from "./services/radar-service.js";
import { htmlToText } from "../format/html-to-text.js";

const P = {
  white: chalk.hex("#d4d4d4"),
  whiteBold: chalk.hex("#d4d4d4").bold,
  dim: chalk.hex("#808080"),
  dimmer: chalk.hex("#505050"),
};

export function showAnnouncementsView(
  items: RadarItem[],
  scope: "global" | "course",
  courseName?: string,
  radar?: RadarService
): Promise<void> {
  return new Promise((resolve) => {
    let selected = 0;
    let windowStart = 0;
    let detailThread: RadarThread | null = null;
    let detailScroll = 0;
    let loading = false;

    function renderList(): void {
      const buf = createBuffer();
      const { rows, cols } = getTermSize();
      const cardWidth = cols - 6;
      const linesPerItem = 4;
      const reservedRows = 12;
      const visibleCount = Math.max(2, Math.floor((rows - reservedRows) / linesPerItem));

      if (selected < windowStart) windowStart = selected;
      if (selected >= windowStart + visibleCount) windowStart = selected - visibleCount + 1;
      const maxWindowStart = Math.max(0, items.length - visibleCount);
      windowStart = Math.max(0, Math.min(windowStart, maxWindowStart));
      const windowEnd = Math.min(items.length, windowStart + visibleCount);
      const visibleItems = items.slice(windowStart, windowEnd);

      buf.push("");
      const title = "Announcements";
      const subtitle = scope === "course" && courseName
        ? courseName
        : `All courses · ${items.length} total`;
      for (const line of buildLogoBanner(title, subtitle)) buf.push(line);
      buf.push("");

      if (items.length === 0) {
        buf.push(P.dim("  No announcements found."));
      } else {
        if (windowStart > 0) {
          buf.push(P.dim(`  ↑ ${windowStart} more above`));
        }

        for (let i = 0; i < visibleItems.length; i++) {
          const item = visibleItems[i]!;
          const absoluteIndex = windowStart + i;
          const isSelected = absoluteIndex === selected;
          const borderColor = isSelected ? P.white : P.dimmer;
          const edge = borderColor("│");
          const innerWidth = cardWidth - 2;

          const titleText = truncatePlainToWidth(item.title, innerWidth - 20);
          const courseTag = scope === "global"
            ? (isSelected ? P.white(` · ${truncatePlainToWidth(item.courseName, 20)}`) : P.dim(` · ${truncatePlainToWidth(item.courseName, 20)}`))
            : "";
          const titleLine = padAnsiToWidth(
            `${isSelected ? P.whiteBold(titleText) : P.white(titleText)}${courseTag}`,
            innerWidth
          );

          const author = item.authorName ? item.authorName : "Unknown";
          const date = item.postedAt
            ? item.postedAt.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })
            : "";
          const metaText = `${author}${date ? `  ·  ${date}` : ""}`;
          const metaLine = padAnsiToWidth(
            isSelected ? P.white(metaText) : P.dim(metaText),
            innerWidth
          );

          buf.push(borderColor("  ┌" + "─".repeat(cardWidth) + "┐"));
          buf.push(`  ${edge} ${titleLine} ${edge}`);
          buf.push(`  ${edge} ${metaLine} ${edge}`);
          buf.push(borderColor("  └" + "─".repeat(cardWidth) + "┘"));
        }

        const remaining = items.length - windowEnd;
        if (remaining > 0) {
          buf.push(P.dim(`  ↓ ${remaining} more below`));
        }
      }

      buf.push("");
      buf.push(
        "  " + C.pureWhite("↑↓") + P.dimmer(" navigate  ") +
        C.pureWhite("enter") + P.dimmer(" read") +
        "  " + C.pureWhite("esc") + P.dimmer(" back")
      );

      buf.flush();
    }

    function renderDetail(): void {
      if (!detailThread) return;
      const buf = createBuffer();
      const { rows, cols } = getTermSize();
      const contentWidth = cols - 8;

      const contentLines: string[] = [];
      contentLines.push("");
      contentLines.push("  " + P.whiteBold(detailThread.topic.title));
      if (scope === "global") {
        contentLines.push("  " + P.dim(detailThread.topic.courseName));
      }
      const author = detailThread.topic.authorName
        ? `Posted by ${detailThread.topic.authorName}`
        : "Posted";
      const date = detailThread.topic.postedAt
        ? ` · ${detailThread.topic.postedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
        : "";
      contentLines.push("  " + P.dim(`${author}${date}`));
      contentLines.push("");

      if (detailThread.body) {
        const wrapped = wrapPlainText(detailThread.body, contentWidth);
        for (const line of wrapped) {
          contentLines.push("  " + P.white(line));
        }
      }

      if (detailThread.entries.length > 0) {
        contentLines.push("");
        contentLines.push(
          "  " + P.dim(`── ${detailThread.totalEntries} repl${detailThread.totalEntries === 1 ? "y" : "ies"} · ${detailThread.participantCount} participant${detailThread.participantCount === 1 ? "" : "s"} ──`)
        );

        for (const entry of detailThread.entries) {
          const indent = "  " + "  ".repeat(entry.depth);
          const ts = entry.createdAt.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          });
          contentLines.push("");
          contentLines.push(indent + P.whiteBold(entry.authorName) + P.dim(` (${ts})`));
          const entryWrapped = wrapPlainText(entry.message, contentWidth - (entry.depth * 2) - 2);
          for (const line of entryWrapped) {
            contentLines.push(indent + "  " + P.white(line));
          }
        }

        if (detailThread.entries.length < detailThread.totalEntries) {
          contentLines.push("");
          contentLines.push("  " + P.dim(`(showing ${detailThread.entries.length} of ${detailThread.totalEntries} replies)`));
        }
      }

      contentLines.push("");

      const maxScroll = Math.max(0, contentLines.length - (rows - 3));
      detailScroll = Math.max(0, Math.min(detailScroll, maxScroll));
      const visibleLines = contentLines.slice(detailScroll, detailScroll + rows - 3);

      for (const line of visibleLines) {
        buf.push(line);
      }

      while (buf.length < rows - 2) {
        buf.push("");
      }

      const scrollHint = contentLines.length > rows - 3
        ? C.pureWhite("↑↓") + P.dimmer(" scroll  ")
        : "";
      buf.push(
        "  " + scrollHint + C.pureWhite("esc") + P.dimmer(" back to list")
      );

      buf.flush();
    }

    function render(): void {
      if (detailThread) {
        renderDetail();
      } else {
        renderList();
      }
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
      if (loading) return;

      if (key === "\x1B" || key === "\x1B\x1B") {
        if (detailThread) {
          detailThread = null;
          detailScroll = 0;
          render();
          return;
        }
        cleanup();
        resolve();
        return;
      }

      if (key === "q") {
        if (detailThread) {
          detailThread = null;
          detailScroll = 0;
          render();
          return;
        }
        cleanup();
        resolve();
        return;
      }

      if (detailThread) {
        if (key === "\x1B[A" || key === "k") {
          if (detailScroll > 0) {
            detailScroll--;
            render();
          }
          return;
        }
        if (key === "\x1B[B" || key === "j") {
          detailScroll++;
          render();
          return;
        }
        return;
      }

      if (key === "\r" || key === "\n") {
        if (items.length > 0 && radar) {
          const item = items[selected]!;
          loading = true;
          void (async () => {
            try {
              const thread = await radar.getThread(item.courseId, item.courseName, item.topicId);
              if (thread) {
                detailThread = thread;
                detailScroll = 0;
              }
            } catch {
              detailThread = {
                topic: item,
                body: "(Failed to load thread — check your network connection.)",
                entries: [],
                totalEntries: 0,
                participantCount: 0,
              };
              detailScroll = 0;
            }
            loading = false;
            render();
          })();
        }
        return;
      }

      if (key === "\x1B[A" || key === "k") {
        if (selected > 0) {
          selected--;
          render();
        }
        return;
      }

      if (key === "\x1B[B" || key === "j") {
        if (selected < items.length - 1) {
          selected++;
          render();
        }
        return;
      }

      if (key === "\x03") {
        cleanup();
        resolve();
        return;
      }
    }

    function cleanup(): void {
      stdin.removeListener("data", onData);
      try { stdin.setRawMode(false); } catch {}
      try { stdin.pause(); } catch {}
      try { leaveAlternateScreen(); } catch {}
      try { clearScreen(); } catch {}
      try { showCursor(); } catch {}
    }

    stdin.on("data", onData);
  });
}
