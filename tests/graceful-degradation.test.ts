import assert from "node:assert/strict";
import test from "node:test";
import { APICallError } from "@ai-sdk/provider";
import {
  AIError,
  classifyAIError,
  formatAIError,
  type AIErrorKind,
} from "../src/ai/provider.js";

// --- AIError class tests ---

test("AIError stores kind and retry info", () => {
  const err = new AIError("Rate limited", "rate_limit", {
    retryAfterMs: 30000,
  });
  assert.equal(err.kind, "rate_limit");
  assert.equal(err.retryAfterMs, 30000);
  assert.equal(err.setupHint, null);
  assert.equal(err.name, "AIError");
  assert.match(err.userMessage, /Rate limited/);
  assert.match(err.userMessage, /~30s/);
});

test("AIError stores setupHint for auth errors", () => {
  const err = new AIError("Auth failed", "auth", {
    setupHint: "Check your API key.",
  });
  assert.equal(err.kind, "auth");
  assert.equal(err.retryAfterMs, null);
  assert.match(err.userMessage, /Auth failed/);
  assert.match(err.userMessage, /Check your API key/);
});

test("AIError.userMessage omits retry and hint when null", () => {
  const err = new AIError("Something broke", "unknown");
  assert.equal(err.userMessage, "Something broke");
});

// --- classifyAIError tests ---

test("classifyAIError classifies 429 as rate_limit", () => {
  const error = new APICallError({
    message: "Too many requests",
    url: "https://api.example.com/v1/chat",
    requestBodyValues: {},
    statusCode: 429,
  });
  const classified = classifyAIError(error);
  assert.equal(classified.kind, "rate_limit");
  assert.equal(classified.retryAfterMs, 30000);
  assert.match(classified.userMessage, /Rate limited/);
});

test("classifyAIError classifies 401 as auth", () => {
  const error = new APICallError({
    message: "Unauthorized",
    url: "https://api.example.com/v1/chat",
    requestBodyValues: {},
    statusCode: 401,
  });
  const classified = classifyAIError(error);
  assert.equal(classified.kind, "auth");
  assert.match(classified.userMessage, /Authentication failed/);
  assert.match(classified.userMessage, /API key/);
});

test("classifyAIError classifies 403 as auth", () => {
  const error = new APICallError({
    message: "Forbidden",
    url: "https://api.example.com/v1/chat",
    requestBodyValues: {},
    statusCode: 403,
  });
  const classified = classifyAIError(error);
  assert.equal(classified.kind, "auth");
});

test("classifyAIError classifies 404 as model_not_found", () => {
  const error = new APICallError({
    message: "Not found",
    url: "https://api.example.com/v1/chat",
    requestBodyValues: {},
    statusCode: 404,
  });
  const classified = classifyAIError(error);
  assert.equal(classified.kind, "model_not_found");
  assert.match(classified.userMessage, /Model not found/);
  assert.match(classified.userMessage, /AI_MODEL/);
});

test("classifyAIError classifies 503 as provider_unavailable", () => {
  const error = new APICallError({
    message: "Service unavailable",
    url: "https://api.example.com/v1/chat",
    requestBodyValues: {},
    statusCode: 503,
  });
  const classified = classifyAIError(error);
  assert.equal(classified.kind, "provider_unavailable");
  assert.equal(classified.retryAfterMs, 15000);
});

test("classifyAIError classifies 502 as provider_unavailable", () => {
  const error = new APICallError({
    message: "Bad gateway",
    url: "https://api.example.com/v1/chat",
    requestBodyValues: {},
    statusCode: 502,
  });
  const classified = classifyAIError(error);
  assert.equal(classified.kind, "provider_unavailable");
});

test("classifyAIError classifies 500 as provider_unavailable", () => {
  const error = new APICallError({
    message: "Internal server error",
    url: "https://api.example.com/v1/chat",
    requestBodyValues: {},
    statusCode: 500,
  });
  const classified = classifyAIError(error);
  assert.equal(classified.kind, "provider_unavailable");
  assert.equal(classified.retryAfterMs, 15000);
});

test("classifyAIError classifies 400 as bad_request", () => {
  const error = new APICallError({
    message: "Bad request",
    url: "https://api.example.com/v1/chat",
    requestBodyValues: {},
    statusCode: 400,
    responseBody: JSON.stringify({ message: "Invalid model format" }),
  });
  const classified = classifyAIError(error);
  assert.equal(classified.kind, "bad_request");
  assert.match(classified.userMessage, /Invalid model format/);
});

test("classifyAIError classifies fetch failed as network", () => {
  const error = new Error("fetch failed");
  const classified = classifyAIError(error);
  assert.equal(classified.kind, "network");
  assert.match(classified.userMessage, /network connection/);
});

test("classifyAIError classifies ECONNREFUSED as network", () => {
  const error = new Error("connect ECONNREFUSED 127.0.0.1:443");
  const classified = classifyAIError(error);
  assert.equal(classified.kind, "network");
});

test("classifyAIError classifies unknown errors", () => {
  const classified = classifyAIError("something weird");
  assert.equal(classified.kind, "unknown");
});

test("classifyAIError truncates long error messages", () => {
  const error = new Error("A".repeat(300));
  const classified = classifyAIError(error);
  assert.ok(classified.message.length <= 203); // 200 + "..."
});

// --- formatAIError tests ---

test("formatAIError returns userMessage from AIError", () => {
  const err = new AIError("Custom error", "rate_limit", { retryAfterMs: 5000 });
  assert.match(formatAIError(err), /Custom error/);
  assert.match(formatAIError(err), /~5s/);
});

test("formatAIError classifies and formats raw errors", () => {
  const error = new APICallError({
    message: "Rate limited",
    url: "https://api.example.com/v1/chat",
    requestBodyValues: {},
    statusCode: 429,
  });
  const formatted = formatAIError(error);
  assert.match(formatted, /Rate limited/);
  assert.match(formatted, /~30s/);
});

// --- Partial workup builder (via orchestrator) ---

test("buildPartialWorkup produces a valid workup structure", async () => {
  // We import the orchestrator module to test the exported interface
  const { createInvestigationState, verifyInvestigationState } = await import(
    "../src/work/orchestrator.js"
  );

  const detail = {
    id: 1,
    name: "Test Assignment",
    courseName: "CS101",
    dueAt: new Date("2025-12-01"),
    pointsPossible: 100,
    submissionTypes: ["online_upload"],
    htmlUrl: "https://canvas.example.com/courses/1/assignments/1",
    description: "",
    status: "upcoming" as const,
    submitted: false,
    submittedAt: null,
    late: false,
    missing: false,
    grade: null,
    unlockAt: null,
    lockAt: null,
    gradingType: "points",
    allowedExtensions: null,
    attachments: [],
  };

  const course = {
    id: 1,
    name: "CS101",
    courseCode: "CS101",
    isCurrent: true,
    term: null,
    publicDescription: null,
  };

  const state = createInvestigationState(detail, course);
  state.visitedSources.push("syllabus.pdf", "assignment.pdf");
  state.evidenceNotes.push("Found grading rubric");

  const verification = verifyInvestigationState(state);

  // Verify the state is tracked correctly
  assert.equal(state.visitedSources.length, 2);
  assert.equal(verification.ok, false);
  assert.ok(verification.missing.includes("primary_instruction"));
});

// --- Rate limit retry suggestion ---

test("rate limit error suggests wait time", () => {
  const error = new APICallError({
    message: "Rate limited",
    url: "https://api.example.com/v1/chat",
    requestBodyValues: {},
    statusCode: 429,
  });
  const formatted = formatAIError(error);
  assert.match(formatted, /\d+s/);
});

// --- Auth error shows setup instructions ---

test("auth error shows setup instructions", () => {
  const error = new APICallError({
    message: "Unauthorized",
    url: "https://api.example.com/v1/chat",
    requestBodyValues: {},
    statusCode: 401,
  });
  const formatted = formatAIError(error);
  assert.match(formatted, /AI_PROVIDER/);
});

// --- Non-AI commands should never fail from AI config ---

test("getAIConfig returns null without crashing when no env is set", async () => {
  const { getAIConfig } = await import("../src/ai/provider.js");
  const previous = new Map<string, string | undefined>();
  const keys = [
    "AI_PROVIDER", "AI_MODEL", "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY", "GOOGLE_API_KEY",
  ];
  for (const key of keys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    const config = getAIConfig();
    assert.equal(config, null);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
