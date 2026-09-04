import assert from "node:assert/strict";
import test from "node:test";
import { htmlToText } from "../src/format/html-to-text.js";

const BASE = "https://canvas.example/courses/17/pages/lab-3";

test("htmlToText renders <pre> as a fenced block with indentation intact", () => {
  const html = [
    "<p>Starter code:</p>",
    '<pre><code class="language-python">def main():\n    for i in range(3):\n        print(i)\t# tab comment\n\n\nif __name__ == "__main__":\n    main()\n</code></pre>',
    "<p>Run it with <code>python3 main.py</code>.</p>",
  ].join("");

  const text = htmlToText(html, { baseUrl: BASE });

  assert.ok(
    text.includes(
      '```python\ndef main():\n    for i in range(3):\n        print(i)\t# tab comment\n\n\nif __name__ == "__main__":\n    main()\n```'
    ),
    `indentation, tabs and blank lines must survive:\n${text}`
  );
  assert.match(text, /Starter code:\n\n```python/);
  assert.match(text, /```\n\nRun it with `python3 main\.py`\./);
  assert.doesNotMatch(text, //, "no placeholder sentinel leaks");
});

test("htmlToText keeps <pre> whitespace inside list items and table cells", () => {
  const html = [
    "<ol><li>Compile:<pre>gcc -Wall \\\n    -o lab3 lab3.c</pre></li></ol>",
    "<table><tr><th>Step</th><th>Command</th></tr>",
    "<tr><td>Run</td><td><pre>  ./lab3   --verbose</pre></td></tr></table>",
    "<pre>&lt;html&gt;\n  &amp;&amp; done</pre>",
  ].join("");

  const text = htmlToText(html);

  assert.ok(text.includes("gcc -Wall \\\n    -o lab3 lab3.c"), `list item pre:\n${text}`);
  assert.ok(text.includes("  ./lab3   --verbose"), `table cell pre:\n${text}`);
  assert.ok(text.includes("<html>\n  && done"), `entities decoded inside pre:\n${text}`);
  assert.doesNotMatch(text, //);
});

test("htmlToText labels <details> blocks with their summary", () => {
  const html = [
    "<details><summary>Hint for part (b)</summary>",
    "<p>Use the <strong>chain rule</strong> twice.</p>",
    "<details><summary>Full solution</summary><p>dy/dx = 6x(x^2+1)^2</p></details>",
    "</details>",
    "<details><p>No summary here</p></details>",
  ].join("");

  const text = htmlToText(html);

  assert.match(text, /Details: Hint for part \(b\)\nUse the \*\*chain rule\*\* twice\./);
  assert.match(text, /Details: Full solution\ndy\/dx = 6x\(x\^2\+1\)\^2/);
  assert.match(text, /Details:\nNo summary here/);
  assert.doesNotMatch(text, /<\/?(details|summary)/i);
});

test("htmlToText keeps video/audio sources, captions tracks and posters", () => {
  const html = [
    '<video title="Lecture 3 recording" poster="/media/lec3.jpg" controls>',
    '<source src="/media/lec3.mp4" type="video/mp4">',
    '<source src="/media/lec3.webm" type="video/webm">',
    '<track kind="captions" srclang="en" label="English" src="/media/lec3.en.vtt">',
    '<track kind="subtitles" srclang="fr" src="/media/lec3.fr.vtt">',
    "Your browser does not support video.",
    "</video>",
    '<audio src="/media/podcast-1.mp3"></audio>',
    '<figure><video data-src="/media/demo.mp4"></video><figcaption>Demo</figcaption></figure>',
  ].join("");

  const text = htmlToText(html, { baseUrl: BASE });

  assert.match(text, /Video: Lecture 3 recording/);
  assert.match(text, /Source: https:\/\/canvas\.example\/media\/lec3\.mp4 \(video\/mp4\)/);
  assert.match(text, /Source: https:\/\/canvas\.example\/media\/lec3\.webm \(video\/webm\)/);
  assert.match(text, /Captions: English \(en\) https:\/\/canvas\.example\/media\/lec3\.en\.vtt/);
  assert.match(text, /Subtitles: fr https:\/\/canvas\.example\/media\/lec3\.fr\.vtt/);
  assert.match(text, /Poster: https:\/\/canvas\.example\/media\/lec3\.jpg/);
  assert.match(text, /Audio: https:\/\/canvas\.example\/media\/podcast-1\.mp3/);
  assert.match(
    text,
    /Figure: Video: https:\/\/canvas\.example\/media\/demo\.mp4 — Caption: Demo/
  );
  assert.doesNotMatch(text, /<(source|track)/i);
});

test("htmlToText emits embed lines for <object>, <embed> and data-src iframes", () => {
  const html = [
    '<object data="/files/123/download" type="application/pdf" title="Syllabus PDF">',
    '<p>Cannot display PDF. <a href="/files/123/download">Download it</a>.</p>',
    "</object>",
    '<embed src="/media/sim.swf" type="application/x-shockwave-flash">',
    '<iframe data-src="https://www.youtube.com/embed/abc123" title="Intro video"></iframe>',
    '<figure><embed data-src="/media/plot.svg"><figcaption>Plot</figcaption></figure>',
  ].join("");

  const text = htmlToText(html, { baseUrl: BASE });

  assert.match(
    text,
    /Embedded object: Syllabus PDF \(https:\/\/canvas\.example\/files\/123\/download\) \[application\/pdf\]/
  );
  assert.match(text, /Cannot display PDF\. Download it \(https:\/\/canvas\.example\/files\/123\/download\)\./);
  assert.match(
    text,
    /Embedded object: https:\/\/canvas\.example\/media\/sim\.swf \[application\/x-shockwave-flash\]/
  );
  assert.match(text, /Embedded content: Intro video \(https:\/\/www\.youtube\.com\/embed\/abc123\)/);
  assert.match(text, /Figure: Embedded object: https:\/\/canvas\.example\/media\/plot\.svg — Caption: Plot/);
  assert.doesNotMatch(text, /<(object|embed|iframe)/i);
});
