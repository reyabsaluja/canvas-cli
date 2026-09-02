import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdtempSync, statSync, existsSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LoadedWorkspace } from "../src/ask/types.js";
import type { CourseCache } from "../src/enrich/cache-loader.js";

// Isolate config/credential state before importing config modules.
const configTempDir = mkdtempSync(path.join(os.tmpdir(), "canvas-cli-sec-config-"));
process.env.XDG_CONFIG_HOME = configTempDir;
process.env.CANVAS_CLI_CREDENTIAL_BACKEND = "file";
delete process.env.CANVAS_BASE_URL;
delete process.env.CANVAS_ACCESS_TOKEN;
delete process.env.CANVAS_CLI_PROFILE;

const {
  isSameCanvasOrigin,
  resolveCanvasUrl,
  stripControlChars,
  stripQueryParam,
} = await import("../src/sanitize.js");
const { readBodyWithLimit, fetchCanvasFile, CrossOriginDownloadError, DownloadTooLargeError } =
  await import("../src/canvas/safe-download.js");
const { CanvasClient } = await import("../src/canvas/client.js");
const { downloadSelectedAttachments } = await import("../src/ingest/attachment-download.js");
const { downloadAttachments } = await import("../src/workspace/attachments.js");
const { assertOpenableTarget, getAllowedOpenRoots } = await import("../src/tui/open-resources.js");
const { maskUrl } = await import("../src/debug.js");
const { htmlToText } = await import("../src/format/html-to-text.js");
const { normalizeCourse } = await import("../src/domain/normalize.js");
const { storeCredential, loadCredential, deleteCredential, getCredentialBackend, clearCredentialCache } =
  await import("../src/config/credentials.js");
const { writeStoredConfig, deleteStoredConfig } = await import("../src/config/store.js");
const { getConfigDir, getConfigFilePath } = await import("../src/config/paths.js");
const { loadConfig, resolveRawConfig } = await import("../src/config/env.js");
const { ConfigError } = await import("../src/errors.js");
const { executeToolCallForTurn } = await import("../src/tui/chat-agent.js");
const { createChatContext } = await import("../src/tui/services.js");
const { clearArtifactIndexCache } = await import("../src/knowledge/artifact-index.js");

const BASE = "https://canvas.example/api/v1";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-sec-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Same-origin helpers
// ---------------------------------------------------------------------------

test("isSameCanvasOrigin accepts same-origin and relative URLs, rejects others", () => {
  assert.equal(isSameCanvasOrigin("https://canvas.example/files/1/download?verifier=x", BASE), true);
  assert.equal(isSameCanvasOrigin("/courses/1/files/2/download", BASE), true);
  assert.equal(isSameCanvasOrigin("https://evil.example/files/1", BASE), false);
  assert.equal(isSameCanvasOrigin("http://canvas.example/files/1", BASE), false);
  assert.equal(isSameCanvasOrigin("https://canvas.example:8443/files/1", BASE), false);
  assert.equal(isSameCanvasOrigin("https://canvas.example.evil.com/files/1", BASE), false);
  assert.equal(isSameCanvasOrigin("javascript:alert(1)", BASE), false);
  assert.equal(isSameCanvasOrigin("not a url", "also not a url"), false);
});

test("resolveCanvasUrl only yields http(s) URLs", () => {
  assert.equal(resolveCanvasUrl("/x", BASE)?.toString(), "https://canvas.example/x");
  assert.equal(resolveCanvasUrl("file:///etc/passwd", BASE), null);
  assert.equal(resolveCanvasUrl("data:text/plain,hi", BASE), null);
});

test("stripQueryParam removes only the named param", () => {
  assert.equal(
    stripQueryParam("https://canvas.example/files/1/download?verifier=abc&x=1", "verifier"),
    "https://canvas.example/files/1/download?x=1"
  );
  const untouched = "https://canvas.example/files/1/download?x=1";
  assert.equal(stripQueryParam(untouched, "verifier"), untouched);
  assert.equal(stripQueryParam("not a url", "verifier"), "not a url");
});

test("maskUrl masks verifier params", () => {
  const masked = maskUrl("https://canvas.example/files/1/download?verifier=secret&x=1");
  assert.ok(!masked.includes("secret"));
  assert.ok(masked.includes("verifier=***"));
});

// ---------------------------------------------------------------------------
// Control character stripping
// ---------------------------------------------------------------------------

test("stripControlChars removes C0/C1/DEL and ESC sequences but keeps whitespace and unicode", () => {
  assert.equal(stripControlChars("a\x1b[31mred\x1b[0m b"), "ared b");
  assert.equal(stripControlChars("t\x1b]0;title\x07x"), "tx");
  assert.equal(stripControlChars("x\x1b\\y\x1bz"), "xyz");
  assert.equal(stripControlChars("a\x00b\x07c\x7fd\x9be"), "abcde");
  assert.equal(stripControlChars("line1\nline2\r\n\ttab"), "line1\nline2\r\n\ttab");
  assert.equal(stripControlChars("héllo 世界 🎓 — ok"), "héllo 世界 🎓 — ok");
  assert.equal(stripControlChars(""), "");
});

test("htmlToText output has no terminal escape sequences", () => {
  const text = htmlToText("<p>Hello \x1b[2J\x1b[H world\x07</p>");
  assert.equal(text, "Hello world");
});

test("normalizeCourse strips control characters from names", () => {
  const course = normalizeCourse({
    id: 1,
    name: "Intro\x1b[31m to CS",
    course_code: "CS\x00101",
  } as never);
  assert.equal(course.name, "Intro to CS");
  assert.equal(course.courseCode, "CS101");
});

// ---------------------------------------------------------------------------
// Download guards
// ---------------------------------------------------------------------------

test("readBodyWithLimit rejects oversized bodies via content-length and while streaming", async () => {
  const declared = new Response("x", { headers: { "content-length": "1000" } });
  await assert.rejects(readBodyWithLimit(declared, 10), DownloadTooLargeError);

  const streamed = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8));
      controller.enqueue(new Uint8Array(8));
      controller.close();
    },
  }));
  await assert.rejects(readBodyWithLimit(streamed, 10), DownloadTooLargeError);

  const ok = new Response("hello");
  assert.equal((await readBodyWithLimit(ok, 10)).toString(), "hello");
});

test("fetchCanvasFile refuses cross-origin targets before making a request", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("nope");
  }) as typeof fetch;
  try {
    await assert.rejects(
      fetchCanvasFile("https://evil.example/file", { baseUrl: BASE, accessToken: "tok" }),
      CrossOriginDownloadError
    );
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("downloadSelectedAttachments never sends the token off-origin and strips verifier from the manifest", async () => {
  await withTempDir(async (dir) => {
    const originalFetch = globalThis.fetch;
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(input), auth: headers.get("authorization") ?? undefined });
      return new Response("content", { status: 200 });
    }) as typeof fetch;
    try {
      const results = await downloadSelectedAttachments(
        [
          {
            sourceType: "assignment_linked",
            fileId: null,
            filename: "evil.pdf",
            downloadUrl: "https://evil.example/files/1/download?verifier=leak",
            reason: "test",
            contentType: null,
            size: null,
            subfolder: "assignments",
          },
          {
            sourceType: "assignment_linked",
            fileId: null,
            filename: "good.pdf",
            downloadUrl: "https://canvas.example/courses/1/files/2/download?verifier=once",
            reason: "test",
            contentType: null,
            size: null,
            subfolder: "assignments",
          },
        ],
        path.join(dir, "attachments"),
        { baseUrl: BASE, accessToken: "tok" }
      );

      assert.equal(seen.length, 1);
      assert.match(seen[0]!.url, /^https:\/\/canvas\.example\//);
      assert.equal(seen[0]!.auth, "Bearer tok");

      assert.equal(results[0]?.status, "failed");
      assert.equal(results[1]?.status, "downloaded");
      assert.equal(
        results[1]?.downloadUrl,
        "https://canvas.example/courses/1/files/2/download"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("workspace downloadAttachments skips off-origin linked files", async () => {
  await withTempDir(async (dir) => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("content", { status: 200 });
    }) as typeof fetch;
    try {
      const result = await downloadAttachments(
        [
          { title: "x.pdf", url: "https://evil.example/x", downloadUrl: "https://evil.example/x/download" },
          { title: "y.pdf", url: "https://canvas.example/y", downloadUrl: "https://canvas.example/y/download" },
        ],
        path.join(dir, "attachments"),
        { baseUrl: BASE, accessToken: "tok" }
      );
      assert.deepEqual(result.failed, ["x.pdf"]);
      assert.deepEqual(result.downloaded, ["y.pdf"]);
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("CanvasClient stops paginating when the next link is off-origin", async () => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Link", `<https://evil.example/api/v1/courses?page=2>; rel="next"`);
    res.end(JSON.stringify([{ id: requests, name: `Course ${requests}` }]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const client = new CanvasClient({
      baseUrl: `http://127.0.0.1:${port}/api/v1`,
      accessToken: "tok",
    });
    const courses = await client.getCourses();
    assert.equal(courses.length, 1);
    assert.equal(requests, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ---------------------------------------------------------------------------
// Agent download tools confine filenames
// ---------------------------------------------------------------------------

test("download_course_file confines traversal-laden display names to the attachments directory", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const workspacePath = path.join(tempDir, "workspace");
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, "assignment.md"), "# A\n", "utf-8");
    const loaded: LoadedWorkspace = {
      path: workspacePath,
      sessionSlug: "lab-4",
      assignmentId: 42,
      assignmentName: "Lab 4",
      courseId: 17,
      courseName: "ECE243",
      courseCode: "ECE243H1",
      preparedAt: "2026-04-02T09:00:00.000Z",
      workspaceState: "ready",
      assignmentMd: "# A\n",
      planMd: null,
      notesMd: null,
      workupJson: null,
      extractedFiles: [],
      extractedFileCache: new Map<string, string>(),
    };
    const coursePath = path.join(tempDir, "course");
    await fs.mkdir(coursePath, { recursive: true });
    await fs.writeFile(path.join(coursePath, "attachments.json"), "[]\n", "utf-8");

    const cache: CourseCache = {
      courseId: 17,
      coursePath,
      assignments: [],
      modules: [
        {
          id: 8,
          name: "Module",
          position: 1,
          itemCount: 1,
          items: [
            {
              id: 10,
              title: "notes.txt",
              type: "File",
              position: 1,
              contentId: 777,
              pageUrl: null,
              htmlUrl: null,
              externalUrl: null,
            },
          ],
        },
      ],
      files: [],
      pages: [],
      syllabusCandidates: [],
      attachments: [],
      lectures: [],
      ingestion: null,
    } as unknown as CourseCache;

    const fakeClient = {
      getFileSafe: async () => ({
        id: 777,
        display_name: "../../escaped.txt",
        url: "https://canvas.example/files/777/download",
        content_type: "text/plain",
        size: 5,
      }),
      downloadFile: async () => Buffer.from("hello"),
    };
    const ctx = createChatContext(
      { provider: "anthropic", model: "test-model" },
      loaded,
      {
        cache,
        client: fakeClient as unknown as Parameters<typeof createChatContext>[2]["client"],
        config: null,
        courseId: 17,
      }
    );

    const result = await executeToolCallForTurn(
      new Map(),
      "download_course_file",
      { title: "notes.txt" },
      ctx
    );
    assert.equal(result.result.observation.status, "ok");

    assert.equal(existsSync(path.join(tempDir, "escaped.txt")), false);
    assert.equal(existsSync(path.join(coursePath, "escaped.txt")), false);
    assert.equal(
      existsSync(path.join(coursePath, "attachments", "modules", "escaped.txt")),
      true
    );
  });
});

// ---------------------------------------------------------------------------
// Agent-initiated opens
// ---------------------------------------------------------------------------

test("assertOpenableTarget allows http(s) URLs and confined files only", () => {
  const roots = ["/tmp/canvas-root"];
  const url = (target: string) =>
    ({ id: "u", title: "u", kind: "link", targetType: "url" as const, target, searchTerms: [] });
  const file = (target: string) =>
    ({ id: "f", title: "f", kind: "file", targetType: "file" as const, target, searchTerms: [] });

  assert.doesNotThrow(() => assertOpenableTarget(url("https://example.com/x")));
  assert.doesNotThrow(() => assertOpenableTarget(url("http://example.com/x")));
  assert.throws(() => assertOpenableTarget(url("file:///etc/passwd")), /non-http/);
  assert.throws(() => assertOpenableTarget(url("javascript:alert(1)")), /non-http/);
  assert.throws(() => assertOpenableTarget(url("x-apple.systempreferences:")), /non-http/);
  assert.throws(() => assertOpenableTarget(url("not a url")), /malformed/);

  assert.doesNotThrow(() => assertOpenableTarget(file("/tmp/canvas-root/a/b.pdf"), roots));
  assert.throws(() => assertOpenableTarget(file("/tmp/canvas-root/../etc/passwd"), roots), /outside/);
  assert.throws(() => assertOpenableTarget(file("/tmp/canvas-rootx/a.pdf"), roots), /outside/);
  assert.throws(() => assertOpenableTarget(file("relative/a.pdf"), roots), /non-local/);
  assert.throws(() => assertOpenableTarget(file("/tmp/canvas-root/a.pdf"), []), /no allowed/);
});

test("getAllowedOpenRoots includes workspace, cache and export directories", () => {
  const roots = getAllowedOpenRoots({
    loaded: { path: "/w/space" } as never,
    cache: { coursePath: "/c/course" } as never,
    exportDirectories: ["/e/exports"],
    lastExportedPdfPath: "/e/exports/guide.pdf",
  });
  assert.ok(roots.includes(path.resolve("/w/space")));
  assert.ok(roots.includes(path.resolve("/c/course")));
  assert.ok(roots.includes(path.resolve("/e/exports")));
});

// ---------------------------------------------------------------------------
// Credentials and config
// ---------------------------------------------------------------------------

test("CANVAS_CLI_CREDENTIAL_BACKEND=file forces the file backend and tightens permissions", () => {
  const profile = "sec-file-backend";
  try {
    const backend = storeCredential(profile, "canvas-token", "abc");
    assert.equal(backend, "file");
    clearCredentialCache();
    assert.equal(loadCredential(profile, "canvas-token"), "abc");
    assert.equal(getCredentialBackend(profile, "canvas-token"), "file");
    const filePath = path.join(getConfigDir(), "credentials", `${profile}.canvas-token`);
    assert.ok(existsSync(filePath));
    if (process.platform !== "win32") {
      assert.equal(statSync(filePath).mode & 0o777, 0o600);
    }
    writeStoredConfig({ canvasBaseUrl: "https://stored.example" }, profile);
    if (process.platform !== "win32") {
      assert.equal(statSync(getConfigFilePath(profile)).mode & 0o777, 0o600);
    }
  } finally {
    deleteCredential(profile, "canvas-token");
    deleteStoredConfig(profile);
    clearCredentialCache();
  }
});

test("loadConfig refuses to pair an environment CANVAS_BASE_URL with the stored token", () => {
  const profile = "sec-mixed-source";
  const saved = { ...process.env };
  try {
    process.env.CANVAS_CLI_PROFILE = profile;
    writeStoredConfig({ canvasBaseUrl: "https://stored.example" }, profile);
    storeCredential(profile, "canvas-token", "stored-token");
    clearCredentialCache();

    process.env.CANVAS_BASE_URL = "https://attacker.example/api/v1";
    delete process.env.CANVAS_ACCESS_TOKEN;
    const raw = resolveRawConfig();
    assert.equal(raw.accessToken, undefined);
    assert.ok(raw.credentialError instanceof ConfigError);
    assert.throws(() => loadConfig(), (err: unknown) => err instanceof ConfigError && /CANVAS_BASE_URL/.test(err.message));

    // Providing both env values together is allowed.
    process.env.CANVAS_ACCESS_TOKEN = "env-token";
    const config = loadConfig();
    assert.equal(config.baseUrl, "https://attacker.example/api/v1");
    assert.equal(config.accessToken, "env-token");

    // Stored URL plus stored token is allowed.
    delete process.env.CANVAS_BASE_URL;
    delete process.env.CANVAS_ACCESS_TOKEN;
    clearCredentialCache();
    const storedConfig = loadConfig();
    assert.equal(storedConfig.baseUrl, "https://stored.example/api/v1");
    assert.equal(storedConfig.accessToken, "stored-token");
  } finally {
    deleteCredential(profile, "canvas-token");
    deleteStoredConfig(profile);
    clearCredentialCache();
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
});
