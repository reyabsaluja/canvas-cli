import { existsSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import chalk from "chalk";
import { showPicker, type PickerItem } from "./picker.js";
import { runWorkspaceUI } from "./workspace-ui.js";
import {
  initServices,
  fetchAssignments,
  openWorkspace,
  getRecentWorkspaces,
  getDisplayCourses,
  formatDueCompact,
  type AppServices,
} from "./services.js";
import { loadCourseConfig, type CourseConfig } from "./course-config.js";
import { loadCourseCache } from "../enrich/cache-loader.js";
import { refreshWorkspace } from "./services.js";
import { runCourseSetup, runCourseManagement } from "./course-setup.js";
import { loadWorkspace } from "../ask/load-workspace.js";
import {
  clearScreen,
  showCursor,
  hideCursor,
  createBuffer,
  CANVAS_ASCII,
  C,
  MenuBox,
  getTermSize,
  stripAnsi,
  enableMouseTracking,
  disableMouseTracking,
} from "./screen.js";
import type { Course } from "../domain/models.js";
import type { AssignmentWorkup } from "../work/types.js";

/**
 * Main interactive TUI application.
 */
export async function launchApp(): Promise<void> {
  process.on("SIGINT", () => {
    showCursor();
    clearScreen();
    process.exit(0);
  });

  // Show splash while loading
  clearScreen();
  hideCursor();
  renderSplashLoading();

  let services: AppServices;
  try {
    services = await initServices();
  } catch (err) {
    showCursor();
    clearScreen();
    console.error(
      C.error(
        `\n  Failed to connect: ${err instanceof Error ? err.message : "unknown error"}`
      )
    );
    console.error(
      C.dim("  Check your CANVAS_BASE_URL and CANVAS_ACCESS_TOKEN in .env")
    );
    process.exit(1);
  }

  // Load course config — run setup if no config or empty config
  let courseConfig = await loadCourseConfig();

  if (!courseConfig || courseConfig.courses.length === 0) {
    clearScreen();
    courseConfig = await runCourseSetup(services.allCourses);
  }
  services.courseConfig = courseConfig;

  // Pre-fetch recent workspaces
  let recent = await getRecentWorkspaces();

  let state: "home" | "assignments" | "workspace" = "home";
  let selectedCourse: Course | null = null;

  while (true) {
    switch (state) {
      case "home": {
        const action = await showHomeScreen(services, recent);
        if (action === null) {
          showCursor();
          clearScreen();
          return;
        }
        if (action === "all_workspaces") {
          const wsAction = await showAllWorkspaces(recent, services);
          if (wsAction?.startsWith("workspace:")) {
            const wsPath = wsAction.slice("workspace:".length);
            const result = await enterExistingWorkspace(wsPath, services);
            if (result === "courses") state = "home";
            else if (result === "back") state = "home";
            else { showCursor(); clearScreen(); return; }
          }
          recent = await getRecentWorkspaces(); // refresh in case of deletes
        } else if (action === "manage_courses") {
          clearScreen();
          const updated = await runCourseManagement(
            services.courseConfig ?? { courses: [] },
            services.allCourses
          );
          services.courseConfig = updated;
          recent = await getRecentWorkspaces();
        } else if (action.startsWith("course:")) {
          const courseId = action.slice("course:".length);
          const displayCourses = getDisplayCourses(services);
          selectedCourse =
            displayCourses.find((c) => String(c.id) === courseId) ?? null;
          if (selectedCourse) state = "assignments";
        } else if (action.startsWith("workspace:")) {
          const wsPath = action.slice("workspace:".length);
          const result = await enterExistingWorkspace(wsPath, services);
          if (result === "courses") state = "home";
          else if (result === "back") state = "home";
          else {
            showCursor();
            clearScreen();
            return;
          }
        }
        break;
      }

      case "assignments": {
        if (!selectedCourse) {
          state = "home";
          break;
        }
        const result = await showAssignmentPicker(services, selectedCourse);
        if (result === null) {
          state = "home";
          break;
        }
        const wsResult = await enterNewWorkspace(
          services,
          selectedCourse,
          result
        );
        if (wsResult === "back") state = "assignments";
        else if (wsResult === "courses") state = "home";
        else {
          showCursor();
          clearScreen();
          return;
        }
        break;
      }
    }
  }
}

// --- Splash Loading (shown briefly while connecting) ---

function renderSplashLoading(): void {
  const { cols } = getTermSize();
  console.log("");
  renderCenteredAscii(cols);
  console.log("");
  console.log(centerText(C.dim("connecting to canvas..."), cols));
}

// --- Unified Home Screen ---

async function showHomeScreen(
  services: AppServices,
  recent: Array<{ name: string; course: string; slug: string; path: string }>
): Promise<string | null> {
  return new Promise((resolve) => {
    const HOME_TOP_MARGIN_ROWS = 3;
    const { cols } = getTermSize();

    // Build the item list: recent workspaces first, then courses
    const items: Array<{
      label: string;
      sublabel: string;
      value: string;
      dimmed: boolean;
      isSection: boolean;
    }> = [];

    // Recent workspaces (max 3)
    if (recent.length > 0) {
      items.push({
        label: "Recent",
        sublabel: "",
        value: "",
        dimmed: false,
        isSection: true,
      });
      for (const ws of recent.slice(0, 3)) {
        items.push({
          label: ws.name,
          sublabel: ws.course,
          value: `workspace:${ws.path}`,
          dimmed: false,
          isSection: false,
        });
      }
      if (recent.length > 3) {
        items.push({
          label: "See all workspaces",
          sublabel: `${recent.length} total`,
          value: "all_workspaces",
          dimmed: true,
          isSection: false,
        });
      }
    }

    // Courses — use configured display courses
    const displayCourses = getDisplayCourses(services);
    items.push({
      label: "Courses",
      sublabel: "",
      value: "",
      dimmed: false,
      isSection: true,
    });
    for (const c of displayCourses) {
      items.push({
        label: c.name || c.courseCode,
        sublabel: c.name !== c.courseCode ? c.courseCode : "",
        value: `course:${c.id}`,
        dimmed: false,
        isSection: false,
      });
    }

    // Manage courses option
    items.push({
      label: "Manage courses",
      sublabel: "add, remove, or rename",
      value: "manage_courses",
      dimmed: true,
      isSection: false,
    });

    // Selectable items only (skip section headers)
    const selectableIndices = items
      .map((item, i) => (item.isSection ? -1 : i))
      .filter((i) => i >= 0);
    let selectedIdx = 0; // index into selectableIndices
    let filter = "";
    let scrollTop = 0; // lines scrolled from the top of content

    function getFiltered() {
      if (!filter) return { items, selectableIndices };
      const q = filter.toLowerCase();
      const filteredItems = items.filter(
        (item) =>
          item.isSection ||
          item.label.toLowerCase().includes(q) ||
          item.sublabel.toLowerCase().includes(q)
      );
      // Remove section headers with no items after them
      const cleaned: typeof items = [];
      for (let i = 0; i < filteredItems.length; i++) {
        if (filteredItems[i].isSection) {
          // Check if next non-section item exists
          if (
            i + 1 < filteredItems.length &&
            !filteredItems[i + 1].isSection
          ) {
            cleaned.push(filteredItems[i]);
          }
        } else {
          cleaned.push(filteredItems[i]);
        }
      }
      const selectable = cleaned
        .map((item, i) => (item.isSection ? -1 : i))
        .filter((i) => i >= 0);
      return { items: cleaned, selectableIndices: selectable };
    }

    function render(): void {
      const buf = createBuffer();
      hideCursor();
      const { cols: termCols, rows: termRows } = getTermSize();

      // Estimate content height to vertically center
      const artLines = CANVAS_ASCII.split("\n").filter((l) => l.trim()).length;
      const preFiltered = getFiltered();
      const itemLines = preFiltered.items.length + 4; // items + section headers + footer
      const boxLines = countInfoBoxLines(services, recent, termCols);
      const totalContent =
        artLines + boxLines + itemLines + 6 + HOME_TOP_MARGIN_ROWS;
      const topPad = Math.max(0, Math.floor((termRows - totalContent) / 2));

      for (let p = 0; p < HOME_TOP_MARGIN_ROWS; p++) buf.push("");
      for (let p = 0; p < topPad; p++) buf.push("");

      // ASCII art
      renderCenteredAscii(termCols, buf);

      // Info box (version is embedded in top border)
      buf.push("");
      renderInfoBox(services, recent, termCols, buf);
      buf.push("");

      // Search bar if filtering
      if (filter) {
        buf.push(C.dim("  search: ") + C.text(filter) + chalk.white("█"));
        buf.push("");
      }

      // Items list
      const filtered = getFiltered();
      const currentSelectableIdx =
        filtered.selectableIndices[selectedIdx] ?? -1;

      for (let i = 0; i < filtered.items.length; i++) {
        const item = filtered.items[i];

        if (item.isSection) {
          buf.push("");
          buf.push(C.primaryBold(`  ${item.label}`));
          continue;
        }

        const isSelected = i === currentSelectableIdx;
        const pointer = isSelected ? C.primary("❯ ") : "  ";
        const label = isSelected
          ? C.bold(item.label)
          : C.text(item.label);
        const sub = item.sublabel ? C.dim(` — ${item.sublabel}`) : "";
        buf.push(`  ${pointer}${label}${sub}`);
      }

      // Footer
      buf.push("");
      buf.push(
        C.dimmer("  ↑↓ navigate  enter select  esc quit  type to filter")
      );

      const totalLines = buf.length;
      const { rows: viewRows } = getTermSize();
      const maxScroll = Math.max(0, totalLines - viewRows);
      scrollTop = Math.min(scrollTop, maxScroll);
      const scrollFromBottom = maxScroll - scrollTop;
      buf.flush(0, scrollFromBottom);
    }

    render();
    enableMouseTracking();

    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    function onData(key: string): void {
      const filtered = getFiltered();

      // SGR mouse events: \x1B[<btn;col;rowM or \x1B[<btn;col;rowm
      const sgrMatch = key.match(/\x1B\[<(\d+);\d+;\d+[Mm]/);
      if (sgrMatch) {
        const btn = parseInt(sgrMatch[1], 10);
        if (btn === 64) {
          scrollTop = Math.max(0, scrollTop - 3);
          render();
        } else if (btn === 65) {
          scrollTop += 3;
          render();
        }
        return;
      }

      // Escape — quit
      if (key === "\x1B" || key === "\x1B\x1B") {
        cleanup();
        resolve(null);
        return;
      }

      // Enter — select
      if (key === "\r" || key === "\n") {
        if (filtered.selectableIndices.length > 0) {
          const itemIdx = filtered.selectableIndices[selectedIdx];
          const item = filtered.items[itemIdx];
          if (item && item.value) {
            cleanup();
            resolve(item.value);
            return;
          }
        }
      }

      // Arrow up
      if (key === "\x1B[A") {
        selectedIdx = Math.max(0, selectedIdx - 1);
        render();
        return;
      }

      // Arrow down
      if (key === "\x1B[B") {
        selectedIdx = Math.min(
          filtered.selectableIndices.length - 1,
          selectedIdx + 1
        );
        render();
        return;
      }

      // Backspace
      if (key === "\x7F" || key === "\b") {
        if (filter.length > 0) {
          filter = filter.slice(0, -1);
          selectedIdx = 0;
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
      if (key.length === 1 && key >= " ") {
        filter += key;
        selectedIdx = 0;
        render();
      }
    }

    function cleanup(): void {
      disableMouseTracking();
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      showCursor();
      clearScreen();
    }

    stdin.on("data", onData);
  });
}

// --- All Workspaces Screen ---

async function showAllWorkspaces(
  workspaces: Array<{ name: string; course: string; slug: string; path: string }>,
  services: AppServices
): Promise<string | null> {
  const items: PickerItem[] = [];

  for (const ws of workspaces) {
    items.push({
      label: ws.name,
      sublabel: ws.course,
      value: `workspace:${ws.path}`,
    });
  }

  items.push({
    label: "Manage workspaces",
    sublabel: "rename or delete",
    value: "manage_workspaces",
    dimmed: true,
  });

  const action = await showPicker({
    title: "All workspaces",
    subtitle: `${workspaces.length} workspaces`,
    items,
    filterable: true,
    backLabel: "back",
  });

  if (!action) return null;

  if (action === "manage_workspaces") {
    await manageWorkspaces(workspaces);
    return null; // return to home to refresh
  }

  return action;
}

async function manageWorkspaces(
  workspaces: Array<{ name: string; course: string; slug: string; path: string }>
): Promise<void> {
  const action = await showPicker({
    title: "Manage workspaces",
    items: [
      { label: "Delete a workspace", sublabel: "remove from disk", value: "delete" },
      { label: "Back", value: "back" },
    ],
    backLabel: "back",
  });

  if (!action || action === "back") return;

  if (action === "delete") {
    const toDelete = await showPicker({
      title: "Delete workspace",
      subtitle: "This permanently removes the workspace folder",
      items: workspaces.map((ws) => ({
        label: ws.name,
        sublabel: ws.course,
        value: ws.path,
      })),
      filterable: true,
      backLabel: "cancel",
    });

    if (toDelete) {
      const fs = await import("node:fs/promises");
      try {
        await fs.rm(toDelete, { recursive: true, force: true });
      } catch {
        // ignore errors
      }
    }
  }
}

// --- Info Box Renderer ---
// Strategy: build each row as PLAIN TEXT first, pad to exact width, then colorize.
// This avoids ANSI escape code length miscalculations.

function countInfoBoxLines(
  services: AppServices,
  recent: Array<{ name: string; course: string; slug: string; path: string }>,
  termCols: number,
): number {
  let count = 0;
  renderInfoBox(services, recent, termCols, { push: () => { count++; } });
  return count;
}

function renderInfoBox(
  services: AppServices,
  recent: Array<{ name: string; course: string; slug: string; path: string }>,
  termCols: number,
  buf: { push(line: string): void } = { push: (l) => console.log(l) }
): void {
  const schoolUrl = process.env.CANVAS_BASE_URL ?? "";
  let school = "unknown";
  try {
    const parsed = new URL(schoolUrl.replace("/api/v1", ""));
    school = parsed.hostname;
  } catch {
    school = schoolUrl.replace(/https?:\/\//, "").replace(/\/api\/v1.*/, "");
  }

  const aiModelText = services.aiConfig ? services.aiConfig.model : "not configured";
  const displayCourses = getDisplayCourses(services);
  const courseCount = `${displayCourses.length} active`;
  const workspaceCount = `${recent.length} active`;
  const systemSummary = formatSystemSummary();
  const toolAgentSummary = "9 tools · 2 agents";

  const commands: [string, string][] = [
    ["/overview", "quick assignment overview with the main goals, dates, and context"],
    ["/plan", "step-by-step action plan for how to approach and finish the work"],
    ["/resources", "important course files, links, and reference material for the assignment"],
    ["/evidence", "what is confirmed by the source material versus what is inferred"],
    ["/requirements", "deliverables, constraints, and the specific things you need to submit"],
    ["/status", "workspace summary, available files, and current assignment state"],
    ["/pin", "attach a workspace file to your prompt so the reply uses it directly"],
    ["/refresh", "re-fetch the latest course content from Canvas and rebuild the workspace"],
    ["/help", "full command list and a quick reminder of what each command does"],
  ];

  // Box width — keep the home box roomy without feeling overextended
  const boxInner = Math.min(termCols - 4, 98);

  /** Center box row; margins use default terminal bg, grey stays inside the borders. */
  function pushMenuRow(core: string): void {
    const w = stripAnsi(core).length;
    const gap = Math.max(0, termCols - w);
    const left = Math.floor(gap / 2);
    buf.push(" ".repeat(left) + core);
  }

  if (boxInner < 40) {
    pushMenuRow(
      MenuBox.secondary("  school: ") +
        MenuBox.dim(school) +
        MenuBox.secondary("  ·  courses: ") +
        MenuBox.dim(courseCount) +
        MenuBox.secondary("  ·  model: ") +
        MenuBox.dim(aiModelText)
    );
    return;
  }

  const leftW = Math.floor(boxInner * 0.40);
  const rightW = boxInner - leftW - 1;

  // --- Top border with centered version label ---
  const versionLabel = " v0.1.0 ";
  const topLineTotal = leftW + 1 + rightW + 2; // inner chars of top border
  const versionStart = Math.floor((topLineTotal - versionLabel.length) / 2);
  const topLeft = "─".repeat(Math.max(0, versionStart));
  const topRight = "─".repeat(Math.max(0, topLineTotal - versionStart - versionLabel.length));
  pushMenuRow(
    MenuBox.edge("╭") +
      MenuBox.edge(topLeft) +
      MenuBox.version(versionLabel) +
      MenuBox.edge(topRight) +
      MenuBox.edge("╮")
  );

  // Subtle inner top padding (~one row ≈ line-height; avoids large blank bands)
  pushMenuRow(
    MenuBox.edge("│") +
      MenuBox.fill(" ") +
      MenuBox.fill(" ".repeat(leftW)) +
      MenuBox.edge("│") +
      MenuBox.fill(" ") +
      MenuBox.fill(" ".repeat(rightW)) +
      MenuBox.edge("│")
  );

  // --- Build rows ---
  type LeftStyle = "kv" | "kvMuted" | "kvWarm" | "sectionHeader" | "desc" | "dim" | "empty";
  type RightStyle = "header" | "cmd" | "empty";
  type LeftRow = { text: string; style: LeftStyle };
  type RightRow = { text: string; style: RightStyle };
  const leftRows: LeftRow[] = [];
  const rightRows: RightRow[] = [];
  const commandStarts = new Map<string, number>();
  const pushLeft = (text: string, style: LeftStyle) => leftRows.push({ text, style });
  const pushRight = (text: string, style: RightStyle) => rightRows.push({ text, style });
  const pushCommand = (cmd: [string, string]) => {
    commandStarts.set(cmd[0], rightRows.length);
    for (const line of formatCmdRows(cmd, rightW)) {
      pushRight(line, "cmd");
    }
  };
  const padLeftToRow = (targetRow: number) => {
    while (leftRows.length < targetRow) pushLeft("", "empty");
  };

  // Helper to make a left cell that fits
  const L = (text: string) => truncPlain(text, leftW);
  const formatInfoRow = (label: string, value: string) =>
    L(`${label.padEnd(12)}${value}`);

  // Right column
  pushRight("Commands", "header");
  for (const cmd of commands) {
    pushCommand(cmd);
  }

  const statusRow = commandStarts.get("/status") ?? rightRows.length;
  const systemRow = Math.max(
    leftRows.length,
    (commandStarts.get("/evidence") ?? rightRows.length) - 1
  );
  const toolsRow = Math.max(
    leftRows.length,
    (commandStarts.get("/requirements") ?? rightRows.length) - 1
  );
  const refreshRow = commandStarts.get("/refresh") ?? rightRows.length;

  // Left column
  pushLeft(formatInfoRow("school", school), "kvWarm");
  pushLeft(formatInfoRow("model", aiModelText), "kvWarm");
  pushLeft("", "empty");
  pushLeft(formatInfoRow("courses", courseCount), "kvMuted");
  pushLeft(formatInfoRow("workspaces", workspaceCount), "kvMuted");
  padLeftToRow(systemRow);
  pushLeft(formatInfoRow("system", systemSummary), "kvMuted");
  padLeftToRow(toolsRow);
  pushLeft(toolAgentSummary, "dim");

  if (displayCourses.length > 0) {
    padLeftToRow(statusRow);
    pushLeft("Courses", "sectionHeader");
    const courseLines = wrapCommaList(
      displayCourses.slice(0, 5).map((c) => c.name || c.courseCode),
      leftW - 2
    );
    for (const cLine of courseLines) {
      pushLeft(cLine, "desc");
    }
  }

  if (recent.length > 0) {
    padLeftToRow(refreshRow);
    pushLeft("Recent Workspaces", "sectionHeader");
    for (let i = 0; i < recent.length; i++) {
      const wsName = truncPlain(recent[i].name, leftW - 2);
      pushLeft(wsName, wsName ? "desc" : "empty");
    }
  }

  const totalRows = Math.max(16, leftRows.length, rightRows.length);

  // --- Render rows ---
  for (let i = 0; i < totalRows; i++) {
    const leftRow = leftRows[i] ?? { text: "", style: "empty" as LeftStyle };
    const rightRow = rightRows[i] ?? { text: "", style: "empty" as RightStyle };
    const leftPadded = leftRow.text + " ".repeat(Math.max(0, leftW - leftRow.text.length));
    const rightPadded = rightRow.text + " ".repeat(Math.max(0, rightW - rightRow.text.length));

    const leftColored = colorizeCell(leftPadded, leftRow.style, true);
    const rightColored = colorizeCmdCell(rightPadded, rightRow.style, true);

    pushMenuRow(
      MenuBox.edge("│") +
        MenuBox.fill(" ") +
        leftColored +
        MenuBox.edge("│") +
        MenuBox.fill(" ") +
        rightColored +
        MenuBox.edge("│")
    );
  }

  // --- Bottom border (rounded corners; ┴ matches column split) ---
  pushMenuRow(
    MenuBox.edge("╰") +
      MenuBox.edge("─".repeat(leftW + 1)) +
      MenuBox.edge("┴") +
      MenuBox.edge("─".repeat(rightW + 1)) +
      MenuBox.edge("╯")
  );
}

function formatCmdRows(cmd: [string, string], maxW: number): string[] {
  const cmdColW = Math.min(16, Math.max(8, maxW - 12));
  const descW = Math.max(8, maxW - cmdColW);
  const descLines = wrapWords(cmd[1], descW);

  return descLines.map((line, index) =>
    index === 0 ? `${cmd[0].padEnd(cmdColW)}${line}` : `${" ".repeat(cmdColW)}${line}`
  );
}

function truncPlain(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

function wrapCommaList(items: string[], maxLen: number): string[] {
  if (items.length === 0) return [];

  const tokens = items.map((item, index) =>
    index < items.length - 1 ? `${item},` : item
  );
  const lines: string[] = [];
  let current = "";

  for (const token of tokens) {
    const candidate = current ? `${current} ${token}` : token;
    if (candidate.length <= maxLen) {
      current = candidate;
      continue;
    }

    if (current) lines.push(current);
    current = token.length <= maxLen ? token : truncPlain(token, maxLen);
  }

  if (current) lines.push(current);
  return lines;
}

function wrapWords(text: string, maxLen: number): string[] {
  if (!text) return [""];

  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxLen) {
      current = candidate;
      continue;
    }

    if (current) {
      lines.push(current);
      current = word.length <= maxLen ? word : truncPlain(word, maxLen);
    } else {
      lines.push(truncPlain(word, maxLen));
    }
  }

  if (current) lines.push(current);
  return lines;
}

function formatSystemSummary(): string {
  const memoryGb = Math.round(totalmem() / (1024 ** 3));
  const runtime = detectRuntimeLabel();
  return `${cpus().length} cores · ${memoryGb}GB · ${runtime}`;
}

function detectRuntimeLabel(): string {
  if (
    existsSync("/.dockerenv") ||
    process.env.CONTAINER ||
    process.env.DOCKER_CONTAINER
  ) {
    return "docker";
  }

  if (process.platform === "darwin") return "macOS";
  if (process.platform === "win32") return "windows";
  return process.platform;
}

type InfoBoxPalette = {
  secondary: (s: string) => string;
  dim: (s: string) => string;
  warm: (s: string) => string;
  text: (s: string) => string;
  bold: (s: string) => string;
  primary: (s: string) => string;
  primaryBold: (s: string) => string;
  fill: (s: string) => string;
};

const infoPalDefault: InfoBoxPalette = {
  secondary: (s) => C.muted(s),
  dim: (s) => C.dim(s),
  warm: (s) => C.warm(s),
  text: (s) => C.text(s),
  bold: (s) => C.bold(s),
  primary: (s) => C.primary(s),
  primaryBold: (s) => C.primaryBold(s),
  fill: (s) => s,
};

const infoPalMenu: InfoBoxPalette = {
  secondary: (s) => MenuBox.secondary(s),
  dim: (s) => MenuBox.dim(s),
  warm: (s) => C.warm(s),
  text: (s) => MenuBox.text(s),
  bold: (s) => MenuBox.bold(s),
  primary: (s) => MenuBox.primary(s),
  primaryBold: (s) => MenuBox.primaryBold(s),
  fill: (s) => MenuBox.fill(s),
};

function colorizeCell(paddedPlain: string, style: string, onMenuBox = false): string {
  const P = onMenuBox ? infoPalMenu : infoPalDefault;
  switch (style) {
    case "kv": {
      const match = paddedPlain.match(/^(\S+)(\s{2,})(.*)/);
      if (match) {
        return P.secondary(match[1]) + P.fill(match[2]) + P.dim(match[3]);
      }
      return P.text(paddedPlain);
    }
    case "kvMuted": {
      const match = paddedPlain.match(/^(\S+)(\s{2,})(.*)/);
      if (match) {
        return P.dim(match[1]) + P.fill(match[2]) + P.dim(match[3]);
      }
      return P.text(paddedPlain);
    }
    case "kvWarm": {
      const match = paddedPlain.match(/^(\S+)(\s{2,})(.*)/);
      if (match) {
        return P.secondary(match[1]) + P.fill(match[2]) + P.warm(match[3]);
      }
      return P.text(paddedPlain);
    }
    case "sectionHeader":
      return P.primaryBold(paddedPlain);
    case "desc":
      return P.secondary(paddedPlain);
    case "dim":
      return P.dim(paddedPlain);
    case "empty":
      return onMenuBox ? MenuBox.fill(paddedPlain) : paddedPlain;
    default:
      return P.text(paddedPlain);
  }
}

function colorizeCmdCell(paddedPlain: string, style: string, onMenuBox = false): string {
  const P = onMenuBox ? infoPalMenu : infoPalDefault;
  switch (style) {
    case "header":
      return P.primaryBold(paddedPlain);
    case "cmd": {
      const slashMatch = paddedPlain.match(/^(\/\S+)(\s+)(.*)/);
      if (slashMatch) {
        return P.primary(slashMatch[1]) + P.fill(slashMatch[2]) + P.secondary(slashMatch[3]);
      }
      const continuationMatch = paddedPlain.match(/^(\s+)(\S.*)/);
      if (continuationMatch) {
        return P.fill(continuationMatch[1]) + P.secondary(continuationMatch[2]);
      }
      const kvMatch = paddedPlain.match(/^(\S+)(\s{2,})(.*)/);
      if (kvMatch) {
        return P.primary(kvMatch[1]) + P.fill(kvMatch[2]) + P.secondary(kvMatch[3]);
      }
      return P.dim(paddedPlain);
    }
    case "empty":
      return onMenuBox ? MenuBox.fill(paddedPlain) : paddedPlain;
    default:
      return P.dim(paddedPlain);
  }
}

// --- ASCII Art Renderer ---

const MIN_ART_WIDTH = 60; // minimum terminal width to show ASCII art

function renderCenteredAscii(
  termCols: number,
  buf: { push(line: string): void } = { push: (l) => console.log(l) }
): void {
  const artLines = CANVAS_ASCII.split("\n").filter((l) => l.trim());
  const artWidth = Math.max(...artLines.map((l) => l.length));

  if (termCols < MIN_ART_WIDTH) {
    const simple = "  canvas";
    const padding = Math.max(0, Math.floor((termCols - simple.length) / 2));
    buf.push(" ".repeat(padding) + C.primaryBold(simple));
    return;
  }

  for (const line of artLines) {
    const padding = Math.max(0, Math.floor((termCols - artWidth) / 2));
    buf.push(" ".repeat(padding) + C.primary(line));
  }
}

function centerText(text: string, termCols: number): string {
  const visLen = stripAnsi(text).length;
  const padding = Math.max(0, Math.floor((termCols - visLen) / 2));
  return " ".repeat(padding) + text;
}

// stripAnsi imported from screen.ts

// --- Assignment Picker ---

async function showAssignmentPicker(
  services: AppServices,
  course: Course
): Promise<string | null> {
  clearScreen();
  console.log("");
  console.log(C.dim(`  loading assignments for ${course.courseCode}...`));

  let assignments;
  try {
    assignments = await fetchAssignments(services, course.id, course.name);
  } catch (err) {
    console.error(
      C.error(
        `  Error: ${err instanceof Error ? err.message : "unknown"}`
      )
    );
    return null;
  }

  if (assignments.length === 0) {
    console.log(C.dim("  No assignments found for this course."));
    await sleep(1500);
    return null;
  }

  const items: PickerItem[] = assignments.map((a) => ({
    label: a.name,
    sublabel:
      formatDueCompact(a.dueAt) + (a.submitted ? " · submitted" : ""),
    value: a.name,
    dimmed: a.submitted,
  }));

  return showPicker({
    title: course.courseCode || course.name,
    subtitle: `${assignments.length} assignments`,
    items,
    filterable: true,
    backLabel: "back",
  });
}

// --- Workspace Entry ---

async function enterNewWorkspace(
  services: AppServices,
  course: Course,
  assignmentName: string
): Promise<"back" | "courses" | "quit"> {
  // Loop handles /refresh — re-runs pipeline and re-enters workspace
  while (true) {
    clearScreen();
    console.log("");
    console.log(C.primaryBold(`  ${assignmentName}`));
    console.log(C.dim(`  ${course.name}`));
    console.log("");

    let wsData;
    try {
      wsData = await openWorkspace(
        services,
        course,
        assignmentName,
        (stage) => {
          console.log(`  ${C.dim("›")} ${C.dim(stage)}`);
        }
      );
    } catch (err) {
      console.error(
        C.error(
          `\n  Failed: ${err instanceof Error ? err.message : "unknown"}`
        )
      );
      showCursor();
      console.log(C.dim("\n  Press any key to continue..."));
      await waitForKey();
      return "back";
    }

    clearScreen();
    const courseDisplayName = findCourseDisplayName(services, wsData.loaded.courseName);
    const cache = await loadCourseCache(course.courseCode, course.id);
    const result = await runWorkspaceUI({
      workspacePath: wsData.workspacePath,
      workup: wsData.workup,
      loaded: wsData.loaded,
      aiConfig: services.aiConfig,
      courseDisplayName,
      agentContext: {
        cache,
        client: services.client,
        config: services.config,
        courseId: course.id,
      },
    });

    if (result === "refresh") {
      // Re-run ingest + work
      clearScreen();
      console.log("");
      console.log(C.primaryBold(`  Refreshing ${assignmentName}`));
      console.log(C.dim(`  ${course.name}`));
      console.log("");
      try {
        await refreshWorkspace(services, course, assignmentName, (stage) => {
          console.log(`  ${C.dim("›")} ${C.dim(stage)}`);
        });
      } catch (err) {
        console.error(
          C.error(`\n  Refresh failed: ${err instanceof Error ? err.message : "unknown"}`)
        );
        showCursor();
        console.log(C.dim("\n  Press any key to continue..."));
        await waitForKey();
      }
      // Loop back to re-enter workspace with fresh data
      continue;
    }

    return result;
  }
}

async function enterExistingWorkspace(
  wsPath: string,
  services: AppServices
): Promise<"back" | "courses" | "quit"> {
  while (true) {
    clearScreen();
    console.log(C.dim("\n  loading workspace..."));

    let loaded;
    try {
      loaded = await loadWorkspace(wsPath);
    } catch (err) {
      console.error(
        C.error(`\n  Failed to load workspace: ${err instanceof Error ? err.message : "unknown"}`)
      );
      await waitForKey();
      return "back";
    }

    let workup: AssignmentWorkup | null = null;
    if (loaded.workupJson) {
      workup = loaded.workupJson as unknown as AssignmentWorkup;
    }

    const courseDisplayName = findCourseDisplayName(services, loaded.courseName);
    let agentCache = null;
    let courseId: number | null = null;
    let matchedCourse: Course | null = null;

    // Find course from config or allCourses
    if (services.courseConfig) {
      const uc = services.courseConfig.courses.find(
        (c) => c.originalName === loaded.courseName
      );
      if (uc) {
        courseId = uc.id;
        agentCache = await loadCourseCache(uc.originalCode, uc.id);
        matchedCourse = services.allCourses.find((c) => c.id === uc.id) ?? null;
      }
    }

    clearScreen();
    const result = await runWorkspaceUI({
      workspacePath: wsPath,
      workup,
      loaded,
      aiConfig: services.aiConfig,
      courseDisplayName,
      agentContext: {
        cache: agentCache,
        client: services.client,
        config: services.config,
        courseId,
      },
    });

    if (result === "refresh" && matchedCourse) {
      clearScreen();
      console.log("");
      console.log(C.primaryBold(`  Refreshing ${loaded.assignmentName}`));
      console.log(C.dim(`  ${loaded.courseName}`));
      console.log("");
      try {
        const refreshed = await refreshWorkspace(
          services,
          matchedCourse,
          loaded.assignmentName,
          (stage) => console.log(`  ${C.dim("›")} ${C.dim(stage)}`)
        );
        wsPath = refreshed.workspacePath;
      } catch (err) {
        console.error(
          C.error(`\n  Refresh failed: ${err instanceof Error ? err.message : "unknown"}`)
        );
        showCursor();
        console.log(C.dim("\n  Press any key to continue..."));
        await waitForKey();
      }
      continue;
    }

    if (result === "refresh") {
      // Can't refresh without course info
      clearScreen();
      console.log(C.dim("\n  Cannot refresh — course not found in config."));
      await sleep(2000);
      continue;
    }

    return result;
  }
}

/**
 * Find the user's display name for a course by matching the original Canvas name.
 */
function findCourseDisplayName(services: AppServices, canvasCourseName: string): string | undefined {
  if (!services.courseConfig) return undefined;
  const match = services.courseConfig.courses.find(
    (c) => c.originalName === canvasCourseName || c.originalCode === canvasCourseName
  );
  return match?.displayName;
}

// --- Utilities ---

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForKey(): Promise<void> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.once("data", () => {
      stdin.setRawMode(false);
      stdin.pause();
      resolve();
    });
  });
}
