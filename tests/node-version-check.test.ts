import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, execFile } from "node:child_process";
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

test("version check exits with code 1 and correct message on old Node", () => {
  const checkPortion = wrapperContent
    .split('import("../dist/cli.js")')[0]
    .split("\n")
    .filter((line) => !line.startsWith("#!") && !line.startsWith("//"))
    .join("\n");
  const script = `Object.defineProperty(process.versions, "node", { value: "18.0.0", configurable: true });\n${checkPortion}`;
  try {
    execFileSync("node", ["--eval", script], {
      encoding: "utf-8",
    });
    assert.fail("Should have exited with code 1");
  } catch (err: any) {
    assert.equal(err.status, 1);
    assert.ok(
      err.stderr.includes("canvas-cli requires Node.js 20 or later"),
      "Should print the required error message"
    );
    assert.ok(
      err.stderr.includes("https://nodejs.org"),
      "Should include the upgrade URL"
    );
  }
});

test("version check wrapper passes the version gate on supported Node", (_, done) => {
  // Verify the version check passes (does not exit with the version error)
  // by running the wrapper. It will attempt to import ../dist/cli.js which
  // may not exist in a clean checkout, but the key assertion is that we do
  // NOT get the "requires Node.js 20" error — proving the gate passed.
  execFile("node", [wrapperPath, "--version"], { encoding: "utf-8" }, (err, stdout, stderr) => {
    if (err) {
      // If it failed, it must NOT be because of the version check
      assert.ok(
        !stderr.includes("canvas-cli requires Node.js 20 or later"),
        "Should not fail the version gate on a supported Node version"
      );
    } else {
      // If it succeeded, we should get a semver version (dist was built)
      assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
    }
    done();
  });
});
