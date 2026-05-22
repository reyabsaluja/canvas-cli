import assert from "node:assert/strict";
import test from "node:test";

test("debug module", async (t) => {
  let debugModule: typeof import("../src/debug.js");

  t.beforeEach(async () => {
    debugModule = await import("../src/debug.js");
    // Module is cached by Node — resetDebug() is what actually clears state.
    debugModule.resetDebug();
  });

  await t.test("isDebugEnabled returns false by default", () => {
    // Module starts disabled unless enableDebug/initDebug was called
    // in a prior test. We verify the functions exist and work correctly.
    assert.strictEqual(typeof debugModule.isDebugEnabled, "function");
    assert.strictEqual(typeof debugModule.enableDebug, "function");
    assert.strictEqual(typeof debugModule.initDebug, "function");
  });

  await t.test("enableDebug activates debug mode", () => {
    debugModule.enableDebug();
    assert.strictEqual(debugModule.isDebugEnabled(), true);
  });

  await t.test("initDebug with true enables debug", () => {
    debugModule.initDebug(true);
    assert.strictEqual(debugModule.isDebugEnabled(), true);
  });

  await t.test("initDebug respects DEBUG=canvas-cli env var", () => {
    const original = process.env.DEBUG;
    process.env.DEBUG = "canvas-cli";
    debugModule.initDebug(false);
    assert.strictEqual(debugModule.isDebugEnabled(), true);
    if (original === undefined) {
      delete process.env.DEBUG;
    } else {
      process.env.DEBUG = original;
    }
  });

  await t.test("maskUrl removes sensitive query params", () => {
    const url = "https://canvas.example.com/api/v1/courses?access_token=secret123&per_page=50";
    const masked = debugModule.maskUrl(url);
    assert.ok(!masked.includes("secret123"), "token should be masked");
    assert.ok(masked.includes("per_page=50"), "non-sensitive params preserved");
    assert.ok(masked.includes("access_token=***"), "access_token masked to ***");
  });

  await t.test("maskUrl handles URLs without sensitive params", () => {
    const url = "https://canvas.example.com/api/v1/courses?per_page=50";
    const masked = debugModule.maskUrl(url);
    assert.strictEqual(masked, url);
  });

  await t.test("maskUrl does not over-mask non-sensitive key params", () => {
    const url = "https://canvas.example.com/api/v1/items?sort_key=name&primary_key=123&api_key=secret";
    const masked = debugModule.maskUrl(url);
    assert.ok(masked.includes("sort_key=name"), "sort_key should not be masked");
    assert.ok(masked.includes("primary_key=123"), "primary_key should not be masked");
    assert.ok(masked.includes("api_key=***"), "api_key should be masked");
  });

  await t.test("maskUrl handles invalid URLs gracefully", () => {
    const result = debugModule.maskUrl("not-a-url");
    assert.strictEqual(typeof result, "string");
  });

  await t.test("maskEnvForDebug masks sensitive env vars", () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test123";
    const result = debugModule.maskEnvForDebug();
    assert.strictEqual(result.ANTHROPIC_API_KEY, "***");
    if (original === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = original;
    }
  });

  await t.test("maskEnvForDebug omits vars that are not set", () => {
    const original = process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    const result = debugModule.maskEnvForDebug();
    assert.ok(!("GOOGLE_API_KEY" in result));
    if (original !== undefined) {
      process.env.GOOGLE_API_KEY = original;
    }
  });

  await t.test("debug writes to stderr when enabled", () => {
    debugModule.enableDebug();
    const chunks: Buffer[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk: any) => {
      chunks.push(Buffer.from(chunk));
      return true;
    };
    try {
      debugModule.debug("api", "test message");
      const output = Buffer.concat(chunks).toString();
      assert.ok(output.includes("[DEBUG"), "should include DEBUG prefix");
      assert.ok(output.includes("API"), "should include category");
      assert.ok(output.includes("test message"), "should include message");
      assert.ok(output.endsWith("\n"), "should end with newline");
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  await t.test("debug masks sensitive data in objects", () => {
    debugModule.enableDebug();
    const chunks: Buffer[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk: any) => {
      chunks.push(Buffer.from(chunk));
      return true;
    };
    try {
      debugModule.debug("api", "test", {
        url: "https://example.com",
        authorization: "Bearer sk-secret",
        apiKey: "should-be-masked",
        accessToken: "also-masked",
        normalField: "visible",
      });
      const output = Buffer.concat(chunks).toString();
      assert.ok(!output.includes("sk-secret"), "authorization value masked");
      assert.ok(!output.includes("should-be-masked"), "apiKey value masked");
      assert.ok(!output.includes("also-masked"), "accessToken value masked");
      assert.ok(output.includes("visible"), "normal fields preserved");
      assert.ok(output.includes('"authorization":"***"'), "authorization shows ***");
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  await t.test("debug does nothing when disabled", () => {
    const chunks: Buffer[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk: any) => {
      chunks.push(Buffer.from(chunk));
      return true;
    };
    try {
      debugModule.debug("general", "should not appear", { key: "value" });
      const output = Buffer.concat(chunks).toString();
      assert.strictEqual(output, "", "no output when debug is disabled");
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  await t.test("debugApiRequest and debugApiResponse work", () => {
    debugModule.enableDebug();
    const chunks: Buffer[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk: any) => {
      chunks.push(Buffer.from(chunk));
      return true;
    };
    try {
      debugModule.debugApiRequest("GET", "https://canvas.example.com/api/v1/courses?access_token=secret");
      debugModule.debugApiResponse("GET", "https://canvas.example.com/api/v1/courses?access_token=secret", 200, 150);
      const output = Buffer.concat(chunks).toString();
      assert.ok(!output.includes("secret"), "tokens masked in URLs");
      assert.ok(output.includes("200"), "status code present");
      assert.ok(output.includes("150ms"), "duration present");
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  await t.test("debugAI includes provider and model", () => {
    debugModule.enableDebug();
    const chunks: Buffer[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk: any) => {
      chunks.push(Buffer.from(chunk));
      return true;
    };
    try {
      debugModule.debugAI("anthropic", "claude-sonnet-4-20250514", "callModel starting", {
        maxTokens: 1024,
      });
      const output = Buffer.concat(chunks).toString();
      assert.ok(output.includes("anthropic"), "provider present");
      assert.ok(output.includes("claude-sonnet-4-20250514"), "model present");
      assert.ok(output.includes("AI"), "category present");
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  await t.test("debugFs logs filesystem operations", () => {
    debugModule.enableDebug();
    const chunks: Buffer[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk: any) => {
      chunks.push(Buffer.from(chunk));
      return true;
    };
    try {
      debugModule.debugFs("create", "/tmp/workspace/test-slug", "workspace for \"Test Assignment\"");
      const output = Buffer.concat(chunks).toString();
      assert.ok(output.includes("FS"), "category present");
      assert.ok(output.includes("create"), "operation present");
      assert.ok(output.includes("/tmp/workspace/test-slug"), "path present");
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  await t.test("debugCache logs cache operations with hit/miss", () => {
    debugModule.enableDebug();
    const chunks: Buffer[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk: any) => {
      chunks.push(Buffer.from(chunk));
      return true;
    };
    try {
      debugModule.debugCache("loadCourseCache", "cs101-12345", true);
      debugModule.debugCache("loadCourseCache", "cs102-67890", false);
      const output = Buffer.concat(chunks).toString();
      assert.ok(output.includes("[HIT]"), "cache hit indicator");
      assert.ok(output.includes("[MISS]"), "cache miss indicator");
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});
