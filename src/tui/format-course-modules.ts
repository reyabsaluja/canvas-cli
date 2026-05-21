import type { CourseCache } from "../enrich/cache-loader.js";
import type { ModuleIndexEntry } from "../ingest/types.js";
import { escapeTableCell } from "./format-table-utils.js";

const MAX_TABLE_ROWS = 50;

export function formatCourseModulesList(cache: CourseCache): string {
  const modules = [...cache.modules].sort(
    (a, b) => a.position - b.position || a.name.localeCompare(b.name)
  );

  if (modules.length === 0) {
    return "No course modules are cached yet. Open a workspace or refresh the course cache first.";
  }

  const lines = [...buildModulesTable(modules)];
  lines.push("", "Use `/open <name>` to open module content.");
  return lines.join("\n").trim();
}

function buildModulesTable(modules: ModuleIndexEntry[]): string[] {
  const visible = modules.slice(0, MAX_TABLE_ROWS);
  const hidden = modules.length - visible.length;

  const lines: string[] = [
    "| # | Module | Items |",
    "| --- | --- | --- |",
  ];

  for (let index = 0; index < visible.length; index++) {
    const module = visible[index]!;
    lines.push(
      `| ${index + 1} | ${escapeTableCell(module.name)} | **${module.itemCount}** |`
    );
  }

  if (hidden > 0) {
    lines.push("");
    lines.push(
      `… and ${hidden} more module${hidden === 1 ? "" : "s"} — use \`/open <name>\` to browse items.`
    );
  }

  return lines;
}
