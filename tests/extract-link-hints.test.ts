import assert from "node:assert/strict";
import test from "node:test";
import { htmlToText } from "../src/format/html-to-text.js";

const BASE = "https://canvas.example/courses/17/pages/week-4";

test("before/after: a generic 'click here' link surfaces the filename from its title attribute", () => {
  const html =
    '<p>The handout is <a class="instructure_file_link" title="Lab 4 handout.pdf" href="/courses/17/files/501/download?download_frd=1">here</a>.</p>';
  const text = htmlToText(html, { baseUrl: BASE });
  assert.match(text, /Lab 4 handout\.pdf \(https:\/\/canvas\.example\/courses\/17\/files\/501\/download\?download_frd=1\)/);
  assert.doesNotMatch(text, /\bhere \(/);
});

test("a descriptive label keeps its wording and gains the filename in brackets", () => {
  const html = '<a href="/courses/17/files/502/download" title="lab4-starter.zip">Starter code</a>';
  const text = htmlToText(html, { baseUrl: BASE });
  assert.match(text, /Starter code \[lab4-starter\.zip\] \(https:\/\/canvas\.example\/courses\/17\/files\/502\/download\)/);
});

test("labels that already name the file, non-filename titles, and plain links are unchanged", () => {
  assert.match(
    htmlToText('<a href="/f/1" title="lab4.pdf">Read lab4.pdf now</a>', { baseUrl: BASE }),
    /^Read lab4\.pdf now \(https:\/\/canvas\.example\/f\/1\)$/m
  );
  assert.match(
    htmlToText('<a href="/f/2" title="Opens in a new tab">Grading policy</a>', { baseUrl: BASE }),
    /^Grading policy \(https:\/\/canvas\.example\/f\/2\)$/m
  );
  assert.match(
    htmlToText('<a href="/f/3">Syllabus</a>', { baseUrl: BASE }),
    /^Syllabus \(https:\/\/canvas\.example\/f\/3\)$/m
  );
  assert.match(
    htmlToText('<a href="/f/4" title="Week 4 slides.pptx"></a>', { baseUrl: BASE }),
    /^Week 4 slides\.pptx \(https:\/\/canvas\.example\/f\/4\)$/m
  );
});
