/**
 * Per-model knowledge about how thinking depth is controlled.
 *
 * Providers expose different knobs (Anthropic adaptive thinking plus effort,
 * OpenAI reasoning effort, Gemini thinking levels, Bedrock reasoning config)
 * and each model accepts a different subset of levels. This module is the one
 * place that knows which, so the rest of the app can treat effort as a single
 * five-step scale and let each request round to what the model accepts.
 *
 * Sources (checked 2026-09-04): platform.claude.com effort + thinking docs,
 * developers.openai.com model pages, ai.google.dev thinking guide, and the
 * Bedrock model cards.
 */

import { describeCodexModel, listCodexModels, resolveCodexModel } from "./backends/codex-models.js";
import { EFFORT_LEVELS, isEffortLevel, type AIEffortLevel } from "./effort-levels.js";

export { EFFORT_LEVELS, isEffortLevel, type AIEffortLevel };

/** How a model's thinking depth is expressed on the wire. */
export type ThinkingControl =
  /** Anthropic 4.6 and later: `thinking: {type: "adaptive"}` plus the `effort` parameter. */
  | "adaptive"
  /** Anthropic before 4.6 (and Haiku 4.5): `thinking: {type: "enabled", budget_tokens}`. */
  | "extended"
  /** OpenAI and non-Claude Bedrock models: a reasoning-effort string. */
  | "reasoning-effort"
  /** Gemini: `thinkingConfig.thinkingLevel`. */
  | "thinking-level"
  /** Subscription CLIs: passed through as a flag; the CLI validates it. */
  | "cli";

export interface ModelCapabilities {
  control: ThinkingControl;
  /** Effort levels the model accepts, lowest to highest. Empty when effort cannot be set. */
  effortLevels: readonly AIEffortLevel[];
}

const ALL_LEVELS: readonly AIEffortLevel[] = EFFORT_LEVELS;
const LEVELS_WITHOUT_XHIGH: readonly AIEffortLevel[] = ["low", "medium", "high", "max"];
const LEVELS_UP_TO_XHIGH: readonly AIEffortLevel[] = ["low", "medium", "high", "xhigh"];
const LEVELS_UP_TO_HIGH: readonly AIEffortLevel[] = ["low", "medium", "high"];

type ClaudeFamily = "fable" | "mythos" | "opus" | "sonnet" | "haiku";

export interface ClaudeVersion {
  family: ClaudeFamily;
  /** Major version, or null for undated ids like `claude-mythos-preview`. */
  major: number | null;
  minor: number;
  preview: boolean;
}

/**
 * Strip Bedrock inference-profile prefixes (`us.`, `global.`, `anthropic.`),
 * Bedrock `-v1` / `-v1:0` suffixes and Vertex `@date` suffixes so every id
 * style parses the same way.
 */
export function normalizeClaudeId(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .replace(/^(?:us|eu|jp|au|apac|global)\./, "")
    .replace(/^anthropic\./, "")
    .replace(/-v\d+(?::\d+)?$/, "")
    .replace(/@\d{8}$/, "");
}

/** Parse a Claude model id into family and version, or null when it is not Claude. */
export function parseClaudeModel(modelId: string): ClaudeVersion | null {
  const id = normalizeClaudeId(modelId);
  const preview = /-preview\b/.test(id);

  // Current naming: claude-<family>-<major>[-<minor>][-<yyyymmdd>]
  const current = /^claude-(fable|mythos|opus|sonnet|haiku)(?:-(\d+)(?:-(\d{1,2}))?)?(?=-|$)/.exec(id);
  if (current) {
    return {
      family: current[1] as ClaudeFamily,
      major: current[2] ? Number(current[2]) : null,
      minor: current[3] ? Number(current[3]) : 0,
      preview,
    };
  }

  // Legacy naming: claude-<major>[-<minor>]-<family>[-<yyyymmdd>]
  const legacy = /^claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)(?=-|$)/.exec(id);
  if (legacy) {
    return {
      family: legacy[3] as ClaudeFamily,
      major: Number(legacy[1]),
      minor: legacy[2] ? Number(legacy[2]) : 0,
      preview,
    };
  }

  return null;
}

function claudeCapabilities(version: ClaudeVersion): ModelCapabilities {
  // Undated research previews (claude-mythos-preview) behave like the 5.x line.
  const major = version.major ?? 5;
  const generation = major + version.minor / 10;

  if (version.family === "fable" || version.family === "mythos" || major >= 5) {
    return { control: "adaptive", effortLevels: ALL_LEVELS };
  }
  if (version.family === "opus" && generation >= 4.7) {
    return { control: "adaptive", effortLevels: ALL_LEVELS };
  }
  if (generation >= 4.6) {
    // Opus 4.6 and Sonnet 4.6: adaptive thinking and effort, but no xhigh.
    return { control: "adaptive", effortLevels: LEVELS_WITHOUT_XHIGH };
  }
  // Haiku 4.5, Opus 4.5 and everything older: budget_tokens extended thinking.
  return { control: "extended", effortLevels: LEVELS_WITHOUT_XHIGH };
}

function openaiCapabilities(modelId: string): ModelCapabilities {
  const id = modelId.trim().toLowerCase();
  const gpt = /^gpt-(\d+)(?:\.(\d+))?/.exec(id);
  if (gpt) {
    const major = Number(gpt[1]);
    const minor = gpt[2] ? Number(gpt[2]) : 0;
    // GPT-5.6 and later accept none/low/medium/high/xhigh/max.
    if (major > 5 || (major === 5 && minor >= 6)) {
      return { control: "reasoning-effort", effortLevels: ALL_LEVELS };
    }
    // GPT-5.4 and GPT-5.5 accept up to xhigh.
    if (major === 5 && minor >= 4) {
      return { control: "reasoning-effort", effortLevels: LEVELS_UP_TO_XHIGH };
    }
  }
  // Older GPT-5.x, o-series and anything unrecognised: the classic three.
  return { control: "reasoning-effort", effortLevels: LEVELS_UP_TO_HIGH };
}

/**
 * Levels a Codex model accepts, from the CLI's own model catalog when it is
 * readable ("default" resolves to Codex's current default first); the full
 * scale otherwise so the CLI gets to validate whatever the user chose.
 */
function codexEffortLevels(modelId: string): readonly AIEffortLevel[] {
  const slug = resolveCodexModel(modelId);
  const levels = listCodexModels().find((m) => m.slug === slug)?.effortLevels;
  return levels && levels.length > 0 ? levels : ALL_LEVELS;
}

/**
 * What a model accepts for thinking depth. Unknown ids fall back to the most
 * conservative shape for their provider so a request still goes through.
 */
export function getModelCapabilities(provider: string, modelId: string): ModelCapabilities {
  switch (provider) {
    case "anthropic": {
      const version = parseClaudeModel(modelId);
      return version ? claudeCapabilities(version) : { control: "extended", effortLevels: LEVELS_WITHOUT_XHIGH };
    }
    case "bedrock": {
      const version = parseClaudeModel(modelId);
      if (version) return claudeCapabilities(version);
      return { control: "reasoning-effort", effortLevels: LEVELS_UP_TO_HIGH };
    }
    case "openai":
      return openaiCapabilities(modelId);
    case "google":
      // Every current Gemini model takes thinking_level low/medium/high.
      return { control: "thinking-level", effortLevels: LEVELS_UP_TO_HIGH };
    case "copilot":
      return { control: "cli", effortLevels: LEVELS_WITHOUT_XHIGH };
    case "codex":
      return { control: "cli", effortLevels: codexEffortLevels(modelId) };
    default:
      return { control: "cli", effortLevels: [] };
  }
}

/** Effort levels the picker should offer for a provider/model pair. */
export function supportedEffortLevels(provider: string, modelId: string): readonly AIEffortLevel[] {
  return getModelCapabilities(provider, modelId).effortLevels;
}

/**
 * Round an effort level to one the model accepts: the requested level if it is
 * supported, otherwise the next level up, otherwise the highest available.
 * Rounding up keeps the user's "think harder" intent when a model lacks a step.
 */
export function clampEffort(effort: AIEffortLevel, levels: readonly AIEffortLevel[]): AIEffortLevel | undefined {
  if (levels.length === 0) return undefined;
  if (levels.includes(effort)) return effort;
  const wanted = EFFORT_LEVELS.indexOf(effort);
  const above = levels.find((level) => EFFORT_LEVELS.indexOf(level) > wanted);
  return above ?? levels[levels.length - 1];
}

const OPENAI_TIER_WORDS: Record<string, string> = {
  pro: "Pro",
  mini: "Mini",
  nano: "Nano",
  codex: "Codex",
  chat: "Chat",
  latest: "Latest",
};

function titleWord(word: string): string {
  return OPENAI_TIER_WORDS[word] ?? word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Human-friendly name for a model id, derived from the id so new releases
 * read well without a lookup table: "claude-fable-5-1" -> "Fable 5.1",
 * "us.anthropic.claude-opus-5" -> "Opus 5", "gpt-5.6-terra" -> "GPT 5.6 Terra",
 * "gemini-3.8-flash" -> "Gemini 3.8 Flash". Codex's "default" names the model
 * it currently runs ("GPT 5.6 Sol (Codex default)") when the Codex CLI's model
 * catalog is readable. Unknown ids come back unchanged.
 */
export function deriveModelDisplayName(modelId: string): string {
  const id = modelId.trim();
  if (id === "auto") return "Copilot auto";
  if (id === "default") {
    // Codex's built-in default: name the model it currently resolves to.
    const codex = describeCodexModel(id);
    return codex ? `${deriveModelDisplayName(codex.slug)} (Codex default)` : "Codex default";
  }

  const claude = parseClaudeModel(id);
  if (claude) {
    const family = titleWord(claude.family);
    if (claude.major == null) return claude.preview ? `${family} Preview` : family;
    const version = claude.minor ? `${claude.major}.${claude.minor}` : `${claude.major}`;
    return claude.preview ? `${family} ${version} Preview` : `${family} ${version}`;
  }

  const gpt = /^gpt-(\d+(?:\.\d+)?)((?:-[a-z]+)*)(?:-\d{4}-\d{2}-\d{2})?$/i.exec(id);
  if (gpt) {
    const tiers = gpt[2].split("-").filter(Boolean).map(titleWord);
    return ["GPT", gpt[1], ...tiers].join(" ");
  }

  const gemini = /^gemini-(\d+(?:\.\d+)?)-([a-z-]+?)(?:-preview)?(?:-\d{2}-\d{4})?$/i.exec(id);
  if (gemini) {
    const tiers = gemini[2].split("-").filter(Boolean).map(titleWord);
    return ["Gemini", gemini[1], ...tiers].join(" ");
  }

  // A Codex slug the id derivation does not recognise: use the catalog's own name.
  const codex = describeCodexModel(id);
  if (codex) return codex.displayName;

  return id;
}
