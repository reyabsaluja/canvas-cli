import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CanvasClient } from "../src/canvas/client.js";
import type { Config } from "../src/config/env.js";
import type { Course } from "../src/domain/models.js";
import { ingestCourse } from "../src/ingest/ingest-course.js";
import {
  createMockCanvasServer,
  startServer,
  stopServer,
  type MockServerData,
} from "./helpers/mock-canvas-server.js";
import { buildDefaultServerData } from "./helpers/fixtures.js";

const COURSE: Course = {
  id: 101,
  name: "Introduction to Computer Science",
  courseCode: "CS101",
  termName: "Spring 2026",
  isCurrent: true,
};

async function withIngestedCourse(
  mutate: (data: MockServerData, origin: string) => void,
  fn: (result: Awaited<ReturnType<typeof ingestCourse>>, origin: string) => Promise<void>
): Promise<void> {
  const data = buildDefaultServerData();
  // The Files tab is blocked, as it is for students at many institutions:
  // the only route to a file is the link that names it.
  data.forbiddenPaths = [/\/courses\/\d+\/files$/, /\/courses\/\d+\/folders$/];
  const server = createMockCanvasServer(data);
  const port = await startServer(server);
  const origin = `http://127.0.0.1:${port}`;
  mutate(data, origin);
  const config: Config = { baseUrl: `${origin}/api/v1`, accessToken: "test-token-valid" };
  const previous = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-module-file-links-"));
  process.chdir(tempDir);
  try {
    const result = await ingestCourse(
      COURSE,
      new CanvasClient(config, { maxRetries: 0 }),
      config,
      { refresh: false }
    );
    await fn(result, origin);
  } finally {
    process.chdir(previous);
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopServer(server);
  }
}

test("a module ExternalUrl item that points at a Canvas file is downloaded like a module file", async () => {
  await withIngestedCourse(
    (data, origin) => {
      data.files.get(101)!.push({
        id: 5003,
        display_name: "lab2-handout.txt",
        filename: "lab2-handout.txt",
        content_type: "text/plain",
        size: 40,
        url: `${origin}/files/5003/download?download_frd=1`,
        updated_at: "2026-01-20T10:00:00Z",
        folder_id: 2,
      });
      data.fileContents = new Map([[5003, "Lab 2: build the ALU.\n"]]);
      data.modules.get(101)![0]!.items!.push({
        id: 103,
        title: "Lab 2 handout",
        type: "ExternalUrl",
        position: 3,
        external_url: `${origin}/courses/101/files/5003?wrap=1`,
      });
    },
    async (result) => {
      const handout = result.attachments.find((a) => a.canvasFileId === 5003);
      assert.ok(handout, "the linked Canvas file is downloaded");
      assert.equal(handout.status, "downloaded");
      assert.equal(handout.sourceType, "module_linked");
      assert.equal(handout.originalFilename, "lab2-handout.txt");
      assert.equal(handout.localPath, "attachments/modules/lab2-handout.txt");
      assert.match(handout.reason, /Week 1: Getting Started/);
      const text = await fs.readFile(path.join(result.coursePath, handout.localPath), "utf-8");
      assert.match(text, /build the ALU/);
      assert.ok(
        !(result.externalLinks ?? []).some((link) => /files\/5003/.test(link.url)),
        "a Canvas file is not also recorded as an external link"
      );
    }
  );
});

test("a module link to a Canvas file is still downloaded when its metadata endpoint is blocked", async () => {
  await withIngestedCourse(
    (data, origin) => {
      data.forbiddenPaths!.push(/^\/files\/5004$/);
      data.files.get(101)!.push({
        id: 5004,
        display_name: "lab3-handout.txt",
        filename: "lab3-handout.txt",
        content_type: "text/plain",
        size: 40,
        url: `${origin}/files/5004/download`,
        updated_at: "2026-01-20T10:00:00Z",
        folder_id: 2,
      });
      data.fileContents = new Map([[5004, "Lab 3: pipeline the ALU.\n"]]);
      data.modules.get(101)![0]!.items!.push({
        id: 104,
        title: "Lab 3 handout.txt",
        type: "ExternalUrl",
        position: 3,
        external_url: `${origin}/courses/101/files/5004/download?wrap=1`,
      });
    },
    async (result) => {
      const handout = result.attachments.find((a) => a.canvasFileId === 5004);
      assert.ok(handout, "the linked Canvas file is downloaded from the link itself");
      assert.equal(handout.status, "downloaded");
      assert.equal(handout.originalFilename, "Lab 3 handout.txt");
      const text = await fs.readFile(path.join(result.coursePath, handout.localPath), "utf-8");
      assert.match(text, /pipeline the ALU/);
    }
  );
});

test("an off-origin module link that merely looks like a Canvas file is not downloaded", async () => {
  await withIngestedCourse(
    (data) => {
      data.modules.get(101)![0]!.items!.push({
        id: 105,
        title: "Mirror",
        type: "ExternalUrl",
        position: 3,
        external_url: "https://mirror.invalid/courses/101/files/5005/download",
      });
    },
    async (result) => {
      assert.ok(
        !result.attachments.some((a) => /mirror\.invalid/.test(a.downloadUrl)),
        "no attachment entry (not even a failed one) is created for another host"
      );
    }
  );
});
