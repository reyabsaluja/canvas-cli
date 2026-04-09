import type { RadarFilter, RadarItem, RadarThread } from "./services.js";
import type { AppServices } from "./services.js";

export function parseRadarArgs(args: string): {
  filter: RadarFilter;
  query: string;
} {
  const trimmed = args.trim();
  if (!trimmed) return { filter: "all", query: "" };

  const parts = trimmed.split(/\s+/);
  const first = parts[0]!.toLowerCase();

  if (first === "announcements" || first === "a") {
    return { filter: "announcements", query: parts.slice(1).join(" ") };
  }
  if (first === "discussions" || first === "d") {
    return { filter: "discussions", query: parts.slice(1).join(" ") };
  }

  return { filter: "all", query: trimmed };
}

export function formatRadarItems(
  items: RadarItem[],
  filter: RadarFilter,
  query: string
): string {
  const heading =
    filter === "announcements"
      ? "Announcements"
      : filter === "discussions"
        ? "Discussions"
        : "Announcements & Discussions";

  if (items.length === 0) {
    const suffix = query ? ` matching "${query}"` : "";
    return `No recent ${heading.toLowerCase()}${suffix}.`;
  }

  const lines: string[] = [
    `**${heading}** (${items.length} item${items.length === 1 ? "" : "s"})`,
    "",
  ];

  for (const item of items.slice(0, 30)) {
    const tag = item.kind === "announcement" ? "[A]" : "[D]";
    const author = item.authorName ? ` — ${item.authorName}` : "";
    const course = ` — ${item.courseName}`;
    const ageDate = item.lastReplyAt ?? item.postedAt;
    const age = ageDate ? ` — ${formatAge(ageDate)}` : "";
    const unread =
      item.unreadCount > 0 ? ` — ${item.unreadCount} unread` : "";
    lines.push(`${tag} ${item.title}${author}${course}${age}${unread}`);
  }

  if (items.length > 30) {
    lines.push(`... and ${items.length - 30} more`);
  }

  return lines.join("\n");
}

export function formatThread(thread: RadarThread): string {
  const lines: string[] = [
    `**${thread.topic.title}** — ${thread.topic.courseName}`,
  ];

  const author = thread.topic.authorName
    ? `Posted by ${thread.topic.authorName}`
    : "Posted";
  const date = thread.topic.postedAt
    ? ` — ${thread.topic.postedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
    : "";
  lines.push(`${author}${date}`);

  if (thread.body) {
    lines.push("", thread.body);
  }

  if (thread.entries.length > 0) {
    lines.push(
      "",
      `--- ${thread.totalEntries} repl${thread.totalEntries === 1 ? "y" : "ies"} · ${thread.participantCount} participant${thread.participantCount === 1 ? "" : "s"} ---`
    );

    for (const entry of thread.entries) {
      const indent = "  ".repeat(entry.depth);
      const ts = entry.createdAt.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      lines.push("", `${indent}${entry.authorName} (${ts}):`);
      for (const msgLine of entry.message.split("\n")) {
        lines.push(`${indent}  ${msgLine}`);
      }
    }

    if (thread.entries.length < thread.totalEntries) {
      lines.push(
        "",
        `(showing ${thread.entries.length} of ${thread.totalEntries} replies)`
      );
    }
  }

  return lines.join("\n");
}

export async function resolveAndRenderThread(
  services: AppServices,
  courses: Array<{ id: number; name: string }>,
  query: string
): Promise<{ found: boolean; content: string }> {
  const numericId = /^\d+$/.test(query) ? parseInt(query, 10) : null;

  if (numericId !== null) {
    for (const course of courses) {
      const thread = await services.radar.getThread(
        course.id,
        course.name,
        numericId
      );
      if (thread) {
        return { found: true, content: formatThread(thread) };
      }
    }
    return {
      found: false,
      content: `No discussion thread with ID ${numericId} found.`,
    };
  }

  const match = await services.radar.resolveTopicByPartialTitle(courses, query);
  if (!match) {
    return {
      found: false,
      content: `No discussion thread matching "${query}" found.`,
    };
  }

  if (match.status === "ambiguous") {
    const lines = [
      `Multiple threads matched "${query}". Be more specific or use /thread <id>:`,
      ...match.matches.slice(0, 8).map(
        (item) => `• [${item.topicId}] ${item.title} — ${item.courseName}`
      ),
    ];
    if (match.matches.length > 8) {
      lines.push(`... and ${match.matches.length - 8} more`);
    }
    return { found: false, content: lines.join("\n") };
  }

  const thread = await services.radar.getThread(
    match.courseId,
    match.item.courseName,
    match.item.topicId
  );
  if (!thread) {
    return {
      found: false,
      content: `Found "${match.item.title}" but could not load the thread.`,
    };
  }
  return { found: true, content: formatThread(thread) };
}

function formatAge(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
