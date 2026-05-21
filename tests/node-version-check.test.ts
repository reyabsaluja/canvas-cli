import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wrapperPath = resolve(__dirname, "../bin/canvas-cli.js");
const wrapperContent = readFileSync(wrapperPath, "utf-8");

test("version check wrapper contains CJS-compatible syntax for the check portion", () => {
  const beforeImport = wrapperContent.split('import("../dist/cli.js")')[0];
  assert.ok(
    !beforeImport.includes("await "),
    "Version check portion should not use top-level await"
  );
  assert.ok(
    wrapperContent.includes("parseInt"),
    "Should use parseInt for version parsing"
  );
});

test("version check wrapper prints correct error message format", () => {
  assert.ok(
    wrapperContent.includes("canvas-cli requires Node.js 20 or later"),
    "Should contain the required error message"
  );
  assert.ok(
    wrapperContent.includes("https://nodejs.org"),
    "Should contain the upgrade URL"
  );
  assert.ok(
    wrapperContent.includes("process.exit(1)"),
    "Should exit with code 1"
  );
});

test("version check wrapper loads the CLI on supported Node versions", () => {
  const output = execFileSync("node", [wrapperPath, "--version"], {
    encoding: "utf-8",
  }).trim();
  assert.match(output, /^\d+\.\d+\.\d+$/);
});
