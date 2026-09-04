import assert from "node:assert/strict";
import test from "node:test";
import type { LoadedWorkspace } from "../src/ask/types.js";
import type { Observation } from "../src/agent/observation.js";
import {
  answerLooksLikeNotFound,
  collectCheckedSources,
  formatCheckedSourcesNote,
  verifyWorkspaceAnswer,
} from "../src/agent/verify.js";
import { ASK_SYSTEM_PROMPT } from "../src/ask/answer.js";
import { finalizeAnswerText } from "../src/tui/chat-agent/verification.js";

// verifyWorkspaceAnswer only touches loaded.workupJson, and only when the
// answer came from the workup.
const LOADED = { workupJson: null } as unknown as LoadedWorkspace;

const LAB_HANDOUT = `ECE243 Lab 4: Interrupts and Timers

Part 1: Configuring the private timer
Set the private timer load register at address 0xFFFEC600 so that it counts
one second at the 200 MHz clock.

SUBMISSION
Submit a single zip file named lab4_<studentnumber>.zip containing your C
source and a two-page PDF report. The zip is due on Canvas by Friday March 27.
`;

/** The trail a real turn leaves when the agent hunts for a late policy. */
function buildLatePolicyTrail(): Observation[] {
  return [
    {
      tool: "read_file",
      status: "ok",
      summary: "Read Lab4.pdf.",
      artifacts: [
        { artifactId: "lab4", title: "Lab4.pdf", kind: "attachment" },
      ],
      content: LAB_HANDOUT,
    },
    {
      tool: "search_workspace",
      status: "not_found",
      summary: 'No relevant workspace content found for "late penalty".',
      artifacts: [],
    },
    {
      tool: "search_course",
      status: "ok",
      summary: 'Found 1 course matches for "late policy".',
      artifacts: [
        {
          artifactId: "syllabus",
          title: "syllabus.pdf",
          kind: "attachment",
          excerpt: "Late Policy: see the individual assignment handouts.",
          sectionLabel: "Late Policy",
        },
      ],
    },
    {
      tool: "read_file",
      status: "ok",
      summary: "Read syllabus.pdf — Late Policy.",
      artifacts: [
        {
          artifactId: "syllabus",
          title: "syllabus.pdf",
          kind: "attachment",
          sectionLabel: "Late Policy",
        },
      ],
      content:
        "## Late Policy\nLate penalties, if any, are stated on each assignment handout.",
    },
    {
      tool: "search_course",
      status: "not_found",
      summary: 'No course material matched "penalty per day".',
      artifacts: [],
    },
    {
      tool: "list_announcements",
      status: "ok",
      summary: 'Listed 3 announcements matching "late".',
      artifacts: [],
    },
    {
      tool: "read_file",
      status: "missing_text",
      summary: "Matched rubric.pdf, but the cached extracted text is missing.",
      artifacts: [
        { artifactId: "rubric", title: "rubric.pdf", kind: "attachment" },
      ],
    },
  ];
}

test("collectCheckedSources turns the observation trail into a deduped, human-readable list of what was checked", () => {
  const checked = collectCheckedSources(buildLatePolicyTrail());

  assert.deepEqual(
    checked.map((entry) => entry.kind),
    ["read", "search", "search", "read", "search", "announcements", "failed_read"]
  );
  assert.equal(
    formatCheckedSourcesNote(checked),
    'Lab4.pdf (read in full); workspace search for "late penalty" (no matches); course search for "late policy" (1 match); syllabus.pdf — Late Policy (read); course search for "penalty per day" (no matches); the announcements matching "late"; rubric.pdf (could not read: no extracted text)'
  );
});

test("collectCheckedSources dedupes repeated reads and ignores action-only tools", () => {
  const checked = collectCheckedSources([
    {
      tool: "list_files",
      status: "ok",
      summary: "Listed workspace and course files available to chat.",
      artifacts: [],
    },
    {
      tool: "read_file",
      status: "ok",
      summary: "Read Lab4.pdf.",
      artifacts: [{ artifactId: "lab4", title: "Lab4.pdf", kind: "attachment" }],
      content: LAB_HANDOUT,
    },
    {
      tool: "read_file",
      status: "ok",
      summary: "Reused previously read Lab4.pdf.",
      artifacts: [{ artifactId: "lab4", title: "Lab4.pdf", kind: "attachment" }],
      content: LAB_HANDOUT,
    },
    {
      tool: "open_resource",
      status: "ok",
      summary: "Opened the Lab 4 page in the browser.",
      artifacts: [],
    },
    {
      tool: "read_thread",
      status: "ok",
      summary: 'Read discussion thread for "lab 4 late".',
      artifacts: [],
    },
    // A grounded read of the assignment list belongs in the trail too.
    {
      tool: "list_assignments",
      status: "ok",
      summary: "Listed 2 assignments for this course.",
      artifacts: [{ artifactId: "course:assignments:17", title: "Assignments", kind: "assignment" }],
      content: "- Lab 3 — Mar 20, 11:59 PM\n- Lab 4 — Mar 27, 11:59 PM",
    },
    {
      tool: "list_assignments",
      status: "ok",
      summary: "Listed 2 assignments for this course.",
      artifacts: [{ artifactId: "course:assignments:17", title: "Assignments", kind: "assignment" }],
      content: "- Lab 3 — Mar 20, 11:59 PM\n- Lab 4 — Mar 27, 11:59 PM",
    },
  ]);

  assert.deepEqual(
    checked.map((entry) => entry.kind),
    ["read", "thread", "assignments"]
  );
  assert.equal(
    formatCheckedSourcesNote(checked),
    'Lab4.pdf (read in full); the discussion thread "lab 4 late"; the assignment list'
  );
  assert.equal(formatCheckedSourcesNote([]), null);
});

test("answerLooksLikeNotFound recognises honest not-found answers and leaves positive answers alone", () => {
  for (const answer of [
    "The handout does not mention a late penalty.",
    "I couldn't find a late policy in the syllabus or the lab handout.",
    "The late penalty is not specified in the course materials I checked.",
    "There is no information about late submissions in the documents.",
    "I was unable to find the rubric.",
    "None of the sources I read state a penalty.",
  ]) {
    assert.equal(answerLooksLikeNotFound(answer), true, answer);
  }
  for (const answer of [
    "Late submissions lose 10% per day (Lab4.pdf, Submission).",
    "I think the spec might mention a waveform screenshot.",
    "The demo is worth 60% and the report 40%, so do not skip the report.",
    "Yes: the handout mentions a two-page report.",
  ]) {
    assert.equal(answerLooksLikeNotFound(answer), false, answer);
  }
});

test("verification attaches the checked-sources trail to a not-found answer instead of a bare tentative note", () => {
  const verified = verifyWorkspaceAnswer({
    question: "Is there a late penalty for Lab 4?",
    answer:
      "I couldn't find a late penalty for Lab 4: the handout's Submission section gives the due date but no penalty, and the syllabus defers to the handout.",
    observations: buildLatePolicyTrail(),
    usedWorkup: false,
    loaded: LOADED,
  });

  assert.ok(verified.checkedSources);
  assert.ok(
    verified.note?.startsWith("Not found after checking: Lab4.pdf (read in full); "),
    verified.note ?? "(null)"
  );
  assert.ok(verified.note?.includes('course search for "penalty per day" (no matches)'));
  assert.ok(verified.note?.includes("rubric.pdf (could not read: no extracted text)"));
  assert.ok(verified.note?.endsWith("."));
  // A not-found answer must not be quietly downgraded for missing figures it
  // never claimed.
  assert.notEqual(verified.confidence, "low");
});

test("verification keeps the trail off positive answers but still exposes it for callers", () => {
  const verified = verifyWorkspaceAnswer({
    question: "When is Lab 4 due?",
    answer: "Lab 4 is due on Canvas by Friday March 27 (Lab4.pdf, Submission).",
    observations: buildLatePolicyTrail(),
    usedWorkup: false,
    loaded: LOADED,
  });

  assert.equal(verified.confidence, "high");
  assert.equal(verified.note, null);
  assert.ok(verified.checkedSources?.startsWith("Lab4.pdf (read in full)"));
});

test("verification leaves a not-found answer alone when nothing was actually checked", () => {
  const verified = verifyWorkspaceAnswer({
    question: "Is there a late penalty for Lab 4?",
    answer: "I couldn't find a late penalty.",
    observations: [],
    usedWorkup: false,
    loaded: LOADED,
  });

  assert.equal(verified.checkedSources, null);
  assert.equal(verified.note, null);
});

test("finalizeAnswerText names what was checked when the loop produced no answer", () => {
  assert.equal(
    finalizeAnswerText("", ["answer"]),
    "I wasn't able to find a clear answer."
  );
  assert.equal(
    finalizeAnswerText("", ["answer"], null),
    "I wasn't able to find a clear answer."
  );
  assert.equal(
    finalizeAnswerText(
      "  ",
      ["answer"],
      'Lab4.pdf (read in full); course search for "penalty" (no matches)'
    ),
    'I wasn\'t able to find a clear answer after checking: Lab4.pdf (read in full); course search for "penalty" (no matches).'
  );
  assert.equal(
    finalizeAnswerText("The zip is due March 27.", [], "Lab4.pdf (read in full)"),
    "The zip is due March 27."
  );
});

test("/ask prompt asks for a complete, well-cited answer instead of capping it at a few sentences", () => {
  assert.ok(!/2-4 sentences/.test(ASK_SYSTEM_PROMPT));
  assert.ok(!/Be concise/.test(ASK_SYSTEM_PROMPT));
  assert.ok(/complete/i.test(ASK_SYSTEM_PROMPT));
  assert.ok(/as long as it needs to be/i.test(ASK_SYSTEM_PROMPT));
  assert.ok(/name the (?:source )?document/i.test(ASK_SYSTEM_PROMPT));
});
