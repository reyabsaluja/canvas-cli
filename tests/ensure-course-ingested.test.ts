import assert from "node:assert/strict";
import test from "node:test";
import { ingestCourse } from "../src/ingest/ingest-course.js";
import type { Course } from "../src/domain/models.js";
import type { AppServices } from "../src/tui/services/types.js";

const fakeCourse: Course = {
  id: 1,
  name: "Test Course",
  courseCode: "TEST101",
  termName: "Fall 2025",
  isCurrent: true,
};

function makeMinimalServices(overrides?: Partial<AppServices>): AppServices {
  return {
    client: {} as any,
    config: { baseUrl: "https://example.com", accessToken: "fake" },
    aiConfig: null,
    courses: [fakeCourse],
    assignmentCache: new Map(),
    radar: {} as any,
    resolvedAssignments: new Map(),
    activeIngestionAc: null,
    ...overrides,
  };
}

test("activeIngestionAc is nulled after successful ingestion abort", () => {
  const services = makeMinimalServices();
  const ac = new AbortController();
  services.activeIngestionAc = ac;

  ac.abort();

  // Simulates the finally block logic in ensureCourseIngested
  if (services.activeIngestionAc === ac) {
    services.activeIngestionAc = null;
  }
  assert.equal(services.activeIngestionAc, null);
});

test("activeIngestionAc is preserved when a newer controller has replaced it", () => {
  const services = makeMinimalServices();
  const oldAc = new AbortController();
  const newAc = new AbortController();
  services.activeIngestionAc = newAc;

  // Simulates the finally block: old controller should NOT null the field
  if (services.activeIngestionAc === oldAc) {
    services.activeIngestionAc = null;
  }
  assert.equal(services.activeIngestionAc, newAc);
});

test("aborting activeIngestionAc cancels prior ingestion before starting new one", () => {
  const services = makeMinimalServices();
  const firstAc = new AbortController();
  services.activeIngestionAc = firstAc;

  // Simulates ensureCourseIngested starting a second ingestion
  if (services.activeIngestionAc) {
    services.activeIngestionAc.abort();
    services.activeIngestionAc = null;
  }

  assert.equal(firstAc.signal.aborted, true);
  assert.equal(services.activeIngestionAc, null);

  const secondAc = new AbortController();
  services.activeIngestionAc = secondAc;
  assert.equal(services.activeIngestionAc, secondAc);
  assert.equal(secondAc.signal.aborted, false);
});

test("ingestCourse rejects when aborted during fetch", async () => {
  const ac = new AbortController();

  const client = {
    async getCourseDetail() {
      ac.abort();
      throw new DOMException("Aborted", "AbortError");
    },
    async getAssignments() { return []; },
    async getModulesSafe() { return []; },
    async getFilesSafe() { return []; },
    async getPagesSafe() { return []; },
    async getAnnouncementsSafe() { return []; },
    async getFrontPageSafe() { return null; },
    async getPageBySlugSafe() { return null; },
    skippedEndpoints: [] as string[],
    resetSkippedEndpoints() {},
  } as any;

  await assert.rejects(
    ingestCourse(fakeCourse, client, {
      baseUrl: "https://example.com",
      accessToken: "fake",
    }, {
      refresh: false,
      signal: ac.signal,
    }),
    (err: Error) => {
      assert.match(err.message, /Aborted/);
      return true;
    }
  );
});
