import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createMockCanvasServer, startServer, stopServer } from "./helpers/mock-canvas-server.js";
import { buildDefaultServerData } from "./helpers/fixtures.js";

const execFileAsync = promisify(execFile);
const CLI_PATH = new URL("../src/cli.ts", import.meta.url).pathname;
const CLI_ARGS = ["--import", "tsx", CLI_PATH];

const baseEnv = {
  PATH: process.env.PATH,
  NODE_PATH: process.env.NODE_PATH,
  DOTENV_CONFIG_PATH: "/dev/null",
};

test("integration: CLI exits with structured error output", async (t) => {
  const data = buildDefaultServerData();
  const server = createMockCanvasServer(data);
  const port = await startServer(server);

  t.after(async () => { await stopServer(server); });

  await t.test("invalid token exits with code 1 and shows auth error", async () => {
    try {
      await execFileAsync("node", [...CLI_ARGS, "ingest", "CS101"], {
        env: {
          ...baseEnv,
          CANVAS_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
          CANVAS_ACCESS_TOKEN: "expired-token",
        },
      });
      assert.fail("Expected CLI to exit with non-zero code");
    } catch (err: unknown) {
      const e = err as { code: number; stderr: string };
      assert.equal(e.code, 1);
      assert.ok(e.stderr.includes("Authentication failed"), `stderr: ${e.stderr}`);
      assert.ok(e.stderr.includes("CANVAS_ACCESS_TOKEN"), `stderr: ${e.stderr}`);
    }
  });

  await t.test("missing config exits with code 2 and shows config error", async () => {
    try {
      await execFileAsync("node", [...CLI_ARGS, "ingest", "CS101"], {
        env: {
          ...baseEnv,
          CANVAS_BASE_URL: "",
          CANVAS_ACCESS_TOKEN: "",
          HOME: "/tmp/canvas-cli-test-no-home",
          XDG_CONFIG_HOME: "/tmp/canvas-cli-test-no-config",
        },
      });
      assert.fail("Expected CLI to exit with non-zero code");
    } catch (err: unknown) {
      const e = err as { code: number; stderr: string };
      assert.equal(e.code, 2);
      assert.ok(e.stderr.includes("not configured"), `stderr: ${e.stderr}`);
    }
  });
});
