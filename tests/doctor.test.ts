import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validateTokenFormat, formatResults, type CheckResult } from "../src/tui/doctor.js";

describe("validateTokenFormat", () => {
  test("passes for valid Canvas token pattern", () => {
    const result = validateTokenFormat("12345~AbCdEfGhIjKlMnOpQrStUvWxYz");
    assert.equal(result.status, "pass");
    assert.equal(result.label, "Token format");
  });

  test("fails when token has both whitespace and quotes", () => {
    const result = validateTokenFormat("  '12345~abc' ");
    assert.equal(result.status, "fail");
    assert.match(result.detail, /whitespace/);
    assert.match(result.detail, /quotes/);
  });

  test("fails when token has leading whitespace", () => {
    const result = validateTokenFormat("  12345~abc");
    assert.equal(result.status, "fail");
    assert.match(result.detail, /whitespace/);
  });

  test("fails when token has trailing whitespace", () => {
    const result = validateTokenFormat("12345~abc\n");
    assert.equal(result.status, "fail");
    assert.match(result.detail, /whitespace/);
  });

  test("fails when token is wrapped in double quotes", () => {
    const result = validateTokenFormat('"12345~abc"');
    assert.equal(result.status, "fail");
    assert.match(result.detail, /wrapped in quotes/);
  });

  test("fails when token is wrapped in single quotes", () => {
    const result = validateTokenFormat("'12345~abc'");
    assert.equal(result.status, "fail");
    assert.match(result.detail, /wrapped in quotes/);
  });

  test("fails when token contains placeholder text 'paste'", () => {
    const result = validateTokenFormat("paste_your_token_here");
    assert.equal(result.status, "fail");
    assert.match(result.detail, /placeholder/);
  });

  test("fails when token contains 'your_token'", () => {
    const result = validateTokenFormat("your_token");
    assert.equal(result.status, "fail");
    assert.match(result.detail, /placeholder/);
  });

  test("warns when token does not match expected pattern", () => {
    const result = validateTokenFormat("some-random-string-no-tilde");
    assert.equal(result.status, "warn");
    assert.match(result.detail, /does not match expected/);
    assert.ok(result.fix);
  });

  test("warns for token with special characters after tilde", () => {
    const result = validateTokenFormat("12345~abc!@#");
    assert.equal(result.status, "warn");
  });
});

describe("formatResults", () => {
  test("renders header with profile name", () => {
    const output = formatResults("default", []);
    assert.match(output, /profile: default/);
  });

  test("shows pass icon for passing checks", () => {
    const results: CheckResult[] = [
      { label: "Config", status: "pass", detail: "All good" },
    ];
    const output = formatResults("test", results);
    assert.match(output, /✓ \*\*Config\*\*/);
    assert.match(output, /All checks passed/);
  });

  test("shows fail icon and fix for failing checks", () => {
    const results: CheckResult[] = [
      { label: "Token", status: "fail", detail: "Missing", fix: "Run login" },
    ];
    const output = formatResults("test", results);
    assert.match(output, /✗ \*\*Token\*\*/);
    assert.match(output, /→ Run login/);
    assert.match(output, /1 issue found/);
  });

  test("pluralizes issue count", () => {
    const results: CheckResult[] = [
      { label: "A", status: "fail", detail: "bad", fix: "fix a" },
      { label: "B", status: "fail", detail: "bad", fix: "fix b" },
    ];
    const output = formatResults("test", results);
    assert.match(output, /2 issues found/);
  });

  test("shows warning summary when only warnings exist", () => {
    const results: CheckResult[] = [
      { label: "Format", status: "warn", detail: "Odd pattern", fix: "Check it" },
    ];
    const output = formatResults("test", results);
    assert.match(output, /! \*\*Format\*\*/);
    assert.match(output, /1 warning/);
  });

  test("does not show fix for passing results even if fix field is present", () => {
    const results: CheckResult[] = [
      { label: "Config", status: "pass", detail: "OK", fix: "Should not appear" },
    ];
    const output = formatResults("test", results);
    assert.ok(!output.includes("Should not appear"));
  });

  test("shows skip icon", () => {
    const results: CheckResult[] = [
      { label: "AI", status: "skip", detail: "Not configured" },
    ];
    const output = formatResults("test", results);
    assert.match(output, /– \*\*AI\*\*/);
  });
});
