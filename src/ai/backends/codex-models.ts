import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EFFORT_LEVELS, isEffortLevel, type AIEffortLevel } from "../effort-levels.js";

/**
 * The Codex CLI's model catalog.
 *
 * Codex keeps the models a ChatGPT plan offers in `$CODEX_HOME/models_cache.json`
 * (CODEX_HOME defaults to ~/.codex) and refreshes it whenever the CLI runs.
 * canvas-cli runs Codex with `--ignore-user-config`, so a stored model of
 * "default" means Codex's own built-in default, which its event stream never
 * names. The CLI exposes no command that prints that default either, so this
 * module treats the first visible model by priority as the default, which is
 * what the CLI itself picks with no config.
 *
 * Every reader here returns null or an empty list when the cache is missing,
 * unreadable, or not shaped as expected; nothing throws.
 */

export const CODEX_MODEL_CACHE_FILE = "models_cache.json";

/** One entry of the cache, normalised. */
export interface CodexCacheModel {
  slug: string;
  /** The cache's display_name in the app's style: "GPT-5.6-Sol" -> "GPT 5.6 Sol". */
  displayName: string;
  description: string;
  defaultEffort: AIEffortLevel | null;
  /** Levels the model accepts, restricted to the app's scale and in its order. */
  effortLevels: readonly AIEffortLevel[];
  visible: boolean;
  priority: number;
}

export interface CodexModelCache {
  path: string;
  fetchedAt: string | null;
  clientVersion: string | null;
  /** Every model in the file, including hidden ones, in file order. */
  models: CodexCacheModel[];
}

/** A visible model as offered to pickers. */
export interface CodexModel {
  slug: string;
  displayName: string;
  description: string;
  defaultEffort: AIEffortLevel | null;
  effortLevels: readonly AIEffortLevel[];
}

export interface CodexModelDescription {
  slug: string;
  displayName: string;
  /** True when the id looked up was the literal "default". */
  isDefault: boolean;
}

const CODEX_DEFAULT_ID = "default";

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.CODEX_HOME?.trim();
  return explicit ? explicit : join(homedir(), ".codex");
}

function codexModelCachePath(env: NodeJS.ProcessEnv): string {
  return join(codexHome(env), CODEX_MODEL_CACHE_FILE);
}

/** "GPT-5.6-Sol" -> "GPT 5.6 Sol"; anything not in that style is kept as is. */
function normalizeDisplayName(name: string): string {
  return /^gpt-/i.test(name) ? name.replace(/-/g, " ") : name;
}

function parseModel(raw: unknown): CodexCacheModel | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.slug !== "string" || !entry.slug.trim()) return null;
  const slug = entry.slug.trim();

  const supported = new Set<string>();
  if (Array.isArray(entry.supported_reasoning_levels)) {
    for (const level of entry.supported_reasoning_levels) {
      const effort = (level as { effort?: unknown } | null)?.effort;
      if (typeof effort === "string") supported.add(effort);
    }
  }
  const effortLevels = EFFORT_LEVELS.filter((level) => supported.has(level));
  const defaultEffort = isEffortLevel(entry.default_reasoning_level) ? entry.default_reasoning_level : null;

  return {
    slug,
    displayName: typeof entry.display_name === "string" && entry.display_name.trim()
      ? normalizeDisplayName(entry.display_name.trim())
      : slug,
    description: typeof entry.description === "string" ? entry.description.trim() : "",
    defaultEffort,
    effortLevels,
    visible: entry.visibility === "list",
    priority: typeof entry.priority === "number" && Number.isFinite(entry.priority) ? entry.priority : Number.MAX_SAFE_INTEGER,
  };
}

function parseCache(path: string, text: string): CodexModelCache | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const raw = parsed as Record<string, unknown>;
  if (!Array.isArray(raw.models)) return null;
  const models = raw.models.map(parseModel).filter((m): m is CodexCacheModel => m !== null);
  return {
    path,
    fetchedAt: typeof raw.fetched_at === "string" ? raw.fetched_at : null,
    clientVersion: typeof raw.client_version === "string" ? raw.client_version : null,
    models,
  };
}

// Memoised per path and mtime so a header redraw costs one stat, not a parse.
const memo = new Map<string, { mtimeMs: number; size: number; value: CodexModelCache | null }>();

export function resetCodexModelCacheForTests(): void {
  memo.clear();
}

/** Parsed `$CODEX_HOME/models_cache.json`, or null when it is missing or unusable. */
export function readCodexModelCache(env: NodeJS.ProcessEnv = process.env): CodexModelCache | null {
  let path: string;
  try {
    path = codexModelCachePath(env);
  } catch {
    return null;
  }
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    const cached = memo.get(path);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value;
    const value = parseCache(path, readFileSync(path, "utf8"));
    memo.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  } catch {
    return null;
  }
}

/** Models the user's plan offers, in Codex's own order (ascending priority). */
export function listCodexModels(env: NodeJS.ProcessEnv = process.env): CodexModel[] {
  const cache = readCodexModelCache(env);
  if (!cache) return [];
  return cache.models
    .filter((m) => m.visible)
    .sort((a, b) => a.priority - b.priority)
    .map(({ slug, displayName, description, defaultEffort, effortLevels }) => ({
      slug,
      displayName,
      description,
      defaultEffort,
      effortLevels,
    }));
}

/** Codex's current default: the first visible model by priority, or null without a cache. */
export function defaultCodexModel(env: NodeJS.ProcessEnv = process.env): CodexModel | null {
  return listCodexModels(env)[0] ?? null;
}

/**
 * The concrete slug to run: "default" becomes Codex's current default when the
 * cache can say what that is; every other id (and "default" without a cache)
 * comes back unchanged.
 */
export function resolveCodexModel(modelId: string, env: NodeJS.ProcessEnv = process.env): string {
  if (modelId.trim() !== CODEX_DEFAULT_ID) return modelId;
  return defaultCodexModel(env)?.slug ?? modelId;
}

/** Look up a stored model id ("default" or a slug) in the catalog; null when unknown or hidden. */
export function describeCodexModel(modelId: string, env: NodeJS.ProcessEnv = process.env): CodexModelDescription | null {
  const id = modelId.trim();
  if (id === CODEX_DEFAULT_ID) {
    const model = defaultCodexModel(env);
    return model ? { slug: model.slug, displayName: model.displayName, isDefault: true } : null;
  }
  const model = listCodexModels(env).find((m) => m.slug === id);
  return model ? { slug: model.slug, displayName: model.displayName, isDefault: false } : null;
}
