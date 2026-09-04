import assert from "node:assert/strict";
import test from "node:test";
import { APICallError } from "@ai-sdk/provider";
import { formatAIError, getAIConfig, getEffortOptions } from "../src/ai/provider.js";
import type { AIProviderConfig } from "../src/ai/provider.js";

const AI_ENV_KEYS = [
  "AI_PROVIDER",
  "AI_MODEL",
  "AI_EFFORT",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
] as const;

function withAIEnv(
  overrides: Partial<Record<(typeof AI_ENV_KEYS)[number], string>>,
  fn: () => void
): void {
  const previous = new Map<string, string | undefined>();

  for (const key of AI_ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }

  try {
    fn();
  } finally {
    for (const key of AI_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("getAIConfig uses explicit Bedrock provider defaults", () => {
  withAIEnv(
    {
      AI_PROVIDER: "bedrock",
      AWS_REGION: "us-east-1",
    },
    () => {
      assert.deepEqual(getAIConfig(), {
        provider: "bedrock",
        model: "us.anthropic.claude-sonnet-5",
      });
    }
  );
});

test("getAIConfig maps gemini to the google provider", () => {
  withAIEnv(
    {
      AI_PROVIDER: "gemini",
      GOOGLE_API_KEY: "test-google-key",
    },
    () => {
      assert.deepEqual(getAIConfig(), {
        provider: "google",
        model: "gemini-3.8-flash",
      });
    }
  );
});

test("getAIConfig falls back to legacy key-based detection when AI_PROVIDER is unset", () => {
  withAIEnv(
    {
      OPENAI_API_KEY: "test-openai-key",
      AI_MODEL: "gpt-4.1-mini",
    },
    () => {
      assert.deepEqual(getAIConfig(), {
        provider: "openai",
        model: "gpt-4.1-mini",
      });
    }
  );
});

test("getAIConfig returns null when a direct provider is selected without credentials", () => {
  withAIEnv(
    {
      AI_PROVIDER: "openai",
    },
    () => {
      assert.equal(getAIConfig(), null);
    }
  );
});

test("formatAIError surfaces provider details for bad requests", () => {
  const error = new APICallError({
    message: "Bad request",
    url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/invalid",
    requestBodyValues: {},
    statusCode: 400,
    responseBody: JSON.stringify({
      message:
        "The provided model identifier is invalid. Use a Bedrock model ID such as us.anthropic.claude-sonnet-4-20250514-v1:0.",
    }),
  });

  const formatted = formatAIError(error);
  assert.match(formatted, /The provided model identifier is invalid/);
  assert.match(formatted, /AI_MODEL/);
});

test("getAIConfig includes effort when AI_EFFORT is set", () => {
  withAIEnv(
    {
      AI_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "test-key",
      AI_EFFORT: "high",
    },
    () => {
      assert.deepEqual(getAIConfig(), {
        provider: "anthropic",
        model: "claude-opus-5",
        effort: "high",
      });
    }
  );
});

test("getAIConfig keeps effort for the google provider", () => {
  withAIEnv(
    {
      AI_PROVIDER: "google",
      GOOGLE_API_KEY: "test-key",
      AI_EFFORT: "high",
    },
    () => {
      assert.deepEqual(getAIConfig(), {
        provider: "google",
        model: "gemini-3.8-flash",
        effort: "high",
      });
    }
  );
});

test("getAIConfig accepts AI_EFFORT=xhigh", () => {
  withAIEnv(
    {
      AI_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "test-key",
      AI_EFFORT: "xhigh",
    },
    () => {
      assert.deepEqual(getAIConfig(), {
        provider: "anthropic",
        model: "claude-opus-5",
        effort: "xhigh",
      });
    }
  );
});

test("getAIConfig ignores invalid AI_EFFORT values", () => {
  withAIEnv(
    {
      AI_PROVIDER: "openai",
      OPENAI_API_KEY: "test-key",
      AI_EFFORT: "turbo",
    },
    () => {
      assert.deepEqual(getAIConfig(), {
        provider: "openai",
        model: "gpt-5.6",
      });
    }
  );
});

test("getEffortOptions returns empty for no effort", () => {
  const config: AIProviderConfig = { provider: "anthropic", model: "claude-opus-5" };
  assert.deepEqual(getEffortOptions(config), {});
});

test("getEffortOptions passes OpenAI reasoningEffort through", () => {
  const config: AIProviderConfig = { provider: "openai", model: "gpt-5.5", effort: "medium" };
  assert.deepEqual(getEffortOptions(config), {
    providerOptions: { openai: { reasoningEffort: "medium" } },
  });
});

test("getEffortOptions sends max to GPT-5.6 and rounds it to xhigh on GPT-5.5", () => {
  assert.deepEqual(getEffortOptions({ provider: "openai", model: "gpt-5.6", effort: "max" }), {
    providerOptions: { openai: { reasoningEffort: "max" } },
  });
  assert.deepEqual(getEffortOptions({ provider: "openai", model: "gpt-5.6-terra", effort: "xhigh" }), {
    providerOptions: { openai: { reasoningEffort: "xhigh" } },
  });
  assert.deepEqual(getEffortOptions({ provider: "openai", model: "gpt-5.5", effort: "max" }), {
    providerOptions: { openai: { reasoningEffort: "xhigh" } },
  });
  assert.deepEqual(getEffortOptions({ provider: "openai", model: "gpt-5.2", effort: "xhigh" }), {
    providerOptions: { openai: { reasoningEffort: "high" } },
  });
});

test("getEffortOptions uses adaptive thinking plus effort on current Claude models", () => {
  for (const model of ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7"]) {
    assert.deepEqual(
      getEffortOptions({ provider: "anthropic", model, effort: "xhigh" }),
      { providerOptions: { anthropic: { thinking: { type: "adaptive" }, effort: "xhigh" } } },
      model
    );
  }
  assert.deepEqual(getEffortOptions({ provider: "anthropic", model: "claude-opus-5", effort: "max" }), {
    providerOptions: { anthropic: { thinking: { type: "adaptive" }, effort: "max" } },
  });
});

test("getEffortOptions rounds xhigh up to max on Claude 4.6", () => {
  assert.deepEqual(getEffortOptions({ provider: "anthropic", model: "claude-sonnet-4-6", effort: "xhigh" }), {
    providerOptions: { anthropic: { thinking: { type: "adaptive" }, effort: "max" } },
  });
  assert.deepEqual(getEffortOptions({ provider: "anthropic", model: "claude-opus-4-6", effort: "high" }), {
    providerOptions: { anthropic: { thinking: { type: "adaptive" }, effort: "high" } },
  });
});

test("getEffortOptions keeps a thinking budget for Claude models before 4.6", () => {
  assert.deepEqual(getEffortOptions({ provider: "anthropic", model: "claude-haiku-4-5", effort: "high" }), {
    providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 10000 } } },
  });
  assert.deepEqual(getEffortOptions({ provider: "anthropic", model: "claude-haiku-4-5-20251001", effort: "xhigh" }), {
    providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 32000 } } },
  });
  assert.deepEqual(getEffortOptions({ provider: "anthropic", model: "claude-sonnet-4-20250514", effort: "low" }), {
    providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 2048 } } },
  });
});

test("getEffortOptions returns Bedrock adaptive reasoningConfig for current Claude profiles", () => {
  assert.deepEqual(getEffortOptions({ provider: "bedrock", model: "us.anthropic.claude-opus-5", effort: "max" }), {
    providerOptions: { bedrock: { reasoningConfig: { type: "adaptive", maxReasoningEffort: "max" } } },
  });
  assert.deepEqual(getEffortOptions({ provider: "bedrock", model: "global.anthropic.claude-fable-5-1", effort: "xhigh" }), {
    providerOptions: { bedrock: { reasoningConfig: { type: "adaptive", maxReasoningEffort: "xhigh" } } },
  });
  assert.deepEqual(getEffortOptions({ provider: "bedrock", model: "us.anthropic.claude-sonnet-4-6", effort: "xhigh" }), {
    providerOptions: { bedrock: { reasoningConfig: { type: "adaptive", maxReasoningEffort: "max" } } },
  });
});

test("getEffortOptions keeps Bedrock budgets for older Claude and plain effort for other models", () => {
  assert.deepEqual(
    getEffortOptions({ provider: "bedrock", model: "us.anthropic.claude-haiku-4-5-20251001-v1:0", effort: "max" }),
    { providerOptions: { bedrock: { reasoningConfig: { type: "enabled", budgetTokens: 32000 } } } }
  );
  assert.deepEqual(getEffortOptions({ provider: "bedrock", model: "us.amazon.nova-pro-v1:0", effort: "max" }), {
    providerOptions: { bedrock: { reasoningConfig: { maxReasoningEffort: "high" } } },
  });
});

test("getEffortOptions maps effort to Gemini thinking levels", () => {
  assert.deepEqual(getEffortOptions({ provider: "google", model: "gemini-3.8-flash", effort: "high" }), {
    providerOptions: { google: { thinkingConfig: { thinkingLevel: "high" } } },
  });
  assert.deepEqual(getEffortOptions({ provider: "google", model: "gemini-3.8-flash", effort: "max" }), {
    providerOptions: { google: { thinkingConfig: { thinkingLevel: "high" } } },
  });
  assert.deepEqual(getEffortOptions({ provider: "google", model: "gemini-3.5-flash-lite", effort: "low" }), {
    providerOptions: { google: { thinkingConfig: { thinkingLevel: "low" } } },
  });
});

test("getEffortOptions sends nothing for subscription providers", () => {
  assert.deepEqual(getEffortOptions({ provider: "copilot", model: "auto", effort: "max" }), {});
  assert.deepEqual(getEffortOptions({ provider: "codex", model: "default", effort: "xhigh" }), {});
});

test("getAIConfig picks up AI_EFFORT=low for bedrock", () => {
  withAIEnv(
    {
      AI_PROVIDER: "bedrock",
      AWS_REGION: "us-east-1",
      AI_EFFORT: "low",
    },
    () => {
      assert.deepEqual(getAIConfig(), {
        provider: "bedrock",
        model: "us.anthropic.claude-sonnet-5",
        effort: "low",
      });
    }
  );
});

test("getAIConfig is case-insensitive for AI_EFFORT", () => {
  withAIEnv(
    {
      AI_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "test-key",
      AI_EFFORT: "HIGH",
    },
    () => {
      assert.deepEqual(getAIConfig(), {
        provider: "anthropic",
        model: "claude-opus-5",
        effort: "high",
      });
    }
  );
});
