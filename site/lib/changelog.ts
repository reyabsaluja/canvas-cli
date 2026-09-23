import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * CHANGELOG.md (Keep a Changelog format), parsed at build time so the docs
 * page can never drift from the file in the repository root.
 */

export type ChangelogRelease = {
  version: string;
  date: string | null;
  intro: string[];
  groups: { title: string; items: string[] }[];
};

export function readChangelog(): ChangelogRelease[] {
  const source = readFileSync(path.join(process.cwd(), "..", "CHANGELOG.md"), "utf8");
  const releases: ChangelogRelease[] = [];
  let current: ChangelogRelease | null = null;
  let group: { title: string; items: string[] } | null = null;

  for (const line of source.split("\n")) {
    const release = /^## \[([^\]]+)\](?:\s*-\s*(.+))?/.exec(line);
    if (release) {
      current = { version: release[1], date: release[2]?.trim() ?? null, intro: [], groups: [] };
      group = null;
      releases.push(current);
      continue;
    }
    if (!current) continue;
    if (/^\[[^\]]+\]:\s/.test(line)) continue; // link reference definitions
    const heading = /^### (.+)/.exec(line);
    if (heading) {
      group = { title: heading[1].trim(), items: [] };
      current.groups.push(group);
      continue;
    }
    const bullet = /^- (.+)/.exec(line);
    if (bullet && group) {
      group.items.push(bullet[1].trim());
      continue;
    }
    // A wrapped bullet continues on an indented line.
    if (/^\s{2,}\S/.test(line) && group && group.items.length > 0) {
      group.items[group.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    if (line.trim() && !group) current.intro.push(line.trim());
  }

  // An empty Unreleased section is noise on a published page.
  return releases.filter((r) => r.version !== "Unreleased" || r.groups.some((g) => g.items.length > 0));
}

export const releaseId = (version: string) => `v${version.replace(/[^\w.-]/g, "-").toLowerCase()}`;
