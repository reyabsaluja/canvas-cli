import chalk from "chalk";
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
import { clearScreen, showCursor } from "./screen.js";
import type { Course } from "../domain/models.js";
import type { AssignmentWorkup } from "../work/types.js";

/**
 * Main interactive TUI application.
 * State machine: HOME → COURSE_PICKER → ASSIGNMENT_PICKER → WORKSPACE
 */
export async function launchApp(): Promise<void> {
  // Handle clean exit
  process.on("SIGINT", () => {
    showCursor();
    clearScreen();
    process.exit(0);
  });

  clearScreen();
  console.log("");
  console.log(chalk.bold.cyan("  canvas-cli"));
  console.log(chalk.dim("  Loading courses..."));

  let services: AppServices;
  try {
    services = await initServices();
  } catch (err) {
    showCursor();
    console.error(
      chalk.red(
        `\n  Failed to connect: ${err instanceof Error ? err.message : "unknown error"}`
      )
    );
    console.error(
      chalk.dim("  Check your CANVAS_BASE_URL and CANVAS_ACCESS_TOKEN in .env")
    );
    process.exit(1);
  }

  let state: "home" | "courses" | "assignments" | "workspace" = "home";
  let selectedCourse: Course | null = null;

  // Main loop
  while (true) {
    switch (state) {
      case "home": {
        const action = await showHomeScreen(services);
        if (action === null) {
          showCursor();
          return; // exit
        }
        if (action === "courses") {
          state = "courses";
        } else if (action.startsWith("workspace:")) {
          const wsPath = action.slice("workspace:".length);
          const result = await enterExistingWorkspace(
            wsPath,
            services
          );
          if (result === "courses") {
            state = "courses";
          } else if (result === "back") {
            state = "home";
          }
          // "quit" falls through to exit
          else if (result === "quit") {
            showCursor();
            return;
          }
        }
        break;
      }

      case "courses": {
        const course = await showCoursePicker(services);
        if (course === null) {
          state = "home";
          break;
        }
        selectedCourse = course;
        state = "assignments";
        break;
      }

      case "assignments": {
        if (!selectedCourse) {
          state = "courses";
          break;
        }
        const result = await showAssignmentPicker(services, selectedCourse);
        if (result === null) {
          state = "courses";
          break;
        }
        // result is the assignment name — enter workspace
        const wsResult = await enterNewWorkspace(
          services,
          selectedCourse,
          result
        );
        if (wsResult === "back") {
          state = "assignments";
        } else if (wsResult === "courses") {
          state = "courses";
        } else {
          showCursor();
          return; // quit
        }
        break;
      }
    }
  }
}

// --- Home Screen ---

async function showHomeScreen(
  services: AppServices
): Promise<string | null> {
  const items: PickerItem[] = [];

  // Recent workspaces
  const recent = await getRecentWorkspaces();
  if (recent.length > 0) {
    for (const ws of recent.slice(0, 5)) {
      items.push({
        label: ws.name,
        sublabel: ws.course,
        value: `workspace:${ws.path}`,
      });
    }
    items.push({
      label: "Browse courses",
      sublabel: `${services.courses.length} current courses`,
      value: "courses",
      dimmed: true,
    });
  } else {
    items.push({
      label: "Browse courses",
      sublabel: `${services.courses.length} current courses`,
      value: "courses",
    });
  }

  return showPicker({
    title: "canvas-cli",
    subtitle: recent.length > 0 ? "Recent workspaces" : "Get started",
    items,
    backLabel: "quit",
  });
}

// --- Course Picker ---

async function showCoursePicker(
  services: AppServices
): Promise<Course | null> {
  const items: PickerItem[] = services.courses.map((c) => ({
    label: c.courseCode || c.name,
    sublabel: c.courseCode !== c.name ? c.name : undefined,
    value: String(c.id),
  }));

  const selected = await showPicker({
    title: "Select a course",
    items,
    filterable: true,
    backLabel: "back",
  });

  if (selected === null) return null;
  return services.courses.find((c) => String(c.id) === selected) ?? null;
}

// --- Assignment Picker ---

async function showAssignmentPicker(
  services: AppServices,
  course: Course
): Promise<string | null> {
  clearScreen();
  console.log("");
  console.log(chalk.dim(`  Loading assignments for ${course.courseCode}...`));

  let assignments;
  try {
    assignments = await fetchAssignments(services, course.id, course.name);
  } catch (err) {
    console.error(chalk.red(`  Error: ${err instanceof Error ? err.message : "unknown"}`));
    return null;
  }

  if (assignments.length === 0) {
    console.log(chalk.dim("  No assignments found for this course."));
    await sleep(1500);
    return null;
  }

  const items: PickerItem[] = assignments.map((a) => ({
    label: a.name,
    sublabel: formatDueCompact(a.dueAt) + (a.submitted ? " | submitted" : ""),
    value: a.name,
    dimmed: a.submitted,
  }));

  return showPicker({
    title: course.courseCode || course.name,
    subtitle: `${assignments.length} assignments`,
    items,
    filterable: true,
    backLabel: "back to courses",
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
  console.log(chalk.bold.cyan(`  ${assignmentName}`));
  console.log(chalk.dim(`  ${course.name}`));
  console.log("");

  let wsData;
  try {
    wsData = await openWorkspace(services, course, assignmentName, (stage) => {
      console.log(`  ${chalk.dim("›")} ${stage}`);
    });
  } catch (err) {
    console.error(
      chalk.red(
        `\n  Failed: ${err instanceof Error ? err.message : "unknown"}`
      )
    );
    console.log(chalk.dim("  Press any key to continue..."));
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
  console.log(chalk.dim("\n  Loading workspace..."));

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
      chalk.red(
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
