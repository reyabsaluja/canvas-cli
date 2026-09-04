import assert from "node:assert/strict";
import test from "node:test";
import type { Observation, ToolExecutionResult } from "../src/agent/observation.js";
import { appendObservation, createEmptyRunState } from "../src/agent/run-state.js";
import {
  RECOVERY_SEPARATOR,
  runPostAnswerRecovery,
  type RecoveryToolCall,
} from "../src/tui/chat-agent/recovery.js";
import {
  selectComplementaryRecoveryReadArtifactId,
  selectComplementarySearchToolCalls,
  selectNoInfoRecoveryToolCalls,
  selectThreadRecoveryTopic,
  selectUngroundedSearchRecoveryReadArtifactId,
  shouldGroundUnverifiedAnswer,
  shouldRecoverFromNoInfoAnswer,
  shouldRegenerateAnswerAfterRecoveryRead,
} from "../src/tui/chat-agent/verification.js";
import type { ToolCallEvent } from "../src/tui/chat-agent/types.js";

function groundedRead(title: string, content: string): Observation {
  return {
    tool: "read_file",
    status: "ok",
    summary: `Read ${title}.`,
    artifacts: [{ artifactId: `art:${title}`, title, kind: "attachment", excerpt: content }],
    content,
  };
}

function searchHit(title: string, excerpt: string, query = title): Observation {
  return {
    tool: "search_workspace",
    status: "ok",
    summary: `Found 1 relevant workspace matches for "${query}".`,
    artifacts: [{ artifactId: `art:${title}`, title, kind: "attachment", excerpt }],
  };
}

function toolResult(observation: Observation, text = observation.summary): ToolExecutionResult {
  return { observation, modelText: text, uiText: text };
}

interface Harness {
  calls: RecoveryToolCall[];
  reads: string[];
  deltas: string[];
  events: ToolCallEvent[];
  regenerations: Observation[][];
}

/**
 * Wire runPostAnswerRecovery to fakes: tool calls and reads come from lookup
 * tables, the regenerated answer is a fixed string streamed through
 * onTextDelta like answerWithoutTools does.
 */
function createHarness(input: {
  question: string;
  answer: string;
  toolNames: string[];
  turnObservations: Observation[];
  toolResults?: Record<string, ToolExecutionResult | ((input: Record<string, unknown>) => ToolExecutionResult)>;
  readResults?: Record<string, ToolExecutionResult>;
  regeneratedAnswer?: string;
}): { harness: Harness; run: () => ReturnType<typeof runPostAnswerRecovery> } {
  const runState = createEmptyRunState();
  for (const observation of input.turnObservations) {
    appendObservation(runState, observation);
  }
  const harness: Harness = { calls: [], reads: [], deltas: [], events: [], regenerations: [] };
  const regeneratedAnswer = input.regeneratedAnswer ?? "Regenerated answer.";
  const run = () =>
    runPostAnswerRecovery({
      question: input.question,
      answer: input.answer,
      toolNames: input.toolNames,
      runState,
      observationStart: 0,
      executeRecoveryToolCall: async (name, callInput) => {
        harness.calls.push({ name, input: callInput });
        const entry = input.toolResults?.[name];
        const result =
          typeof entry === "function"
            ? entry(callInput)
            : entry ??
              toolResult({ tool: name, status: "not_found", summary: `Nothing for ${name}.`, artifacts: [] });
        return { result, deduped: false };
      },
      readRecoveryArtifact: async (artifactId) => {
        harness.reads.push(artifactId);
        return (
          input.readResults?.[artifactId] ??
          toolResult({
            tool: "read_file",
            status: "not_found",
            summary: `Could not read artifact "${artifactId}".`,
            artifacts: [],
          })
        );
      },
      regenerateAnswer: async (observations) => {
        harness.regenerations.push(observations);
        harness.deltas.push(regeneratedAnswer);
        return regeneratedAnswer;
      },
      onToolCall: (event) => harness.events.push(event),
      onTextDelta: (delta) => harness.deltas.push(delta),
    });
  return { harness, run };
}

test("a not-found answer after one read triggers list_assignments, then a workspace search", async () => {
  const { harness, run } = createHarness({
    question: "When is Lab 4 due?",
    answer: "I don't see a due date in the lab handout.",
    toolNames: ["search_workspace", "read_file", "list_files", "list_assignments"],
    turnObservations: [groundedRead("lab4-spec.txt", "Lab 4 setup instructions. Build the timer.")],
  });

  const result = await run();

  assert.deepEqual(harness.calls, [
    { name: "list_assignments", input: {} },
    { name: "search_workspace", input: { query: "lab 4 due" } },
  ]);
  assert.equal(harness.reads.length, 0);
  assert.equal(result.regenerated, false);
  assert.equal(result.answer, "I don't see a due date in the lab handout.");
  // Every recovery call is surfaced to the UI like a normal tool call.
  assert.deepEqual(
    harness.events.map((event) => [event.action, event.target, event.color]),
    [
      ["list", "assignments", "red"],
      ["search", "lab 4 due", "red"],
    ]
  );
});

test("a not-found answer regenerates once a recovery call brings grounded evidence", async () => {
  const listing: Observation = {
    tool: "list_assignments",
    status: "ok",
    summary: "Listed 2 assignments for this course.",
    artifacts: [{ artifactId: "course:assignments:17", title: "Assignments", kind: "assignment" }],
    content: "- Lab 3 — Mar 20, 11:59 PM\n- Lab 4 — Mar 27, 11:59 PM",
  };
  const { harness, run } = createHarness({
    question: "When is Lab 4 due?",
    answer: "I don't see a due date in the lab handout.",
    toolNames: ["search_workspace", "read_file", "list_assignments"],
    turnObservations: [groundedRead("lab4-spec.txt", "Lab 4 setup instructions.")],
    toolResults: { list_assignments: toolResult(listing, listing.content) },
    regeneratedAnswer: "Lab 4 is due Mar 27 at 11:59 PM.",
  });

  const result = await run();

  assert.deepEqual(harness.calls.map((call) => call.name), ["list_assignments"]);
  assert.equal(result.regenerated, true);
  assert.equal(result.answer, "Lab 4 is due Mar 27 at 11:59 PM.");
  assert.ok(harness.regenerations[0]?.includes(listing));
  assert.ok(result.verificationObservations.includes(listing));
  assert.equal(harness.deltas[0], RECOVERY_SEPARATOR);
});

test("a dated answer from a search-only turn reads the breadcrumb, streams a separator, and regenerates", async () => {
  const breadcrumb = searchHit("lab4.pdf", "Lab 4 is due March 27 at 11:59 PM.", "lab 4 due");
  const read = groundedRead("lab4.pdf", "## Submission\n\nLab 4 is due Friday March 27 at 11:59 PM.");
  const { harness, run } = createHarness({
    question: "When is Lab 4 due?",
    answer: "Lab 4 is due March 27.",
    toolNames: ["search_workspace", "read_file", "list_files"],
    turnObservations: [breadcrumb],
    readResults: { "art:lab4.pdf": toolResult(read, read.content) },
    regeneratedAnswer: "Lab 4 is due Friday March 27 at 11:59 PM (lab4.pdf — Submission).",
  });

  const result = await run();

  assert.deepEqual(harness.reads, ["art:lab4.pdf"]);
  assert.equal(harness.calls.length, 0);
  assert.equal(result.regenerated, true);
  assert.equal(result.answer, "Lab 4 is due Friday March 27 at 11:59 PM (lab4.pdf — Submission).");
  assert.deepEqual(harness.deltas, [
    RECOVERY_SEPARATOR,
    "Lab 4 is due Friday March 27 at 11:59 PM (lab4.pdf — Submission).",
  ]);
  assert.deepEqual(
    harness.events.map((event) => [event.action, event.target, event.color]),
    [["read", "lab4.pdf", "green"]]
  );
  assert.ok(result.verificationObservations.some((observation) => observation.content === read.content));
  assert.ok(harness.regenerations[0]?.some((observation) => observation.content === read.content));
});

test("a search-only answer without a checkable figure is left alone", async () => {
  const breadcrumb = searchHit("lab4.pdf", "Lab 4 asks you to build a timer.", "lab 4 timer");
  const { harness, run } = createHarness({
    question: "What is Lab 4 about?",
    answer: "It is a hardware timer exercise.",
    toolNames: ["search_workspace", "read_file", "list_files"],
    turnObservations: [breadcrumb],
  });

  const result = await run();

  assert.equal(harness.reads.length, 0);
  assert.equal(harness.calls.length, 0);
  assert.equal(result.regenerated, false);
  assert.deepEqual(harness.deltas, []);
});

test("a grounded answer makes no extra calls", async () => {
  const { harness, run } = createHarness({
    question: "When is Lab 4 due?",
    answer: "Lab 4 is due March 27 at 11:59 PM.",
    toolNames: ["search_workspace", "read_file", "list_files", "list_assignments"],
    turnObservations: [
      searchHit("lab4.pdf", "Lab 4 is due March 27 at 11:59 PM.", "lab 4 due"),
      groundedRead("lab4.pdf", "## Submission\n\nLab 4 is due Friday March 27 at 11:59 PM."),
    ],
  });

  const result = await run();

  assert.equal(harness.calls.length, 0);
  assert.equal(harness.reads.length, 0);
  assert.equal(result.regenerated, false);
  assert.deepEqual(harness.deltas, []);
  assert.equal(result.answer, "Lab 4 is due March 27 at 11:59 PM.");
});

test("an empty answer still recovers through a breadcrumb read and regenerates", async () => {
  const breadcrumb = searchHit("lab4.pdf", "Lab 4 is due March 27 at 11:59 PM.", "lab 4 due");
  const read = groundedRead("lab4.pdf", "Lab 4 is due Friday March 27 at 11:59 PM.");
  const { harness, run } = createHarness({
    question: "When is Lab 4 due?",
    answer: "",
    toolNames: ["search_workspace", "read_file"],
    turnObservations: [breadcrumb],
    readResults: { "art:lab4.pdf": toolResult(read, read.content) },
  });

  const result = await run();

  assert.deepEqual(harness.reads, ["art:lab4.pdf"]);
  assert.equal(result.regenerated, true);
  // No separator when there was no first answer to separate from.
  assert.deepEqual(harness.deltas, ["Regenerated answer."]);
});

test("a failed recovery read keeps the first answer and closes the separator", async () => {
  const breadcrumb = searchHit("lab4.pdf", "Lab 4 is due March 27 at 11:59 PM.", "lab 4 due");
  const { harness, run } = createHarness({
    question: "When is Lab 4 due?",
    answer: "Lab 4 is due March 27.",
    toolNames: ["search_workspace", "read_file"],
    turnObservations: [breadcrumb],
  });

  const result = await run();

  assert.deepEqual(harness.reads, ["art:lab4.pdf"]);
  assert.equal(result.regenerated, false);
  assert.equal(result.answer, "Lab 4 is due March 27.");
  assert.equal(harness.deltas[0], RECOVERY_SEPARATOR);
  assert.equal(harness.deltas.length, 2);
  assert.match(harness.deltas[1] ?? "", /answer above stands/i);
});

test("announcement listings lead to a read_thread of the best-matching unread topic", async () => {
  const listing: Observation = {
    tool: "list_announcements",
    status: "ok",
    summary: 'Listed 2 announcements matching "Lab 4".',
    artifacts: [],
    content: [
      "**Announcements** (2 items)",
      "",
      "[A] General Lab Update — Prof. Ada — ECE243 — 2d ago",
      "[A] Lab 4 Clarification — Prof. Ada — ECE243 — 1d ago",
    ].join("\n"),
  };
  const thread: Observation = {
    tool: "read_thread",
    status: "ok",
    summary: 'Read discussion thread for "Lab 4 Clarification".',
    artifacts: [{ artifactId: "course:thread:17:lab-4-clarification", title: "Lab 4 Clarification", kind: "announcement" }],
    content: "Lab 4 Clarification: the branch hazard waveform must show two stall cycles.",
  };
  const { harness, run } = createHarness({
    question: "What did the Lab 4 clarification announcement say about branch hazards?",
    answer: "There is a Lab 4 Clarification announcement, but I did not read its contents.",
    toolNames: ["search_workspace", "read_file", "list_announcements", "read_thread"],
    turnObservations: [listing],
    toolResults: { read_thread: toolResult(thread, thread.content) },
    regeneratedAnswer: "The clarification says the waveform must show two stall cycles.",
  });

  const result = await run();

  assert.deepEqual(harness.calls, [{ name: "read_thread", input: { topic: "Lab 4 Clarification" } }]);
  assert.equal(result.regenerated, true);
  assert.equal(result.answer, "The clarification says the waveform must show two stall cycles.");
});

test("comparison questions grounded in one source search for and read the complementary source", async () => {
  const referenceRead = groundedRead(
    "docs/reference.txt",
    "The reference says the waveform must show stall cycles around the branch hazard."
  );
  const walkthroughBreadcrumb: Observation = {
    tool: "search_workspace",
    status: "ok",
    summary: 'Found 2 relevant workspace matches for "branch hazard walkthrough reference".',
    artifacts: [
      {
        artifactId: "art:docs/reference.txt",
        title: "docs/reference.txt",
        kind: "extracted",
        excerpt: "The reference says the waveform must show stall cycles around the branch hazard.",
      },
      {
        artifactId: "art:docs/walkthrough.txt",
        title: "docs/walkthrough.txt",
        kind: "extracted",
        excerpt: "The walkthrough explains each branch hazard stall step by step.",
      },
    ],
  };
  const walkthroughRead = groundedRead(
    "docs/walkthrough.txt",
    "The walkthrough explains each branch hazard stall step by step."
  );
  const { harness, run } = createHarness({
    question: "Compare the branch hazard walkthrough to the reference.",
    answer: "The reference requires stall cycles around the branch hazard.",
    toolNames: ["search_workspace", "search_course", "read_file"],
    turnObservations: [referenceRead],
    toolResults: {
      search_workspace: toolResult(walkthroughBreadcrumb),
    },
    readResults: { "art:docs/walkthrough.txt": toolResult(walkthroughRead, walkthroughRead.content) },
    regeneratedAnswer: "Both agree on stall cycles; the walkthrough adds step-by-step detail.",
  });

  const result = await run();

  assert.deepEqual(harness.calls, [
    { name: "search_workspace", input: { query: "branch hazard walkthrough reference" } },
  ]);
  assert.deepEqual(harness.reads, ["art:docs/walkthrough.txt"]);
  assert.equal(result.regenerated, true);
});

test("selectors: no-info recovery proposes untried tools in order and skips repeats", () => {
  assert.equal(shouldRecoverFromNoInfoAnswer("I couldn't find that information."), true);
  assert.equal(shouldRecoverFromNoInfoAnswer("The handout does not mention a late penalty."), true);
  assert.equal(shouldRecoverFromNoInfoAnswer("Lab 4 is due March 27."), false);
  assert.equal(shouldRecoverFromNoInfoAnswer(""), false);

  assert.deepEqual(
    selectNoInfoRecoveryToolCalls(
      "What did the prof say about extensions?",
      ["list_announcements", "read_thread", "search_workspace", "search_course"],
      []
    ),
    [
      { name: "list_announcements", input: { filter: "all", query: "extensions" } },
      { name: "search_workspace", input: { query: "extensions" } },
      { name: "search_course", input: { query: "extensions" } },
    ]
  );

  assert.deepEqual(
    selectNoInfoRecoveryToolCalls(
      "What format should I submit in?",
      ["search_workspace", "search_course", "list_files"],
      [
        {
          tool: "search_workspace",
          status: "not_found",
          summary: 'No relevant workspace content found for "format submit".',
          artifacts: [],
        },
      ]
    ),
    [{ name: "search_course", input: { query: "format submit" } }]
  );

  assert.deepEqual(
    selectNoInfoRecoveryToolCalls("What is the course about?", ["search_workspace", "list_files"], [
      {
        tool: "search_workspace",
        status: "not_found",
        summary: 'No relevant workspace content found for "course".',
        artifacts: [],
      },
    ]),
    [{ name: "list_files", input: {} }]
  );
});

test("selectors: ungrounded-answer detection needs a breadcrumb, an unread artifact, and a checkable claim", () => {
  const breadcrumb = searchHit("lab4-rubric.pdf", "The rubric gives 30% credit for waveform evidence.", "rubric waveform");
  const overviewRead = groundedRead("lab4-overview.txt", "The lab overview mentions waveform evidence.");
  const question = "What does the rubric say about waveform evidence?";

  assert.equal(
    selectUngroundedSearchRecoveryReadArtifactId(question, [overviewRead, breadcrumb]),
    "art:lab4-rubric.pdf"
  );
  assert.equal(
    shouldGroundUnverifiedAnswer("The rubric gives 30% credit for waveform evidence.", [overviewRead, breadcrumb], question),
    true
  );
  // An answer that echoes the breadcrumb strongly counts even without a figure.
  assert.equal(
    shouldGroundUnverifiedAnswer(
      "The lab4-rubric.pdf rubric rewards waveform evidence.",
      [breadcrumb],
      question
    ),
    true
  );
  assert.equal(shouldGroundUnverifiedAnswer("Waveform evidence is rewarded.", [breadcrumb], question), false);
  assert.equal(shouldGroundUnverifiedAnswer("", [breadcrumb], question), false);
  assert.equal(
    shouldGroundUnverifiedAnswer("The rubric gives 30% credit.", [breadcrumb, groundedRead("lab4-rubric.pdf", "30% for waveform evidence.")], question),
    false
  );

  const rubricRead = groundedRead("lab4-rubric.pdf", "The rubric gives 30% credit for waveform evidence.");
  assert.equal(
    shouldRegenerateAnswerAfterRecoveryRead({
      answer: "The rubric gives 30% credit for waveform evidence.",
      question,
      beforeRecoveryObservations: [breadcrumb],
      afterRecoveryObservations: [breadcrumb, rubricRead],
    }),
    true
  );
  assert.equal(
    shouldRegenerateAnswerAfterRecoveryRead({
      answer: "The rubric gives 30% credit for waveform evidence.",
      question,
      beforeRecoveryObservations: [breadcrumb],
      afterRecoveryObservations: [breadcrumb],
    }),
    false
  );
});

test("selectors: thread and complementary recovery pick unread targets only", () => {
  const listing: Observation = {
    tool: "list_announcements",
    status: "ok",
    summary: 'Listed 2 announcements matching "Lab 4".',
    artifacts: [],
    content: "[A] General Lab Update — Prof. Ada — ECE243 — 2d ago\n[A] Lab 4 Clarification — Prof. Ada — ECE243 — 1d ago",
  };
  const question = "What did the Lab 4 clarification announcement say about branch hazards?";
  assert.equal(selectThreadRecoveryTopic(question, [listing]), "Lab 4 Clarification");
  assert.equal(selectThreadRecoveryTopic("Are there any Lab 4 announcements?", [listing]), null);
  assert.equal(
    selectThreadRecoveryTopic(question, [
      listing,
      {
        tool: "read_thread",
        status: "ok",
        summary: 'Read discussion thread for "Lab 4 Clarification".',
        artifacts: [{ artifactId: "course:thread:1", title: "Lab 4 Clarification", kind: "announcement" }],
        content: "Lab 4 Clarification: two stall cycles around the branch hazard.",
      },
    ]),
    null
  );

  const referenceRead = groundedRead("docs/reference.txt", "The reference says the waveform must show stall cycles around the branch hazard.");
  const breadcrumb: Observation = {
    tool: "search_workspace",
    status: "ok",
    summary: 'Found 2 relevant workspace matches for "branch hazard walkthrough reference".',
    artifacts: [
      { artifactId: "art:docs/reference.txt", title: "docs/reference.txt", kind: "extracted", excerpt: "stall cycles around the branch hazard" },
      { artifactId: "art:docs/walkthrough.txt", title: "docs/walkthrough.txt", kind: "extracted", excerpt: "each branch hazard stall step by step" },
    ],
  };
  const compare = "Compare the branch hazard walkthrough to the reference.";
  assert.equal(selectComplementaryRecoveryReadArtifactId(compare, [referenceRead, breadcrumb]), "art:docs/walkthrough.txt");
  assert.equal(selectComplementaryRecoveryReadArtifactId("Explain the branch hazard reference.", [referenceRead, breadcrumb]), null);
  assert.equal(
    selectComplementaryRecoveryReadArtifactId(compare, [
      referenceRead,
      breadcrumb,
      groundedRead("docs/walkthrough.txt", "The walkthrough explains each branch hazard stall step by step."),
    ]),
    null
  );

  assert.deepEqual(
    selectComplementarySearchToolCalls(compare, ["search_workspace", "search_course", "read_file"], [referenceRead]),
    [
      { name: "search_workspace", input: { query: "branch hazard walkthrough reference" } },
      { name: "search_course", input: { query: "branch hazard walkthrough reference" } },
    ]
  );
  assert.deepEqual(
    selectComplementarySearchToolCalls(compare, ["search_workspace", "search_course", "read_file"], [referenceRead, breadcrumb]),
    []
  );
});

// A grounded read this turn supplies the evidence the answer's figures are
// checked against; only a figure that read does not contain sends recovery to
// the unread hit.
function latePolicyBreadcrumb(): Observation {
  return {
    tool: "search_workspace",
    status: "ok",
    summary: 'Found 2 relevant workspace matches for "late penalty".',
    artifacts: [
      {
        artifactId: "art:syllabus.pdf",
        title: "syllabus.pdf",
        kind: "attachment",
        excerpt: "Late work loses 10% per day.",
      },
      {
        artifactId: "art:lab1.pdf",
        title: "lab1.pdf",
        kind: "attachment",
        excerpt: "Lab 1 late penalty: 10% per day, capped at 50%.",
      },
    ],
  };
}

test("an answer whose figure comes from this turn's grounded read is not re-checked against the unread hit", async () => {
  const syllabusRead = groundedRead("syllabus.pdf", "## Late Policy\n\nLate work loses 10% per day.");
  const lab1Read = groundedRead("lab1.pdf", "Lab 1 late penalty: 10% per day, capped at 50%.");
  const { harness, run } = createHarness({
    question: "What is the late penalty?",
    answer: "Late work loses 10% per day (syllabus.pdf — Late Policy).",
    toolNames: ["search_workspace", "read_file", "list_files"],
    turnObservations: [latePolicyBreadcrumb(), syllabusRead],
    readResults: { "art:lab1.pdf": toolResult(lab1Read, lab1Read.content) },
  });

  const result = await run();

  assert.deepEqual(harness.reads, [], "the other search hit must not be read");
  assert.deepEqual(harness.calls, []);
  assert.equal(result.regenerated, false);
  assert.deepEqual(harness.deltas, [], "no separator is streamed when the answer is grounded");
  assert.equal(result.answer, "Late work loses 10% per day (syllabus.pdf — Late Policy).");
  assert.equal(
    shouldGroundUnverifiedAnswer(
      "Late work loses 10% per day.",
      [latePolicyBreadcrumb(), syllabusRead],
      "What is the late penalty?"
    ),
    false
  );
});

test("an answer with a figure the grounded read does not contain still reads the unread hit and regenerates", async () => {
  const syllabusRead = groundedRead("syllabus.pdf", "## Late Policy\n\nLate work loses 10% per day.");
  const lab1Read = groundedRead("lab1.pdf", "Lab 1 late penalty: 10% per day, capped at 50%.");
  const { harness, run } = createHarness({
    question: "What is the late penalty?",
    answer: "Late work loses 10% per day, capped at 50%.",
    toolNames: ["search_workspace", "read_file", "list_files"],
    turnObservations: [latePolicyBreadcrumb(), syllabusRead],
    readResults: { "art:lab1.pdf": toolResult(lab1Read, lab1Read.content) },
    regeneratedAnswer: "The syllabus says 10% per day; Lab 1 caps the penalty at 50% (lab1.pdf).",
  });

  const result = await run();

  assert.deepEqual(harness.reads, ["art:lab1.pdf"]);
  assert.equal(result.regenerated, true);
  assert.equal(harness.deltas[0], RECOVERY_SEPARATOR);
  assert.ok(harness.regenerations[0]?.some((observation) => observation.content === lab1Read.content));
});

test("thread recovery skips a listing whose titles share nothing with the question", async () => {
  const listing: Observation = {
    tool: "list_announcements",
    status: "ok",
    summary: "Listed 2 announcements for this course.",
    artifacts: [],
    content: [
      "**Announcements** (2 items)",
      "",
      "[A] Welcome to the course — Prof. Ada — ECE243 — 30d ago",
      "[A] Office hours moved — Prof. Ada — ECE243 — 2d ago",
    ].join("\n"),
  };
  const question = "what did the professor say about the midterm";
  assert.equal(selectThreadRecoveryTopic(question, [listing]), null);

  const { harness, run } = createHarness({
    question,
    answer: "The two announcements posted are a course welcome and an office-hours change; neither mentions the midterm.",
    toolNames: ["search_workspace", "read_file", "list_announcements", "read_thread"],
    turnObservations: [listing],
  });

  const result = await run();

  assert.ok(
    !harness.calls.some((call) => call.name === "read_thread"),
    `must not open an off-topic post, got ${JSON.stringify(harness.calls)}`
  );
  assert.equal(result.regenerated, false);
});
