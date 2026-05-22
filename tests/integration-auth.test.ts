import assert from "node:assert/strict";
import test from "node:test";
import { CanvasClient } from "../src/canvas/client.js";
import { CanvasApiError } from "../src/canvas/errors.js";
import { createMockCanvasServer, startServer, stopServer } from "./helpers/mock-canvas-server.js";
import { buildDefaultServerData } from "./helpers/fixtures.js";
import type { Config } from "../src/config/env.js";

test("integration: auth failure flows", async (t) => {
  const data = buildDefaultServerData();
  const server = createMockCanvasServer(data);
  const port = await startServer(server);

  t.after(async () => { await stopServer(server); });

  await t.test("expired token returns 401", async () => {
    const config: Config = {
      baseUrl: `http://127.0.0.1:${port}/api/v1`,
      accessToken: "expired-token",
    };
    const client = new CanvasClient(config);

    await assert.rejects(
      () => client.getCourses(),
      (err: unknown) => {
        assert.ok(err instanceof CanvasApiError);
        assert.equal(err.status, 401);
        assert.ok(err.userHint?.includes("CANVAS_ACCESS_TOKEN"));
        return true;
      }
    );
  });

  await t.test("forbidden token returns 403", async () => {
    const config: Config = {
      baseUrl: `http://127.0.0.1:${port}/api/v1`,
      accessToken: "forbidden-token",
    };
    const client = new CanvasClient(config);

    await assert.rejects(
      () => client.getCourses(),
      (err: unknown) => {
        assert.ok(err instanceof CanvasApiError);
        assert.equal(err.status, 403);
        assert.ok(err.userHint?.includes("permission"));
        return true;
      }
    );
  });

  await t.test("missing auth header returns 401", async () => {
    const config: Config = {
      baseUrl: `http://127.0.0.1:${port}/api/v1`,
      accessToken: "",
    };
    const client = new CanvasClient(config);

    await assert.rejects(
      () => client.getCourses(),
      (err: unknown) => {
        assert.ok(err instanceof CanvasApiError);
        assert.equal(err.status, 401);
        return true;
      }
    );
  });

  await t.test("valid token succeeds after auth failures", async () => {
    const config: Config = {
      baseUrl: `http://127.0.0.1:${port}/api/v1`,
      accessToken: "test-token-valid",
    };
    const client = new CanvasClient(config);
    const courses = await client.getCourses();
    assert.equal(courses.length, 3);
  });

  await t.test("401 on assignment fetch propagates correctly", async () => {
    const config: Config = {
      baseUrl: `http://127.0.0.1:${port}/api/v1`,
      accessToken: "expired-token",
    };
    const client = new CanvasClient(config);

    await assert.rejects(
      () => client.getAssignments(101),
      (err: unknown) => {
        assert.ok(err instanceof CanvasApiError);
        assert.equal(err.status, 401);
        return true;
      }
    );
  });

  await t.test("403 on course detail propagates correctly", async () => {
    const config: Config = {
      baseUrl: `http://127.0.0.1:${port}/api/v1`,
      accessToken: "forbidden-token",
    };
    const client = new CanvasClient(config);

    await assert.rejects(
      () => client.getCourseDetail(101),
      (err: unknown) => {
        assert.ok(err instanceof CanvasApiError);
        assert.equal(err.status, 403);
        return true;
      }
    );
  });

});
