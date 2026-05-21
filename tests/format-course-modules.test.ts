import assert from "node:assert/strict";
import test from "node:test";
import type { CourseCache } from "../src/enrich/cache-loader.js";
import { formatCourseModulesList } from "../src/tui/format-course-modules.js";

test("formatCourseModulesList renders only the table and footer", () => {
  const output = formatCourseModulesList({
    courseId: 1,
    coursePath: "/tmp",
    assignments: [],
    modules: [
      { id: 2, name: "Week 2 — GPIO", position: 2, itemCount: 8, items: [] },
      { id: 1, name: "Week 1 — Intro", position: 1, itemCount: 5, items: [] },
    ],
    files: [],
    pages: [],
    syllabusCandidates: [],
    attachments: [],
    lectures: [],
    ingestion: null,
  });

  assert.match(output, /^\| # \| Module \| Items \|/);
  assert.match(output, /\| 1 \| Week 1 — Intro \| \*\*5\*\* \|/);
  assert.match(output, /\| 2 \| Week 2 — GPIO \| \*\*8\*\* \|/);
  assert.match(output, /Use `\/open <name>` to open module content\.$/);
  assert.doesNotMatch(output, /\*\*Modules\*\*/);
});
