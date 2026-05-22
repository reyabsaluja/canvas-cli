import type { CommandDefinition, ScopeType } from "./chat-state.js";

export const COMMANDS: CommandDefinition[] = [
  { name: "/courses", description: "Open the course picker", scopes: ["global"], navigation: true },
  {
    name: "/manage-courses",
    description: "Add, remove, or rename courses",
    scopes: ["global", "course", "workspace"],
    navigation: true,
  },
  { name: "/recent", description: "Reopen a recent course or workspace", scopes: ["global"], navigation: true },
  {
    name: "/open",
    description: "Open a resource or file",
    scopes: ["global", "course", "workspace"],
  },
  { name: "/announcements", description: "Browse course announcements", scopes: ["global", "course"], navigation: true },
  { name: "/thread", description: "Read a discussion thread by ID or title", scopes: ["global", "course"] },
  {
    name: "/lecture",
    description: "Find and open lecture content",
    scopes: ["course", "workspace"],
    aliases: ["/lec"],
  },
  { name: "/assignments", description: "Open the assignment picker", scopes: ["course"], navigation: true },
  { name: "/files", description: "List cached course files", scopes: ["course"] },
  { name: "/modules", description: "List course modules", scopes: ["course"] },
  { name: "/overview", description: "Show assignment overview", scopes: ["workspace"] },
  {
    name: "/requirements",
    description: "Show deliverables and constraints",
    scopes: ["workspace"],
    aliases: ["/reqs"],
  },
  { name: "/plan", description: "Show the action plan", scopes: ["workspace"] },
  { name: "/resources", description: "Show key resources", scopes: ["workspace"] },
  { name: "/evidence", description: "Show confirmed vs inferred sources", scopes: ["workspace"] },
  { name: "/status", description: "Show workspace status", scopes: ["workspace"] },
  {
    name: "/clear",
    description: "Clear this chat and reset the current context",
    scopes: ["global", "course", "workspace"],
  },
  {
    name: "/copy",
    description: "Copy the last response (or 'all' / 'last N')",
    scopes: ["global", "course", "workspace"],
  },
  { name: "/refresh", description: "Refresh the current workspace", scopes: ["workspace"] },
  { name: "/back", description: "Go up one scope", scopes: ["course", "workspace"], navigation: true },
  {
    name: "/home",
    description: "Return to the global home session",
    scopes: ["course", "workspace"],
    navigation: true,
  },
  {
    name: "/help",
    description: "Show available commands",
    scopes: ["global", "course", "workspace"],
  },
  {
    name: "/pdf",
    description: "Generate a polished PDF from chat context",
    scopes: ["global", "course", "workspace"],
    aliases: ["/make-pdf"],
  },
  {
    name: "/model",
    description: "Switch AI model and effort",
    scopes: ["global", "course", "workspace"],
  },
  {
    name: "/login",
    description: "Re-run login setup",
    scopes: ["global", "course", "workspace"],
  },
  {
    name: "/quit",
    description: "Exit canvas-cli",
    scopes: ["global", "course", "workspace"],
    aliases: ["/exit", "/q"],
    navigation: true,
  },
];

export function getAvailableCommands(
  commands: CommandDefinition[],
  scope: ScopeType
): CommandDefinition[] {
  return commands.filter((command) => command.scopes.includes(scope));
}

export function resolveCommand(
  commands: CommandDefinition[],
  rawName: string
): CommandDefinition | null {
  return (
    commands.find(
      (command) =>
        command.name === rawName || (command.aliases ?? []).includes(rawName)
    ) ?? null
  );
}

export function formatScopeTargets(scopes: ScopeType[]): string {
  if (scopes.length === 1) {
    return scopeDisplay(scopes[0]);
  }
  if (scopes.length === 2) {
    return `${scopeDisplay(scopes[0])} or ${scopeDisplay(scopes[1])}`;
  }
  return scopes.map(scopeDisplay).join(", ");
}

function scopeDisplay(scope: ScopeType): string {
  switch (scope) {
    case "global":
      return "global scope. Try /courses or /recent";
    case "course":
      return "a course. Open a course first";
    case "workspace":
      return "a workspace. Open an assignment first";
  }
}
