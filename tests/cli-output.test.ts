import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, "../src/cli.ts");
const pkgPath = resolve(__dirname, "../package.json");
const expectedVersion = JSON.parse(readFileSync(pkgPath, "utf-8")).version;

function run(args: string[]): string {
  return execFileSync("node", ["--import", "tsx", cliPath, ...args], {
    encoding: "utf-8",
  }).trim();
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
