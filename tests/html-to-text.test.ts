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
