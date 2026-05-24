import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, "../src/cli.ts");
const pkgPath = resolve(__dirname, "../package.json");
const expectedVersion = JSON.parse(readFileSync(pkgPath, "utf-8")).version;

function run(args: string[]) {
  const result = spawnSync("node", ["--import", "tsx", cliPath, ...args], {
    encoding: "utf-8",
  });
  assert.equal(result.status, 0, `"canvas-cli ${args.join(" ")}" exited with code ${result.status}`);
  const unexpectedStderr = result.stderr
    .split("\n")
    .filter((line) => line && !line.includes("DeprecationWarning") && !line.includes("--trace-deprecation"))
    .join("\n");
  assert.equal(unexpectedStderr, "", `"canvas-cli ${args.join(" ")}" produced unexpected stderr`);
  return result.stdout.trim();
}

test("--version prints the package.json version", () => {
  const output = run(["--version"]);
  assert.equal(output, expectedVersion);
});

test("-V prints the package.json version", () => {
  const output = run(["-V"]);
  assert.equal(output, expectedVersion);
});

test("examples command exits cleanly and shows workflows", () => {
  const output = run(["examples"]);
  assert.ok(output.includes("Common Workflows"));
  assert.ok(output.includes("canvas-cli login"));
  assert.ok(output.includes("canvas-cli ingest"));
});

test("login --help includes examples section", () => {
  const output = run(["login", "--help"]);
  assert.ok(output.includes("Examples:"));
  assert.ok(output.includes("Guided setup"));
});

test("logout --help includes examples section", () => {
  const output = run(["logout", "--help"]);
  assert.ok(output.includes("Examples:"));
  assert.ok(output.includes("Remove the default profile"));
});

test("status --help includes examples section", () => {
  const output = run(["status", "--help"]);
  assert.ok(output.includes("Examples:"));
  assert.ok(output.includes("active profile"));
});

test("ingest --help includes examples and argument description", () => {
  const output = run(["ingest", "--help"]);
  assert.ok(output.includes("Examples:"));
  assert.ok(output.includes("course"));
  assert.ok(output.includes("Course code, name, or partial match"));
});
