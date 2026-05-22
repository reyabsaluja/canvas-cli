import { generateText, streamText, tool, jsonSchema, stepCountIs, RetryError } from "ai";
import { APICallError } from "@ai-sdk/provider";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { debugAI } from "../debug.js";
import { ensureAICredentials } from "../config/load-credentials-to-env.js";

export type AIProviderName = "anthropic" | "openai" | "google" | "bedrock";

export type AIEffortLevel = "low" | "medium" | "high" | "max";

export interface AIProviderConfig {
  provider: AIProviderName;
  model: string;
  effort?: AIEffortLevel;
}

export interface EffortOptions {
  providerOptions?: {
    openai?: { reasoningEffort: string };
    anthropic?: { thinking: { type: "enabled"; budgetTokens: number } };
    bedrock?: { reasoningConfig: { type: "enabled"; budgetTokens: number } };
  };
}

export const AI_PROVIDER_SETUP_HINT =
  "Set AI_PROVIDER to anthropic, openai, google/gemini, or bedrock and add the matching credentials to your .env file (see .env.example).";

const DEFAULT_RATE_LIMIT_RETRY_MS = 30_000;
const DEFAULT_UNAVAILABLE_RETRY_MS = 15_000;

const DEFAULT_MODEL_BY_PROVIDER: Record<AIProviderName, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.4",
  google: "gemini-3.5-flash",
  bedrock: "us.anthropic.claude-sonnet-4-6",
};

/**
 * Detect which AI provider is configured from environment variables.
 * Honors AI_PROVIDER first, then falls back to legacy key-based detection.
 * Model can be overridden with AI_MODEL env var.
 */
export function getAIConfig(): AIProviderConfig | null {
  ensureAICredentials();
  const providerOverride = normalizeAIProvider(process.env.AI_PROVIDER);
  const modelOverride = process.env.AI_MODEL;
  const hasExplicitProvider =
    typeof process.env.AI_PROVIDER === "string" && process.env.AI_PROVIDER.trim().length > 0;

  if (hasExplicitProvider) {
    if (!providerOverride) {
      return null;
    }
    return getExplicitAIConfig(providerOverride, modelOverride);
  }

  if (process.env.ANTHROPIC_API_KEY) {
    return buildAIConfig("anthropic", modelOverride);
  }

  if (process.env.OPENAI_API_KEY) {
    return buildAIConfig("openai", modelOverride);
  }

  if (process.env.GOOGLE_API_KEY) {
    return buildAIConfig("google", modelOverride);
  }

  return null;
}

function normalizeAIProvider(value: string | undefined): AIProviderName | null {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "anthropic":
      return "anthropic";
    case "openai":
      return "openai";
    case "google":
    case "gemini":
      return "google";
    case "bedrock":
    case "aws-bedrock":
    case "amazon-bedrock":
      return "bedrock";
    default:
      return null;
  }
}

function buildAIConfig(
  provider: AIProviderName,
  modelOverride?: string
): AIProviderConfig {
  const effortRaw = process.env.AI_EFFORT?.toLowerCase();
  const effort = (effortRaw === "low" || effortRaw === "medium" || effortRaw === "high" || effortRaw === "max")
    ? effortRaw as AIEffortLevel
    : undefined;
  return {
    provider,
    model: modelOverride ?? DEFAULT_MODEL_BY_PROVIDER[provider],
    ...(effort && provider !== "google" ? { effort } : {}),
  };
}

function getExplicitAIConfig(
  provider: AIProviderName,
  modelOverride?: string
): AIProviderConfig | null {
  if (provider === "bedrock") {
    return buildAIConfig(provider, modelOverride);
  }

  switch (provider) {
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY
        ? buildAIConfig(provider, modelOverride)
        : null;
    case "openai":
      return process.env.OPENAI_API_KEY
        ? buildAIConfig(provider, modelOverride)
        : null;
    case "google":
      return process.env.GOOGLE_API_KEY
        ? buildAIConfig(provider, modelOverride)
        : null;
  }
}

const EFFORT_TO_OPENAI_REASONING: Record<AIEffortLevel, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  max: "high",
};

const EFFORT_TO_THINKING_BUDGET: Record<AIEffortLevel, number> = {
  low: 2048,
  medium: 4096,
  high: 10000,
  max: 32000,
};

export function getEffortOptions(config: AIProviderConfig): EffortOptions {
  if (!config.effort) return {};

  if (config.provider === "openai") {
    const mapped = EFFORT_TO_OPENAI_REASONING[config.effort];
    if (mapped !== config.effort) {
      debugAI(config.provider, config.model, `effort "${config.effort}" clamped to "${mapped}"`);
    }
    return {
      providerOptions: {
        openai: { reasoningEffort: mapped },
      },
    };
  }

  if (config.provider === "anthropic") {
    return {
      providerOptions: {
        anthropic: {
          thinking: { type: "enabled", budgetTokens: EFFORT_TO_THINKING_BUDGET[config.effort] },
        },
      },
    };
  }

  if (config.provider === "bedrock") {
    return {
      providerOptions: {
        bedrock: {
          reasoningConfig: { type: "enabled", budgetTokens: EFFORT_TO_THINKING_BUDGET[config.effort] },
        },
      },
    };
  }

  return {};
}

function getModel(config: AIProviderConfig) {
  switch (config.provider) {
    case "anthropic": {
      const anthropic = createAnthropic({
        apiKey: process.env.ANTHROPIC_API_KEY!,
      });
      return anthropic(config.model);
    }
    case "openai": {
      const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
      return openai(config.model);
    }
    case "google": {
      const google = createGoogleGenerativeAI({
        apiKey: process.env.GOOGLE_API_KEY!,
      });
      return google(config.model);
    }
    case "bedrock": {
      const bedrock = createAmazonBedrock({
        apiKey: process.env.AWS_BEARER_TOKEN_BEDROCK,
        region: process.env.AWS_REGION,
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        sessionToken: process.env.AWS_SESSION_TOKEN,
      });
      return bedrock(config.model);
    }
  }
}

/**
 * Call the AI model with a system prompt and user message.
 * Returns the text response.
 */
export async function callModel(
  config: AIProviderConfig,
  systemPrompt: string,
  userMessage: string,
  options?: { maxTokens?: number; timeoutMs?: number; abortSignal?: AbortSignal; onTextDelta?: (delta: string) => void }
): Promise<string> {
  debugAI(config.provider, config.model, "callModel starting", {
    maxTokens: options?.maxTokens ?? null,
    streaming: Boolean(options?.onTextDelta),
    promptLength: systemPrompt.length + userMessage.length,
  });
  const startTime = Date.now();

  const signals: AbortSignal[] = [];
  if (options?.abortSignal) signals.push(options.abortSignal);
  if (options?.timeoutMs) signals.push(AbortSignal.timeout(options.timeoutMs));
  const combinedSignal = signals.length > 0
    ? (signals.length === 1 ? signals[0]! : AbortSignal.any(signals))
    : undefined;

  const effortOpts = getEffortOptions(config);

  if (options?.onTextDelta) {
    const stream = streamText({
      model: getModel(config),
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      ...(options.maxTokens != null ? { maxTokens: options.maxTokens } : {}),
      ...(combinedSignal ? { abortSignal: combinedSignal } : {}),
      ...effortOpts,
    });
    let text = "";
    for await (const delta of stream.textStream) {
      text += delta;
      options.onTextDelta(delta);
    }
    debugAI(config.provider, config.model, "callModel completed (stream)", {
      durationMs: Date.now() - startTime,
      responseLength: text.length,
    });
    return text;
  }

  const result = await generateText({
    model: getModel(config),
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    ...(options?.maxTokens != null ? { maxTokens: options.maxTokens } : {}),
    ...(combinedSignal ? { abortSignal: combinedSignal } : {}),
    ...effortOpts,
  });

  debugAI(config.provider, config.model, "callModel completed", {
    durationMs: Date.now() - startTime,
    responseLength: result.text.length,
    usage: result.usage ?? null,
  });

  return result.text;
}

/** Provider-agnostic tool definition with an execute function. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GenerateWithToolsResult {
  text: string;
  /** All messages from this interaction (for appending to conversation history). */
  responseMessages: any[];
}

/**
 * Execute tool-calling generation with the AI SDK's built-in tool loop.
 *
 * Accepts a message history for multi-turn conversations.
 * Returns the response text + response messages for accumulating context.
 */
export async function generateWithTools(
  config: AIProviderConfig,
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
  toolDefs: ToolDefinition[],
  executeTool: (
    name: string,
    input: Record<string, unknown>
  ) => Promise<string>,
  onToolCall?: (name: string, input: Record<string, unknown>, result: string) => void,
  maxSteps: number = 10
): Promise<GenerateWithToolsResult> {
  debugAI(config.provider, config.model, "generateWithTools starting", {
    tools: toolDefs.map((t) => t.name),
    messageCount: messages.length,
    maxSteps,
  });
  const startTime = Date.now();

  const aiTools: Record<string, any> = {};
  for (const t of toolDefs) {
    aiTools[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.parameters as any),
      execute: async (input: any) => {
        debugAI(config.provider, config.model, `tool call: ${t.name}`);
        const result = await executeTool(t.name, input);
        onToolCall?.(t.name, input, result);
        return result;
      },
    } as any);
  }

  const result = await generateText({
    model: getModel(config),
    system: systemPrompt,
    messages: messages as any,
    tools: aiTools,
    stopWhen: stepCountIs(maxSteps),
    ...getEffortOptions(config),
  } as any);

  debugAI(config.provider, config.model, "generateWithTools completed", {
    durationMs: Date.now() - startTime,
    responseLength: result.text.length,
    usage: result.usage ?? null,
  });

  return {
    text: result.text,
    responseMessages: result.response.messages ?? [],
  };
}

/**
 * Stream tool-calling generation. Tool calls execute synchronously and
 * fire onToolCall. The final text response streams token-by-token via onTextDelta.
 *
 * Returns the complete text when done.
 */
export async function streamWithTools(
  config: AIProviderConfig,
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
  toolDefs: ToolDefinition[],
  executeTool: (name: string, input: Record<string, unknown>) => Promise<string>,
  callbacks: {
    onToolCall?: (name: string, input: Record<string, unknown>, result: string) => void;
    onTextDelta?: (delta: string) => void;
    abortSignal?: AbortSignal;
  },
  maxSteps: number = 10
): Promise<string> {
  debugAI(config.provider, config.model, "streamWithTools starting", {
    tools: toolDefs.map((t) => t.name),
    messageCount: messages.length,
    maxSteps,
  });
  const streamStartTime = Date.now();
  const STREAM_TEXT_FLUSH_MS = 16;
  const STREAM_TEXT_MAX_HOLD_MS = 40;
  const STREAM_TEXT_FORCE_FLUSH_CHARS = 64;
  const aiTools: Record<string, any> = {};
  let pendingTextDelta = "";
  let textFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingTextStartedAt = 0;

  function findFlushBoundary(text: string): number {
    for (let index = text.length - 1; index >= 0; index--) {
      const char = text[index]!;
      if (char === "\n" || char === "\r") {
        return index + 1;
      }
      if (/\s/.test(char)) {
        return index + 1;
      }
      if (/[.,!?;:)\]]/.test(char)) {
        const next = text[index + 1];
        if (next === undefined || /\s/.test(next)) {
          return index + 1;
        }
      }
    }
    return 0;
  }

  function emitTextDelta(delta: string): void {
    if (!delta || signal?.aborted) {
      return;
    }
    callbacks.onTextDelta?.(delta);
  }

  function flushPendingTextDelta(force: boolean = false): void {
    if (textFlushTimer) {
      clearTimeout(textFlushTimer);
      textFlushTimer = null;
    }
    if (!pendingTextDelta) {
      return;
    }

    const boundary = findFlushBoundary(pendingTextDelta);
    if (!force) {
      if (boundary > 0 && boundary < pendingTextDelta.length) {
        emitTextDelta(pendingTextDelta.slice(0, boundary));
        pendingTextDelta = pendingTextDelta.slice(boundary);
        pendingTextStartedAt = Date.now();
        schedulePendingTextFlush();
        return;
      }

      const holdingTooLong =
        pendingTextStartedAt > 0 &&
        Date.now() - pendingTextStartedAt >= STREAM_TEXT_MAX_HOLD_MS;
      if (
        boundary === 0 &&
        !holdingTooLong &&
        pendingTextDelta.length < STREAM_TEXT_FORCE_FLUSH_CHARS
      ) {
        schedulePendingTextFlush();
        return;
      }
    }

    emitTextDelta(pendingTextDelta);
    pendingTextDelta = "";
    pendingTextStartedAt = 0;
  }

  function schedulePendingTextFlush(): void {
    if (textFlushTimer) {
      return;
    }
    textFlushTimer = setTimeout(() => {
      textFlushTimer = null;
      flushPendingTextDelta();
    }, STREAM_TEXT_FLUSH_MS);
  }

  const signal = callbacks.abortSignal;

  for (const t of toolDefs) {
    aiTools[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.parameters as any),
      execute: async (input: any) => {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        flushPendingTextDelta(true);
        const result = await executeTool(t.name, input);
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        callbacks.onToolCall?.(t.name, input, result);
        return result;
      },
    } as any);
  }

  let capturedStreamError: unknown = null;
  const result = streamText({
    model: getModel(config),
    system: systemPrompt,
    messages: messages as any,
    tools: aiTools,
    stopWhen: stepCountIs(maxSteps),
    abortSignal: signal,
    ...getEffortOptions(config),
    onError: ({ error }: { error: unknown }) => {
      capturedStreamError = error;
    },
  } as any);

  // Consume the fullStream to get text deltas.
  // Tool calls are handled by SDK's execute functions automatically.
  let fullText = "";
  try {
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        const delta = (part as any).text ?? "";
        if (delta) {
          fullText += delta;
          if (!pendingTextDelta) {
            pendingTextStartedAt = Date.now();
          }
          pendingTextDelta += delta;
          schedulePendingTextFlush();
        }
      }
      if (part.type === "error") {
        const streamErr = (part as any).error;
        throw streamErr instanceof Error ? streamErr : new Error(formatAIError(streamErr));
      }
    }
  } catch (err) {
    if (textFlushTimer) {
      clearTimeout(textFlushTimer);
      textFlushTimer = null;
    }
    flushPendingTextDelta(true);
    if (!fullText) {
      throw err;
    }
  }

  if (textFlushTimer) {
    clearTimeout(textFlushTimer);
    textFlushTimer = null;
  }
  flushPendingTextDelta(true);
  if (capturedStreamError && !fullText) {
    throw capturedStreamError;
  }
  debugAI(config.provider, config.model, "streamWithTools completed", {
    durationMs: Date.now() - streamStartTime,
    responseLength: fullText.length,
  });
  return fullText;
}

export type AIErrorKind =
  | "rate_limit"
  | "auth"
  | "network"
  | "model_not_found"
  | "provider_unavailable"
  | "bad_request"
  | "unknown";

export class AIError extends Error {
  readonly kind: AIErrorKind;
  readonly retryAfterMs: number | null;
  readonly setupHint: string | null;

  constructor(
    message: string,
    kind: AIErrorKind,
    options?: { retryAfterMs?: number | null; setupHint?: string | null }
  ) {
    super(message);
    this.name = "AIError";
    this.kind = kind;
    this.retryAfterMs = options?.retryAfterMs ?? null;
    this.setupHint = options?.setupHint ?? null;
  }

  get userMessage(): string {
    const parts = [this.message];
    if (this.retryAfterMs !== null) {
      const seconds = Math.ceil(this.retryAfterMs / 1000);
      parts.push(`Try again in ~${seconds}s.`);
    }
    if (this.setupHint) {
      parts.push(this.setupHint);
    }
    return parts.join(" ");
  }
}

export function classifyAIError(error: unknown): AIError {
  const apiError = findAPICallError(error);
  if (apiError) {
    const status = apiError.statusCode;
    if (status === 429) {
      const retryAfterMs = parseRetryAfter(apiError);
      return new AIError(
        "Rate limited by the AI provider.",
        "rate_limit",
        {
          retryAfterMs: retryAfterMs ?? DEFAULT_RATE_LIMIT_RETRY_MS,
          setupHint: null,
        }
      );
    }
    if (status === 401 || status === 403) {
      return new AIError(
        "Authentication failed.",
        "auth",
        { setupHint: `Check your API key or AWS credentials. ${AI_PROVIDER_SETUP_HINT}` }
      );
    }
    if (status === 404) {
      return new AIError(
        "Model not found.",
        "model_not_found",
        { setupHint: "Check your AI_MODEL environment variable." }
      );
    }
    if (status === 400) {
      const detail = extractAPIErrorDetail(apiError);
      const message = detail
        ? `AI provider rejected the request: ${detail}`
        : "Bad request sent to AI provider.";
      return new AIError(message, "bad_request", {
        setupHint: "Check your AI_MODEL setting and provider-specific request format.",
      });
    }
    if (status === 503 || status === 502) {
      return new AIError(
        "AI provider is temporarily unavailable.",
        "provider_unavailable",
        { retryAfterMs: DEFAULT_UNAVAILABLE_RETRY_MS }
      );
    }
    if (status && status >= 500) {
      return new AIError(
        `AI provider returned server error (${status}).`,
        "provider_unavailable",
        { retryAfterMs: DEFAULT_UNAVAILABLE_RETRY_MS }
      );
    }
    if (status) {
      return new AIError(`AI provider returned error ${status}.`, "unknown");
    }
    return new AIError(
      "Failed to reach the AI provider.",
      "network",
      { setupHint: "Check your network connection." }
    );
  }

  if (error instanceof Error) {
    if (error.message.includes("fetch failed") || error.message.includes("ECONNREFUSED")) {
      return new AIError(
        "Failed to reach the AI provider.",
        "network",
        { setupHint: "Check your network connection." }
      );
    }
    const msg = error.message.length > 200 ? error.message.slice(0, 200) + "..." : error.message;
    return new AIError(msg, "unknown");
  }

  return new AIError("An unknown AI error occurred.", "unknown");
}

export function formatAIError(error: unknown): string {
  if (error instanceof AIError) {
    return error.userMessage;
  }
  return classifyAIError(error).userMessage;
}

export function isAIProviderError(error: unknown): boolean {
  if (findAPICallError(error) !== null) return true;
  if (error instanceof Error) {
    if (error.message.includes("fetch failed") || error.message.includes("ECONNREFUSED")) {
      return true;
    }
  }
  return false;
}

function parseRetryAfter(apiError: APICallError): number | null {
  const headers = apiError.responseHeaders;
  if (!headers) return null;
  const value = headers["retry-after"];
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.max(1000, seconds * 1000);
  }
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    const ms = date - Date.now();
    return ms > 0 ? ms : 1000;
  }
  return null;
}

function findAPICallError(error: unknown): APICallError | null {
  if (APICallError.isInstance(error)) return error as APICallError;
  if (RetryError.isInstance(error)) {
    const retry = error as RetryError;
    if (APICallError.isInstance(retry.lastError)) return retry.lastError as APICallError;
    for (const inner of retry.errors) {
      if (APICallError.isInstance(inner)) return inner as APICallError;
    }
  }
  if (error instanceof Error && error.cause) {
    return findAPICallError(error.cause);
  }
  return null;
}

function extractAPIErrorDetail(apiError: APICallError): string | null {
  const candidates = [
    readErrorString(apiError.data),
    readErrorString(parseJSON(apiError.responseBody)),
    readErrorString(apiError.responseBody),
    readErrorString(apiError.message),
  ];

  for (const candidate of candidates) {
    const normalized = normalizeErrorDetail(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function parseJSON(value: string | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readErrorString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const preferredKeys = [
    "message",
    "error",
    "detail",
    "errorMessage",
    "cause",
  ];

  for (const key of preferredKeys) {
    const direct = record[key];
    if (typeof direct === "string" && direct.trim()) {
      return direct.trim();
    }
    if (direct && typeof direct === "object") {
      const nested = readErrorString(direct);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

function normalizeErrorDetail(value: string | null): string | null {
  if (!value) return null;

  const singleLine = value.replace(/\s+/g, " ").trim();
  if (!singleLine) return null;

  const withoutPrefix = singleLine.replace(
    /^(bad request|request failed|api call failed)[:\s-]*/i,
    ""
  );

  const cleaned = withoutPrefix.trim();
  if (!cleaned) return null;

  return cleaned.length > 240 ? `${cleaned.slice(0, 240)}...` : cleaned;
}
