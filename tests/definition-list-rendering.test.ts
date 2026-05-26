import assert from "node:assert/strict";
import test from "node:test";
import { htmlToText } from "../src/format/html-to-text.js";

test("definition list renders as bold term with colon-separated values", () => {
  const html = `
<dl>
  <dt>Late Policy</dt>
  <dd>10% deduction per day, up to 5 days</dd>
  <dt>Office Hours</dt>
  <dd>Monday and Wednesday, 2-4pm in Room 302</dd>
</dl>`;

  const text = htmlToText(html);
  assert.ok(text.includes("**Late Policy**: 10% deduction per day"), text);
  assert.ok(text.includes("**Office Hours**: Monday and Wednesday"), text);
});

test("definition list preserves links inside dd elements", () => {
  const html = `
<dl>
  <dt>Textbook</dt>
  <dd>Available at <a href="https://publisher.com/book">publisher site</a></dd>
</dl>`;

  const text = htmlToText(html, { baseUrl: "https://canvas.example.com" });
  assert.ok(text.includes("**Textbook**:"), text);
  assert.ok(text.includes("publisher site (https://publisher.com/book)"), text);
});

test("definition list with multiple dd for one dt groups correctly", () => {
  const html = `
<dl>
  <dt>Prerequisites</dt>
  <dd>CS 101 - Introduction to Programming</dd>
  <dd>MATH 200 - Linear Algebra</dd>
</dl>`;

  const text = htmlToText(html);
  assert.ok(text.includes("**Prerequisites**: CS 101"), text);
  assert.ok(text.includes("MATH 200"), text);
});

test("definition list with no dt still renders dd content", () => {
  const html = `
<dl>
  <dd>Standalone definition without a term</dd>
</dl>`;

  const text = htmlToText(html);
  assert.ok(text.includes("Standalone definition without a term"), text);
});

test("definition list integrates with surrounding content", () => {
  const html = `
<h2>Course Policies</h2>
<dl>
  <dt>Attendance</dt>
  <dd>Required for all lectures</dd>
</dl>
<p>Review these policies carefully.</p>`;

  const text = htmlToText(html);
  assert.ok(text.includes("Course Policies"), text);
  assert.ok(text.includes("**Attendance**: Required for all lectures"), text);
  assert.ok(text.includes("Review these policies carefully"), text);
});
