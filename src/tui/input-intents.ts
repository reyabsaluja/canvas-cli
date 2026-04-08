import type { CommandDefinition, ScopeType } from "./chat-state.js";

export interface ImplicitCommandIntent {
  commandName: string;
  args: string;
}

export function resolveImplicitCommandIntent(
  input: string,
  availableCommands: CommandDefinition[],
  scope: ScopeType
): ImplicitCommandIntent | null {
  if (scope === "global") {
    return null;
  }

  const openCommand = availableCommands.find((command) => command.name === "/open");
  if (!openCommand) {
    return null;
  }

  const match = input.match(/^\s*open(?:\s+(.*))?\s*$/i);
  if (!match) {
    return null;
  }

  return {
    commandName: "/open",
    args: (match[1] ?? "").trim(),
  };
}
