import assert from "node:assert/strict";
import test from "node:test";
import { APICallError } from "@ai-sdk/provider";
import { formatAIError, getAIConfig } from "../src/ai/provider.js";

const AI_ENV_KEYS = [
  "AI_PROVIDER",
  "AI_MODEL",
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
        model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
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
        model: "gemini-2.0-flash",
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

  assert.equal(
    formatAIError(error),
    "AI provider rejected the request: The provided model identifier is invalid. Use a Bedrock model ID such as us.anthropic.claude-sonnet-4-20250514-v1:0."
  );
});
