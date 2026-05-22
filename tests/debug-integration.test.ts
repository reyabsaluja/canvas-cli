import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, "../src/cli.ts");

function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(
      "node",
      ["--import", "tsx", cliPath, ...args],
      { encoding: "utf-8", env: { ...process.env, CANVAS_ACCESS_TOKEN: "fake", CANVAS_BASE_URL: "https://canvas.example.com" } },
      (err, stdout, stderr) => {
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code: err?.code ? Number(err.code) : err ? 1 : 0 });
      }
    );
  });
}

test("--debug flag produces debug output on stderr", async () => {
  // courses command will fail (fake token) but debug output should appear before the API call
  const { stderr } = await run(["--debug", "courses"]);
  assert.ok(stderr.includes("[DEBUG"), "stderr should contain [DEBUG prefix");
  assert.ok(stderr.includes("GENERAL"), "stderr should contain GENERAL category");
  assert.ok(stderr.includes("canvas-cli v"), "stderr should log version at startup");
  assert.ok(stderr.includes("CONFIG"), "stderr should contain CONFIG category");
});

test("no debug output without --debug flag", async () => {
  const { stderr } = await run(["courses"]);
  assert.ok(!stderr.includes("[DEBUG"), "stderr should not contain debug output without flag");
});
