import assert from "node:assert/strict";
import test from "node:test";
import { splitDocumentIntoSections } from "../src/agent/verify.js";
import { buildDocumentReadView, findRawHeadingSection } from "../src/tui/chat-agent/tool-execution.js";

// A lecture deck where page 12 is an image-only slide: the heading is there
// but it has no body, so the section splitter folds it into its neighbour.
function buildDeck(): string {
  const lines: string[] = [];
  for (let page = 1; page <= 20; page += 1) {
    lines.push(`## Page ${page}`);
    if (page !== 12) {
      lines.push(`Slide ${page} discusses topic ${page} in some detail. `.repeat(6).trim());
    }
    lines.push("");
  }
  return lines.join("\n");
}

test("fixture: the section splitter folds the image-only page into a neighbour", () => {
  const labels = splitDocumentIntoSections(buildDeck())
    .map((section) => section.label)
    .filter(Boolean);
  assert.ok(labels.includes("Page 11"), "sanity: normal pages are labelled");
  assert.ok(!labels.includes("Page 12"), "precondition: the empty page is not a section of its own");
});

test("read_file section lookup falls back to the raw heading for a folded page", () => {
  const view = buildDocumentReadView(buildDeck(), { section: "Page 12" });
  assert.equal(view.unmatchedSection, null, "should no longer report the section as unknown");
  assert.equal(view.sectionLabel, "Page 12");
  assert.match(view.content, /^Page 12\n/);
  assert.match(view.content, /no extractable text/);
  assert.ok(!view.content.includes("Slide 13"), "must stop at the next heading");
});

test("raw heading fallback accepts page spellings and heading fragments", () => {
  const deck = buildDeck();
  assert.equal(findRawHeadingSection(deck, "p. 12")?.label, "Page 12");
  assert.equal(findRawHeadingSection(deck, "12")?.label, "Page 12");
  const doc = "# Lab 4\n\n## Part 3: Driving the HEX displays\nBody text.\n\n## Part 4\nMore.";
  const hit = findRawHeadingSection(doc, "driving the hex");
  assert.equal(hit?.label, "Part 3: Driving the HEX displays");
  assert.equal(hit?.text, "Body text.");
  assert.equal(findRawHeadingSection(doc, "Part 9"), null);
});

test("a normal section request still resolves through the splitter first", () => {
  const view = buildDocumentReadView(buildDeck(), { section: "Page 11" });
  assert.equal(view.sectionLabel, "Page 11");
  assert.notEqual(view.sectionIndex, null);
  assert.match(view.content, /Slide 11 discusses/);
});
