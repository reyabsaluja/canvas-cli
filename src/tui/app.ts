import { showPicker, type PickerItem } from "./picker.js";
import { runWorkspaceUI } from "./workspace-ui.js";
import {
  initServices,
  fetchAssignments,
  openWorkspace,
  getRecentWorkspaces,
  formatDueCompact,
  type AppServices,
} from "./services.js";
import { loadWorkspace } from "../ask/load-workspace.js";
import {
  clearScreen,
  showCursor,
  hideCursor,
  CANVAS_ASCII,
  C,
  getTermSize,
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

  // Pre-fetch recent workspaces
  const recent = await getRecentWorkspaces();

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
        if (action.startsWith("course:")) {
          const courseId = action.slice("course:".length);
          selectedCourse =
            services.courses.find((c) => String(c.id) === courseId) ?? null;
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
    const { cols } = getTermSize();

    // Build the item list: recent workspaces first, then courses
    const items: Array<{
      label: string;
      sublabel: string;
      value: string;
      dimmed: boolean;
      isSection: boolean;
    }> = [];

    // Recent workspaces
    if (recent.length > 0) {
      items.push({
        label: "Recent",
        sublabel: "",
        value: "",
        dimmed: false,
        isSection: true,
      });
      for (const ws of recent.slice(0, 4)) {
        items.push({
          label: ws.name,
          sublabel: ws.course,
          value: `workspace:${ws.path}`,
          dimmed: false,
          isSection: false,
        });
      }
    }

    // Courses
    items.push({
      label: "Courses",
      sublabel: "",
      value: "",
      dimmed: false,
      isSection: true,
    });
    for (const c of services.courses) {
      items.push({
        label: c.courseCode || c.name,
        sublabel: c.courseCode !== c.name ? c.name : "",
        value: `course:${c.id}`,
        dimmed: false,
        isSection: false,
      });
    }

    // Selectable items only (skip section headers)
    const selectableIndices = items
      .map((item, i) => (item.isSection ? -1 : i))
      .filter((i) => i >= 0);
    let selectedIdx = 0; // index into selectableIndices
    let filter = "";

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
      clearScreen();
      hideCursor();
      const termCols = getTermSize().cols;

      // ASCII art
      console.log("");
      renderCenteredAscii(termCols);

      // Version + divider
      const versionLine = `v0.1.0`;
      console.log(centerText(C.dim(versionLine), termCols));
      console.log("");

      // Info box
      renderInfoBox(services, recent, termCols);
      console.log("");

      // Search bar if filtering
      if (filter) {
        console.log(
          C.dim("  search: ") + C.text(filter) + C.dim("│")
        );
        console.log("");
      }

      // Items list
      const filtered = getFiltered();
      const currentSelectableIdx =
        filtered.selectableIndices[selectedIdx] ?? -1;

      for (let i = 0; i < filtered.items.length; i++) {
        const item = filtered.items[i];

        if (item.isSection) {
          console.log("");
          console.log(C.primaryBold(`  ${item.label}`));
          continue;
        }

        const isSelected = i === currentSelectableIdx;
        const pointer = isSelected ? C.primary("❯ ") : "  ";
        const label = isSelected
          ? C.bold(item.label)
          : C.text(item.label);
        const sub = item.sublabel ? C.dim(` — ${item.sublabel}`) : "";
        console.log(`  ${pointer}${label}${sub}`);
      }

      // Footer
      console.log("");
      console.log(
        C.dimmer("  ↑↓ navigate  enter select  esc quit  type to filter")
      );
    }

    render();

    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    function onData(key: string): void {
      const filtered = getFiltered();

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
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      showCursor();
      clearScreen();
    }

    stdin.on("data", onData);
  });
}

// --- Info Box Renderer ---

function renderInfoBox(
  services: AppServices,
  recent: Array<{ name: string; course: string; slug: string; path: string }>,
  termCols: number
): void {
  // Extract school domain from CANVAS_BASE_URL
  const schoolUrl = process.env.CANVAS_BASE_URL ?? "";
  let school = "unknown";
  try {
    const parsed = new URL(schoolUrl.replace("/api/v1", ""));
    school = parsed.hostname;
  } catch {
    school = schoolUrl.replace(/https?:\/\//, "").replace(/\/api\/v1.*/, "");
  }

  const aiModel = services.aiConfig
    ? C.text("claude-sonnet-4")
    : C.dim("not configured");

  const courseCount = `${services.courses.length} active`;

  // Right column: commands
  const commands = [
    ["/overview", "show assignment overview"],
    ["/plan", "action plan and steps"],
    ["/resources", "key documents and files"],
    ["/evidence", "confirmed vs inferred sources"],
    ["/requirements", "deliverables and constraints"],
    ["/help", "all available commands"],
  ];

  // Calculate box width
  const boxWidth = Math.min(termCols - 4, 78);
  const leftColWidth = Math.floor(boxWidth * 0.4);
  const rightColWidth = boxWidth - leftColWidth - 3; // 3 for separator

  // Top border
  console.log(
    C.dimmer(`  ┌${"─".repeat(boxWidth)}┐`)
  );

  // Build rows
  const leftLines: string[] = [];
  const rightLines: string[] = [];

  // Left column content
  leftLines.push(`${C.dim("school  ")} ${C.text(school)}`);
  leftLines.push(`${C.dim("courses ")} ${C.text(courseCount)}`);
  leftLines.push(`${C.dim("model   ")} ${aiModel}`);
  leftLines.push("");

  if (recent.length > 0) {
    leftLines.push(C.bold("Recent"));
    for (const ws of recent.slice(0, 3)) {
      const name = ws.name.length > leftColWidth - 4
        ? ws.name.slice(0, leftColWidth - 7) + "..."
        : ws.name;
      leftLines.push(C.dim(name));
    }
  }

  // Right column content
  rightLines.push(C.bold("Commands"));
  for (const [cmd, desc] of commands) {
    rightLines.push(
      `${C.accent(cmd.padEnd(16))}${C.dim(desc)}`
    );
  }

  // Render rows side by side
  const maxRows = Math.max(leftLines.length, rightLines.length);
  for (let i = 0; i < maxRows; i++) {
    const left = leftLines[i] ?? "";
    const right = rightLines[i] ?? "";

    // We need to calculate visible length for padding (strip ANSI)
    const leftVisible = stripAnsi(left);
    const rightVisible = stripAnsi(right);

    const leftPad = Math.max(0, leftColWidth - leftVisible.length);
    const rightPad = Math.max(0, rightColWidth - rightVisible.length);

    console.log(
      C.dimmer("  │ ") +
        left +
        " ".repeat(leftPad) +
        C.dimmer(" │ ") +
        right +
        " ".repeat(rightPad) +
        C.dimmer(" │")
    );
  }

  // Bottom border
  console.log(
    C.dimmer(`  └${"─".repeat(boxWidth)}┘`)
  );
}

// --- ASCII Art Renderer ---

function renderCenteredAscii(termCols: number): void {
  const artLines = CANVAS_ASCII.split("\n").filter((l) => l.trim());

  // Find the max line length in the ASCII art
  const artWidth = Math.max(...artLines.map((l) => l.length));

  for (const line of artLines) {
    const padding = Math.max(0, Math.floor((termCols - artWidth) / 2));
    console.log(" ".repeat(padding) + C.primary(line));
  }
}

function centerText(text: string, termCols: number): string {
  const visLen = stripAnsi(text).length;
  const padding = Math.max(0, Math.floor((termCols - visLen) / 2));
  return " ".repeat(padding) + text;
}

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*m/g, "");
}

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
  return runWorkspaceUI({
    workspacePath: wsData.workspacePath,
    workup: wsData.workup,
    loaded: wsData.loaded,
    aiConfig: services.aiConfig,
  });
}

async function enterExistingWorkspace(
  wsPath: string,
  services: AppServices
): Promise<"back" | "courses" | "quit"> {
  clearScreen();
  console.log(C.dim("\n  loading workspace..."));

  try {
    const loaded = await loadWorkspace(wsPath);
    let workup: AssignmentWorkup | null = null;
    if (loaded.workupJson) {
      workup = loaded.workupJson as unknown as AssignmentWorkup;
    }

    clearScreen();
    return runWorkspaceUI({
      workspacePath: wsPath,
      workup,
      loaded,
      aiConfig: services.aiConfig,
    });
  } catch (err) {
    console.error(
      C.error(
        `\n  Failed to load workspace: ${err instanceof Error ? err.message : "unknown"}`
      )
    );
    await waitForKey();
    return "back";
  }
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
