import chalk from "chalk";
import { hideCursor, showCursor, createBuffer, clearScreen, enterAlternateScreen, leaveAlternateScreen, getTermSize, padAnsiToWidth, buildLogoBanner, C } from "./screen.js";
import { USER_ABORT_EXIT_CODE } from "./chat-shell-exit.js";
import type { Course } from "../domain/models.js";
import type { UserCourse, CourseConfig } from "./course-config.js";
import { saveCourseConfig } from "./course-config.js";

/**
 * Multi-select picker — user toggles courses with space, confirms with enter.
 * Returns the selected courses.
 */
export function showMultiSelect(
  title: string,
  subtitle: string,
  courses: Course[]
): Promise<Course[]> {
  return new Promise((resolve) => {
    let selected = 0;
    let filter = "";
    let message = "";
    const checked = new Set<number>();

    function getFiltered(): Course[] {
      if (!filter) return courses;
      const q = filter.toLowerCase();
      return courses.filter(
        (c) =>
          c.courseCode.toLowerCase().includes(q) ||
          c.name.toLowerCase().includes(q)
      );
    }

    let windowStart = 0;

    function render(): void {
      const buf = createBuffer();
      const filtered = getFiltered();
      if (selected >= filtered.length)
        selected = Math.max(0, filtered.length - 1);

      const { rows, cols } = getTermSize();
      const cardWidth = cols - 6;
      const innerWidth = cardWidth - 2;
      const linesPerItem = 3;
      const bannerLines = buildLogoBanner(title, subtitle);
      const bannerHeight = bannerLines.length + 2;
      const reservedRows = bannerHeight + 8 + (message ? 2 : 0);
      const visibleCount = Math.max(2, Math.floor((rows - reservedRows) / linesPerItem));

      if (selected < windowStart) windowStart = selected;
      if (selected >= windowStart + visibleCount) windowStart = selected - visibleCount + 1;
      const maxWindowStart = Math.max(0, filtered.length - visibleCount);
      windowStart = Math.max(0, Math.min(windowStart, maxWindowStart));
      const windowEnd = Math.min(filtered.length, windowStart + visibleCount);
      const visibleItems = filtered.slice(windowStart, windowEnd);

      buf.push("");
      for (const line of bannerLines) buf.push(line);
      buf.push("");

      const isSearchActive = filter.length > 0;
      const searchBorder = isSearchActive ? C.primary : C.text;
      const searchInner = isSearchActive
        ? C.primary("⌕ ") + C.primary(filter) + chalk.hex("#e82429").bold("█")
        : C.dim("⌕ ") + C.dim("Search...");
      const searchLine = padAnsiToWidth(searchInner, innerWidth);
      buf.push(searchBorder("  ╭" + "─".repeat(cardWidth) + "╮"));
      buf.push(`  ${searchBorder("│")} ${searchLine} ${searchBorder("│")}`);
      buf.push(searchBorder("  ╰" + "─".repeat(cardWidth) + "╯"));
      buf.push("");

      if (filtered.length === 0) {
        buf.push(C.dim("  No courses match your search."));
      } else {
        if (windowStart > 0) {
          buf.push(C.dim(`  ↑ ${windowStart} more above`));
        }

        for (let i = 0; i < visibleItems.length; i++) {
          const c = visibleItems[i]!;
          const absoluteIndex = windowStart + i;
          const isSel = absoluteIndex === selected;
          const isChecked = checked.has(c.id);

          const borderColor = isSel ? C.text : C.dimmer;
          const top = borderColor("  ┌" + "─".repeat(cardWidth) + "┐");
          const bot = borderColor("  └" + "─".repeat(cardWidth) + "┘");
          const edge = borderColor("│");

          const checkIcon = isChecked ? C.success("◉ ") : C.dim("○ ");
          const label = isSel
            ? C.bold(c.courseCode || c.name)
            : C.text(c.courseCode || c.name);
          const sub =
            c.courseCode !== c.name
              ? (isSel ? C.text(` · ${c.name}`) : C.dim(` · ${c.name}`))
              : "";
          const labelLine = padAnsiToWidth(`${checkIcon}${label}${sub}`, innerWidth);

          buf.push(top);
          buf.push(`  ${edge} ${labelLine} ${edge}`);
          buf.push(bot);
        }

        const remaining = filtered.length - windowEnd;
        if (remaining > 0) {
          buf.push(C.dim(`  ↓ ${remaining} more below`));
        }
      }

      buf.push("");
      if (message) {
        buf.push(C.warn(`  ${message}`));
        buf.push("");
      }
      const count = checked.size;
      const doneHint = count > 0
        ? C.pureWhite("d") + C.success(` done (${count} selected)`)
        : C.pureWhite("d") + C.dimmer(` done (${count} selected)`);
      buf.push(
        "  " + C.pureWhite("enter/space") + C.dimmer(" toggle  ") + C.pureWhite("↑↓") + C.dimmer(" navigate  ") + doneHint + "  " + C.dimmer("type to filter")
      );

      buf.flush();
    }

    enterAlternateScreen();
    clearScreen();
    hideCursor();
    render();

    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    function toggle(): void {
      const filtered = getFiltered();
      if (filtered.length > 0 && selected < filtered.length) {
        const c = filtered[selected]!;
        if (checked.has(c.id)) {
          checked.delete(c.id);
        } else {
          checked.add(c.id);
        }
        message = "";
        render();
      }
    }

    function onData(key: string): void {
      const filtered = getFiltered();

      // Enter or Space — toggle the current item
      if (key === "\r" || key === "\n" || key === " ") {
        toggle();
        return;
      }

      // d — done/confirm (only if at least 1 selected)
      if (key === "d" || key === "D") {
        if (checked.size > 0) {
          cleanup();
          resolve(courses.filter((c) => checked.has(c.id)));
          return;
        }
        message = "Select at least one course first";
        render();
        return;
      }

      // Arrow up
      if (key === "\x1B[A") {
        selected = Math.max(0, selected - 1);
        message = "";
        render();
        return;
      }

      // Arrow down
      if (key === "\x1B[B") {
        selected = Math.min(filtered.length - 1, selected + 1);
        message = "";
        render();
        return;
      }

      // Backspace
      if (key === "\x7F" || key === "\b") {
        if (filter.length > 0) {
          filter = filter.slice(0, -1);
          selected = 0;
          message = "";
          render();
        }
        return;
      }

      // Escape — cancel (return empty)
      if (key === "\x1B") {
        cleanup();
        resolve([]);
        return;
      }

      // Ctrl+C
      if (key === "\x03") {
        cleanup();
        process.exit(USER_ABORT_EXIT_CODE);
      }

      // Regular character for filtering (skip 'd' since it's the done key)
      if (key.length === 1 && key > " " && key !== "d" && key !== "D") {
        filter += key;
        selected = 0;
        message = "";
        render();
      }
    }

    function cleanup(): void {
      stdin.removeListener("data", onData);
      try {
        stdin.setRawMode(false);
      } catch {}
      try {
        stdin.pause();
      } catch {}
      leaveAlternateScreen();
      clearScreen();
      showCursor();
    }

    stdin.on("data", onData);
  });
}

/**
 * Prompt the user to optionally rename each selected course.
 * Uses a dedicated readline interface that properly handles stdin.
 */
export async function promptRenames(
  selected: Course[]
): Promise<UserCourse[]> {
  const result: UserCourse[] = [];

  for (let idx = 0; idx < selected.length; idx++) {
    const course = selected[idx]!;
    const displayLabel = course.courseCode || course.name;
    const fullName = course.courseCode !== course.name ? course.name : "";

    clearScreen();
    showCursor();

    const { cols } = getTermSize();
    const cardWidth = Math.min(cols - 6, 70);
    const innerWidth = cardWidth - 2;
    const border = C.secondary;

    console.log("");
    for (const line of buildLogoBanner("Rename your courses", "Give them short names, or press enter to keep the original")) {
      console.log(line);
    }
    console.log("");

    for (const done of result) {
      console.log(
        "  " + C.success("✓ ") + C.success(done.displayName) +
        (done.originalCode !== done.displayName ? C.dim(` ← ${done.originalCode}`) : "")
      );
    }
    if (result.length > 0) console.log("");

    console.log(C.dim(`  Course ${idx + 1} of ${selected.length}`));
    console.log("");

    console.log(border("  ┌" + "─".repeat(cardWidth) + "┐"));
    const courseInfo = C.bold(displayLabel) + (fullName ? C.dim(` — ${fullName}`) : "");
    console.log(`  ${border("│")} ${padAnsiToWidth(courseInfo, innerWidth)} ${border("│")}`);
    console.log(border("  └" + "─".repeat(cardWidth) + "┘"));
    console.log("");

    const newName = await promptLine(
      "  " + C.primary("❯ ") + C.dim("new name: ")
    );

    result.push({
      id: course.id,
      originalCode: course.courseCode,
      originalName: course.name,
      displayName: newName.trim() || displayLabel,
    });
  }

  clearScreen();
  showCursor();
  const { cols } = getTermSize();

  console.log("");
  for (const line of buildLogoBanner("Courses renamed")) {
    console.log(line);
  }
  console.log("");
  for (const done of result) {
    console.log(
      "  " + C.success("✓ ") + C.success(done.displayName) +
      (done.originalCode !== done.displayName ? C.dim(` ← ${done.originalCode}`) : "")
    );
  }
  console.log("");
  await sleep(1200);

  return result;
}

/**
 * Run the full first-run course setup flow.
 */
export async function runCourseSetup(
  allCourses: Course[]
): Promise<CourseConfig> {
  const selected = await showMultiSelect(
    "Welcome to canvas",
    "Select your courses — space to toggle, enter when done",
    allCourses
  );

  if (selected.length === 0) {
    // No courses selected — save empty config but let them know
    clearScreen();
    showCursor();
    console.log("");
    console.log(
      C.dim("  No courses selected. Use 'Manage courses' to add some later.")
    );
    console.log("");
    await sleep(2000);
    const config: CourseConfig = { courses: [] };
    await saveCourseConfig(config);
    return config;
  }

  const userCourses = await promptRenames(selected);
  const config: CourseConfig = { courses: userCourses };
  await saveCourseConfig(config);
  return config;
}

/**
 * Course management menu — add, remove, rename.
 */
export async function runCourseManagement(
  currentConfig: CourseConfig,
  allCanvasCourses: Course[]
): Promise<CourseConfig> {
  const { showPicker } = await import("./picker.js");

  const action = await showPicker({
    title: "Manage courses",
    subtitle: "Add, remove, or rename courses in your configuration",
    items: [
      {
        label: "Add courses",
        description: "Browse and select from your Canvas enrollments",
        value: "add",
      },
      {
        label: "Remove a course",
        description: `Remove from your configured list (${currentConfig.courses.length} configured)`,
        value: "remove",
        dimmed: currentConfig.courses.length === 0,
      },
      {
        label: "Rename a course",
        description: "Set a custom display name for a course",
        value: "rename",
        dimmed: currentConfig.courses.length === 0,
      },
      {
        label: "Back",
        description: "Return to the home screen",
        value: "back",
      },
    ],
    backLabel: "back",
  });

  if (!action || action === "back") return currentConfig;

  if (action === "add") {
    const existingIds = new Set(currentConfig.courses.map((c) => c.id));
    const available = allCanvasCourses.filter((c) => !existingIds.has(c.id));

    if (available.length === 0) {
      clearScreen();
      console.log(C.dim("\n  All Canvas courses are already added.\n"));
      await sleep(1500);
      return currentConfig;
    }

    const selected = await showMultiSelect(
      "Add courses",
      "Select courses to add — space to toggle, enter when done",
      available
    );

    if (selected.length === 0) return currentConfig;

    const userCourses = await promptRenames(selected);
    const updated: CourseConfig = {
      courses: [...currentConfig.courses, ...userCourses],
    };
    await saveCourseConfig(updated);
    return updated;
  }

  if (action === "remove") {
    if (currentConfig.courses.length === 0) return currentConfig;

    const toRemove = await showPicker({
      title: "Remove a course",
      subtitle: "Select a course to remove from your list",
      items: currentConfig.courses.map((c) => ({
        label: c.displayName,
        sublabel: c.originalCode !== c.displayName ? c.originalCode : c.originalName,
        value: String(c.id),
      })),
      backLabel: "cancel",
    });

    if (toRemove) {
      const updated: CourseConfig = {
        courses: currentConfig.courses.filter(
          (c) => String(c.id) !== toRemove
        ),
      };
      await saveCourseConfig(updated);
      return updated;
    }

    return currentConfig;
  }

  if (action === "rename") {
    if (currentConfig.courses.length === 0) return currentConfig;

    const toRename = await showPicker({
      title: "Rename a course",
      subtitle: "Select a course to rename",
      items: currentConfig.courses.map((c) => ({
        label: c.displayName,
        sublabel: c.originalCode !== c.displayName ? c.originalCode : c.originalName,
        value: String(c.id),
      })),
      backLabel: "cancel",
    });

    if (toRename) {
      const course = currentConfig.courses.find(
        (c) => String(c.id) === toRename
      );
      if (course) {
        clearScreen();
        showCursor();

        const { cols } = getTermSize();
        const cardWidth = Math.min(cols - 6, 70);
        const innerWidth = cardWidth - 2;
        const border = C.secondary;

        console.log("");
        for (const line of buildLogoBanner("Rename course")) {
          console.log(line);
        }
        console.log("");

        console.log(border("  ┌" + "─".repeat(cardWidth) + "┐"));
        const courseInfo = C.bold(course.displayName) +
          (course.originalCode !== course.displayName ? C.dim(` (${course.originalCode})`) : "");
        console.log(`  ${border("│")} ${padAnsiToWidth(courseInfo, innerWidth)} ${border("│")}`);
        console.log(border("  └" + "─".repeat(cardWidth) + "┘"));
        console.log("");

        const newName = await promptLine(
          "  " + C.primary("❯ ") + C.dim("new name: ")
        );

        if (newName.trim()) {
          const updated: CourseConfig = {
            courses: currentConfig.courses.map((c) =>
              String(c.id) === toRename
                ? { ...c, displayName: newName.trim() }
                : c
            ),
          };
          await saveCourseConfig(updated);

          clearScreen();
          console.log("");
          for (const line of buildLogoBanner("Course renamed")) {
            console.log(line);
          }
          console.log("");
          console.log(
            "  " + C.success("✓ ") +
            C.text("Renamed to ") + C.success(newName.trim())
          );
          console.log("");
          await sleep(1200);

          return updated;
        }
      }
    }

    return currentConfig;
  }

  return currentConfig;
}

// --- Helpers ---

function promptLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    let value = "";
    const stdin = process.stdin;

    if (stdin.isPaused()) stdin.resume();
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    hideCursor();

    const redraw = (): void => {
      const line = prompt + C.pureWhite(value) + C.pureWhite("█");
      process.stdout.write(`\r\x1B[2K${line}`);
    };

    redraw();

    const onData = (key: string): void => {
      if (key === "\r" || key === "\n") {
        stdin.removeListener("data", onData);
        stdin.setRawMode(false);
        stdin.pause();
        showCursor();
        const line = prompt + C.pureWhite(value);
        process.stdout.write(`\r\x1B[2K${line}\n`);
        resolve(value);
        return;
      }

      if (key === "\x03") {
        stdin.removeListener("data", onData);
        stdin.setRawMode(false);
        showCursor();
        process.exit(USER_ABORT_EXIT_CODE);
      }

      if (key === "\x7F" || key === "\b") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          redraw();
        }
        return;
      }

      if (key === "\x1B") return;
      if (key.startsWith("\x1B[")) return;

      if (key.length === 1 && key >= " ") {
        value += key;
        redraw();
      }
    };

    stdin.on("data", onData);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
