import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl } from "../src/commands/login.js";

describe("normalizeUrl", () => {
  test("returns empty string for empty input", () => {
    assert.equal(normalizeUrl(""), "");
    assert.equal(normalizeUrl("   "), "");
  });

  test("prepends https:// when no scheme provided", () => {
    assert.equal(normalizeUrl("school.instructure.com"), "https://school.instructure.com");
  });

  test("preserves explicit https://", () => {
    assert.equal(normalizeUrl("https://school.instructure.com"), "https://school.instructure.com");
  });

  test("rejects plain http:// for non-localhost", () => {
    assert.equal(normalizeUrl("http://school.instructure.com"), "");
  });

  test("allows http://localhost for dev instances", () => {
    assert.equal(normalizeUrl("http://localhost:3000"), "http://localhost:3000");
  });

  test("allows https://localhost", () => {
    assert.equal(normalizeUrl("https://localhost:3000"), "https://localhost:3000");
  });

  test("strips trailing slashes", () => {
    assert.equal(normalizeUrl("https://school.instructure.com///"), "https://school.instructure.com");
  });

  test("strips /api/v1 suffix", () => {
    assert.equal(normalizeUrl("https://school.instructure.com/api/v1"), "https://school.instructure.com");
  });

  test("rejects hostnames without a dot (except localhost)", () => {
    assert.equal(normalizeUrl("notahost"), "");
  });

  test("allows localhost without a dot", () => {
    assert.equal(normalizeUrl("http://localhost"), "http://localhost");
  });

  test("returns empty string for invalid URLs", () => {
    assert.equal(normalizeUrl("://broken"), "");
  });

  test("handles subdomains correctly", () => {
    assert.equal(normalizeUrl("canvas.university.edu"), "https://canvas.university.edu");
  });

  test("trims whitespace from input", () => {
    assert.equal(normalizeUrl("  school.instructure.com  "), "https://school.instructure.com");
  });
});
