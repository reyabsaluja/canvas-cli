import type { ShellPinOption } from "./app-types.js";

export interface ResolvedPinReferences {
  resolved: ShellPinOption[];
  missing: string[];
  ambiguous: Array<{ query: string; matches: ShellPinOption[] }>;
}

export interface ExtractedPins extends ResolvedPinReferences {
  cleanInput: string;
}

export function resolvePinReferences(
  queries: string[],
  options: ShellPinOption[]
): ResolvedPinReferences {
  const resolved: ShellPinOption[] = [];
  const missing: string[] = [];
  const ambiguous: Array<{ query: string; matches: ShellPinOption[] }> = [];

  for (const query of queries) {
    const normalized = query.trim().toLowerCase();
    if (!normalized) continue;

    const exactMatches = options.filter((pin) => pin.label === normalized);
    if (exactMatches.length === 1) {
      pushUnique(resolved, exactMatches[0]!);
      continue;
    }

    const prefixMatches = options.filter((pin) =>
      pin.label.startsWith(normalized)
    );
    if (prefixMatches.length === 1) {
      pushUnique(resolved, prefixMatches[0]!);
      continue;
    }
    if (prefixMatches.length > 1) {
      ambiguous.push({ query: normalized, matches: prefixMatches });
      continue;
    }

    const containsMatches = options.filter((pin) =>
      pin.label.includes(normalized)
    );
    if (containsMatches.length === 1) {
      pushUnique(resolved, containsMatches[0]!);
      continue;
    }
    if (containsMatches.length > 1) {
      ambiguous.push({ query: normalized, matches: containsMatches });
      continue;
    }

    missing.push(normalized);
  }

  return { resolved, missing, ambiguous };
}

export function extractInlinePins(
  input: string,
  options: ShellPinOption[]
): ExtractedPins {
  const queries: string[] = [];
  const cleanInput = input.replace(/@(\S+)/g, (_match, query: string) => {
    queries.push(query);
    return " ";
  });

  const result = resolvePinReferences(queries, options);
  return {
    ...result,
    cleanInput: cleanInput.replace(/\s+/g, " ").trim(),
  };
}

export function mergePinOptions(
  existing: ShellPinOption[],
  next: ShellPinOption[]
): ShellPinOption[] {
  const merged = [...existing];
  for (const pin of next) {
    pushUnique(merged, pin);
  }
  return merged;
}

function pushUnique(options: ShellPinOption[], pin: ShellPinOption): void {
  if (!options.some((option) => option.label === pin.label)) {
    options.push(pin);
  }
}
