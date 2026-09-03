import assert from "node:assert/strict";
import test from "node:test";
import { htmlToText } from "../src/format/html-to-text.js";

test("htmlToText preserves structure from lists, tables, figures, and embeds", () => {
  const html = [
    "<h2>Lab Instructions</h2>",
    '<ol start="3">',
    '<li>Read the <a href="pages/shared-spec">shared spec</a></li>',
    "<li>Submit your waveform</li>",
    "</ol>",
    "<table>",
    "<tr><th>Item</th><th>Weight</th></tr>",
    "<tr><td>Lab 4</td><td>10%</td></tr>",
    "</table>",
    '<figure><img src="/images/waveform.png" alt="Waveform example"><figcaption>Reference waveform</figcaption></figure>',
    '<iframe src="/media/demo" title="ALU walkthrough"></iframe>',
  ].join("");

  const text = htmlToText(html, {
    baseUrl: "https://canvas.example/courses/17/modules",
  });

  assert.match(text, /### Lab Instructions/);
  assert.match(
    text,
    /3\. Read the shared spec \(https:\/\/canvas\.example\/courses\/17\/pages\/shared-spec\)/
  );
  assert.match(text, /4\. Submit your waveform/);
  assert.match(text, /Table:\n- Item: Lab 4 \| Weight: 10%/);
  assert.match(
    text,
    /Figure: Image: Waveform example \(https:\/\/canvas\.example\/images\/waveform\.png\) — Caption: Reference waveform/
  );
  assert.match(
    text,
    /Embedded content: ALU walkthrough \(https:\/\/canvas\.example\/media\/demo\)/
  );
});

test("htmlToText carries rowspan cells down into the rows they span", () => {
  // A typical course schedule: the week cell spans two day rows.
  const html = [
    "<table>",
    "<thead><tr><th>Week</th><th>Day</th><th>Topic</th></tr></thead>",
    "<tbody>",
    '<tr><td rowspan="2">Week 1</td><td>Mon</td><td>Intro to C</td></tr>',
    "<tr><td>Wed</td><td>Variables and types</td></tr>",
    '<tr><td rowspan="2">Week 2</td><td>Mon</td><td>Pointers</td></tr>',
    "<tr><td>Wed</td><td>Arrays</td></tr>",
    "</tbody>",
    "</table>",
  ].join("");

  const text = htmlToText(html);

  assert.match(text, /- Week: Week 1 \| Day: Mon \| Topic: Intro to C/);
  assert.match(text, /- Week: Week 1 \| Day: Wed \| Topic: Variables and types/);
  assert.match(text, /- Week: Week 2 \| Day: Wed \| Topic: Arrays/);
  assert.doesNotMatch(text, /Week: Wed/, "spanned rows must not shift left");
});

test("htmlToText expands colspan header groups into per-column keys", () => {
  const html = [
    "<table>",
    '<tr><th rowspan="2">Assessment</th><th colspan="2">Weight</th></tr>',
    "<tr><th>Undergrad</th><th>Grad</th></tr>",
    "<tr><td>Midterm</td><td>25%</td><td>20%</td></tr>",
    '<tr><td>Final</td><td colspan="2">40%</td></tr>',
    "</table>",
  ].join("");

  const text = htmlToText(html);

  assert.match(
    text,
    /- Assessment: Midterm \| Weight – Undergrad: 25% \| Weight – Grad: 20%/
  );
  assert.match(text, /- Assessment: Final \| Weight – Undergrad \/ Weight – Grad: 40%/);
});

test("htmlToText keeps nested tables and table captions", () => {
  const html = [
    "<table>",
    "<caption>Grading breakdown</caption>",
    "<tr><th>Component</th><th>Details</th></tr>",
    "<tr><td>Labs</td><td><table><tr><th>Lab</th><th>Due</th></tr><tr><td>Lab 1</td><td>Sep 12</td></tr><tr><td>Lab 2</td><td>Sep 26</td></tr></table></td></tr>",
    "<tr><td>Final</td><td>40%</td></tr>",
    "</table>",
  ].join("");

  const text = htmlToText(html);

  assert.match(text, /Table: Grading breakdown/);
  assert.match(text, /- Component: Labs \| Details: Lab: Lab 1 \| Due: Sep 12; Lab: Lab 2 \| Due: Sep 26/);
  assert.match(text, /- Component: Final \| Details: 40%/);
});

test("htmlToText renders definition lists as term: definition lines", () => {
  const html = [
    "<dl>",
    "<dt>Office hours</dt><dd>Monday 2-4pm, ENG 214</dd>",
    "<dt>Email</dt><dd>prof@example.edu</dd><dd>Reply within 48h</dd>",
    "</dl>",
  ].join("");

  const text = htmlToText(html);

  assert.match(text, /- Office hours: Monday 2-4pm, ENG 214/);
  assert.match(text, /- Email: prof@example\.edu; Reply within 48h/);
  assert.doesNotMatch(text, /hoursMonday/);
});

test("htmlToText keys row-header tables on their first cell", () => {
  const html = [
    "<table>",
    "<tr><th>Instructor</th><td>Prof. Grace</td></tr>",
    "<tr><th>Office</th><td>ENG 214</td></tr>",
    "<tr><th>Office hours</th><td>Mon 2-4pm</td><td>Thu 10-11am</td></tr>",
    "</table>",
  ].join("");

  const text = htmlToText(html);

  assert.match(text, /- Instructor: Prof\. Grace/);
  assert.match(text, /- Office: ENG 214/);
  assert.match(text, /- Office hours: Mon 2-4pm \| Thu 10-11am/);
  assert.doesNotMatch(text, /Instructor: Office/);
});
