import {
  CANVAS_TEXT,
  C,
  MenuBox,
  getTermSize,
  stripAnsi,
} from "./screen.js";
import {
  getDisplayCourseAvailability,
  type AppServices,
} from "./services.js";

type MenuLineBuffer = { push(line: string): void };

export function renderSplashLoading(): void {
  const { cols } = getTermSize();
  console.log("");
  renderCenteredAscii(cols);
  console.log("");
  console.log(centerText(C.dim("connecting to canvas..."), cols));
}

export function renderGlobalBanner(
  buf: { push(line?: string): void },
  services: AppServices,
  recent: Array<{ name: string; course: string }>
): void {
  const { cols } = getTermSize();
  renderCenteredAscii(cols, {
    push: (line: string) => buf.push(line),
  });
  buf.push("");
  renderInfoBox(
    services,
    recent.map((item) => ({ ...item, slug: "", path: "" })),
    [
      ["/courses", "browse your configured courses and move into a course session"],
      ["/manage-courses", "add, remove, or rename the courses shown in canvas-cli"],
      ["/recent", "reopen a recent course or workspace session"],
      ["/open", "jump directly to a course or recent workspace by name"],
      ["/announcements", "browse course announcements"],
      ["/clear", "clear this chat and reset the current context"],
      ["/quit", "exit canvas-cli"],
      ["/help", "full command list for the current scope"],
    ],
    cols,
    {
      push: (line: string) => buf.push(line),
    }
  );
}

function renderInfoBox(
  services: AppServices,
  recent: Array<{ name: string; course: string; slug: string; path: string }>,
  commands: [string, string][],
  termCols: number,
  buf: MenuLineBuffer = { push: (line) => console.log(line) }
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
  const availability = getDisplayCourseAvailability(services);
  const displayCourses = availability.available;
  const courseCount =
    availability.unavailable.length > 0
      ? `${displayCourses.length} active · ${availability.unavailable.length} unavailable`
      : `${displayCourses.length} active`;
  const workspaceCount = `${recent.length} active`;
  const systemSummary = formatAssignmentSummary(services);
  const toolAgentSummary = `${displayCourses.length} course${displayCourses.length === 1 ? "" : "s"} connected`;

  const boxInner = Math.min(termCols - 5, 98);

  function pushMenuRow(core: string): void {
    const width = stripAnsi(core).length;
    const gap = Math.max(0, termCols - width);
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

  const leftW = Math.floor(boxInner * 0.4);
  const rightW = boxInner - leftW - 1;

  const versionLabel = " v0.1.0 ";
  const topLineTotal = leftW + 1 + rightW + 2;
  const versionStart = Math.floor((topLineTotal - versionLabel.length) / 2);
  const topLeft = "─".repeat(Math.max(0, versionStart));
  const topRight = "─".repeat(
    Math.max(0, topLineTotal - versionStart - versionLabel.length)
  );
  pushMenuRow(
    MenuBox.edge("╭") +
      MenuBox.edge(topLeft) +
      MenuBox.version(versionLabel) +
      MenuBox.edge(topRight) +
      MenuBox.edge("╮")
  );

  pushMenuRow(
    MenuBox.edge("│") +
      MenuBox.fill(" ") +
      MenuBox.fill(" ".repeat(leftW)) +
      MenuBox.edge("│") +
      MenuBox.fill(" ") +
      MenuBox.fill(" ".repeat(rightW)) +
      MenuBox.edge("│")
  );

  type LeftStyle =
    | "kv"
    | "kvMuted"
    | "kvWarm"
    | "sectionHeader"
    | "desc"
    | "dim"
    | "empty";
  type RightStyle = "header" | "cmd" | "empty";
  type LeftRow = { text: string; style: LeftStyle };
  type RightRow = { text: string; style: RightStyle };
  const leftRows: LeftRow[] = [];
  const rightRows: RightRow[] = [];
  const commandStarts = new Map<string, number>();
  const pushLeft = (text: string, style: LeftStyle) => leftRows.push({ text, style });
  const pushRight = (text: string, style: RightStyle) => rightRows.push({ text, style });
  const pushCommand = (command: [string, string]) => {
    commandStarts.set(command[0], rightRows.length);
    for (const line of formatCmdRows(command, rightW)) {
      pushRight(line, "cmd");
    }
  };
  const padLeftToRow = (targetRow: number) => {
    while (leftRows.length < targetRow) pushLeft("", "empty");
  };

  const fitLeft = (text: string) => truncPlain(text, leftW);
  const formatInfoRow = (label: string, value: string) =>
    fitLeft(`${label.padEnd(12)}${value}`);

  pushRight("Commands", "header");
  for (const command of commands) {
    pushCommand(command);
  }

  const openRow = commandStarts.get("/open") ?? rightRows.length;
  const systemRow = Math.max(
    leftRows.length,
    (commandStarts.get("/recent") ?? rightRows.length) - 1
  ) + 1;

  pushLeft(formatInfoRow("school", school), "kvWarm");
  pushLeft(formatInfoRow("model", aiModelText), "kvWarm");
  pushLeft("", "empty");
  pushLeft(formatInfoRow("courses", courseCount), "kvMuted");
  pushLeft(formatInfoRow("workspaces", workspaceCount), "kvMuted");
  padLeftToRow(systemRow);
  pushLeft(formatInfoRow("status", systemSummary), "kvMuted");
  padLeftToRow(openRow);
  pushLeft(toolAgentSummary, "dim");

  if (displayCourses.length > 0) {
    pushLeft("", "empty");
    padLeftToRow(openRow);
    pushLeft("Courses", "sectionHeader");
    const courseLines = wrapCommaList(
      displayCourses.slice(0, 5).map((course) => course.name || course.courseCode),
      leftW - 2
    );
    for (const line of courseLines) {
      pushLeft(line, "desc");
    }
  }

  if (recent.length > 0) {
    if (displayCourses.length > 0) {
      pushLeft("", "empty");
    }
    const recentRow = Math.max(leftRows.length, rightRows.length - 3);
    padLeftToRow(recentRow);
    pushLeft("Recent Workspaces", "sectionHeader");
    for (const workspace of recent.slice(0, 3)) {
      const name = truncPlain(workspace.name, leftW - 2);
      pushLeft(name, name ? "desc" : "empty");
    }
  }

  const totalRows = Math.max(16, leftRows.length, rightRows.length);
  for (let index = 0; index < totalRows; index++) {
    const leftRow = leftRows[index] ?? { text: "", style: "empty" as LeftStyle };
    const rightRow = rightRows[index] ?? {
      text: "",
      style: "empty" as RightStyle,
    };
    const leftPadded =
      leftRow.text + " ".repeat(Math.max(0, leftW - leftRow.text.length));
    const rightPadded =
      rightRow.text + " ".repeat(Math.max(0, rightW - rightRow.text.length));

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

  pushMenuRow(
    MenuBox.edge("╰") +
      MenuBox.edge("─".repeat(leftW + 1)) +
      MenuBox.edge("┴") +
      MenuBox.edge("─".repeat(rightW + 1)) +
      MenuBox.edge("╯")
  );
}

function formatCmdRows(command: [string, string], maxW: number): string[] {
  const cmdColW = Math.min(16, Math.max(8, maxW - 12));
  const descW = Math.max(8, maxW - cmdColW);
  const descLines = wrapWords(command[1], descW);

  return descLines.map((line, index) =>
    index === 0
      ? `${command[0].padEnd(cmdColW)}${line}`
      : `${" ".repeat(cmdColW)}${line}`
  );
}

function truncPlain(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen);
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

function formatAssignmentSummary(services: AppServices): string {
  let total = 0;
  let upcoming = 0;
  const now = Date.now();
  const oneWeek = 7 * 24 * 60 * 60 * 1000;

  for (const [, assignments] of services.resolvedAssignments ?? []) {
    total += assignments.length;
    upcoming += assignments.filter(
      (a) => a.dueAt && a.dueAt.getTime() > now && a.dueAt.getTime() - now < oneWeek
    ).length;
  }

  if (total === 0) return "synced just now";
  return upcoming > 0
    ? `${total} assignments · ${upcoming} upcoming`
    : `${total} assignments`;
}

type InfoBoxPalette = {
  secondary: (value: string) => string;
  dim: (value: string) => string;
  warm: (value: string) => string;
  text: (value: string) => string;
  bold: (value: string) => string;
  primary: (value: string) => string;
  primaryBold: (value: string) => string;
  fill: (value: string) => string;
};

const infoPalDefault: InfoBoxPalette = {
  secondary: (value) => C.muted(value),
  dim: (value) => C.dim(value),
  warm: (value) => C.warm(value),
  text: (value) => C.text(value),
  bold: (value) => C.bold(value),
  primary: (value) => C.primary(value),
  primaryBold: (value) => C.primaryBold(value),
  fill: (value) => value,
};

const infoPalMenu: InfoBoxPalette = {
  secondary: (value) => MenuBox.secondary(value),
  dim: (value) => MenuBox.dim(value),
  warm: (value) => C.warm(value),
  text: (value) => MenuBox.text(value),
  bold: (value) => MenuBox.bold(value),
  primary: (value) => MenuBox.primary(value),
  primaryBold: (value) => MenuBox.primaryBold(value),
  fill: (value) => MenuBox.fill(value),
};

function colorizeCell(
  paddedPlain: string,
  style: string,
  onMenuBox = false
): string {
  const palette = onMenuBox ? infoPalMenu : infoPalDefault;
  switch (style) {
    case "kv": {
      const match = paddedPlain.match(/^(\S+)(\s{2,})(.*)/);
      if (match) {
        return (
          palette.secondary(match[1]!) +
          palette.fill(match[2]!) +
          palette.dim(match[3]!)
        );
      }
      return palette.text(paddedPlain);
    }
    case "kvMuted": {
      const match = paddedPlain.match(/^(\S+)(\s{2,})(.*)/);
      if (match) {
        return (
          palette.dim(match[1]!) +
          palette.fill(match[2]!) +
          palette.dim(match[3]!)
        );
      }
      return palette.text(paddedPlain);
    }
    case "kvWarm": {
      const match = paddedPlain.match(/^(\S+)(\s{2,})(.*)/);
      if (match) {
        return (
          palette.secondary(match[1]!) +
          palette.fill(match[2]!) +
          palette.warm(match[3]!)
        );
      }
      return palette.text(paddedPlain);
    }
    case "sectionHeader":
      return C.pureWhiteBold(paddedPlain);
    case "desc":
      return palette.secondary(paddedPlain);
    case "dim":
      return palette.dim(paddedPlain);
    case "empty":
      return onMenuBox ? MenuBox.fill(paddedPlain) : paddedPlain;
    default:
      return palette.text(paddedPlain);
  }
}

function colorizeCmdCell(
  paddedPlain: string,
  style: string,
  onMenuBox = false
): string {
  const palette = onMenuBox ? infoPalMenu : infoPalDefault;
  switch (style) {
    case "header":
      return C.pureWhiteBold(paddedPlain);
    case "cmd": {
      const slashMatch = paddedPlain.match(/^(\/\S+)(\s+)(.*)/);
      if (slashMatch) {
        return (
          C.pureWhite(slashMatch[1]!) +
          palette.fill(slashMatch[2]!) +
          palette.secondary(slashMatch[3]!)
        );
      }
      const continuationMatch = paddedPlain.match(/^(\s+)(\S.*)/);
      if (continuationMatch) {
        return (
          palette.fill(continuationMatch[1]!) +
          palette.secondary(continuationMatch[2]!)
        );
      }
      const kvMatch = paddedPlain.match(/^(\S+)(\s{2,})(.*)/);
      if (kvMatch) {
        return (
          palette.primary(kvMatch[1]!) +
          palette.fill(kvMatch[2]!) +
          palette.secondary(kvMatch[3]!)
        );
      }
      return palette.dim(paddedPlain);
    }
    case "empty":
      return onMenuBox ? MenuBox.fill(paddedPlain) : paddedPlain;
    default:
      return palette.dim(paddedPlain);
  }
}

const MIN_ART_WIDTH = 60;

function renderCenteredAscii(
  termCols: number,
  buf: { push(line: string): void } = { push: (line) => console.log(line) }
): void {
  const textLines = CANVAS_TEXT;
  const textWidth = Math.max(...textLines.map((l) => l.length));

  if (termCols < MIN_ART_WIDTH) {
    const simple = "  canvas";
    const padding = Math.max(0, Math.floor((termCols - simple.length) / 2));
    buf.push(" ".repeat(padding) + C.primaryBold(simple));
    return;
  }

  for (const line of textLines) {
    const pad = Math.max(0, Math.floor((termCols - textWidth) / 2));
    buf.push(" ".repeat(pad) + C.primary(line));
  }
}

function centerText(text: string, termCols: number): string {
  const visibleLen = stripAnsi(text).length;
  const padding = Math.max(0, Math.floor((termCols - visibleLen) / 2));
  return " ".repeat(padding) + text;
}
