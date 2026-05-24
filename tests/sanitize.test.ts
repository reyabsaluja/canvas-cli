import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  sanitizeFilename,
  sanitizeSubfolder,
  confineToDirectory,
  slugify,
  truncateSlug,
  sanitizeDocumentSegment,
} from "../src/sanitize.js";

test("sanitizeFilename passes through normal filenames unchanged", () => {
  assert.equal(sanitizeFilename("report.pdf"), "report.pdf");
  assert.equal(sanitizeFilename("my-file_v2.txt"), "my-file_v2.txt");
});

test("sanitizeFilename strips path traversal via forward slashes", () => {
  assert.equal(sanitizeFilename("../../../etc/passwd"), "passwd");
  assert.equal(sanitizeFilename("foo/../bar.txt"), "bar.txt");
});

test("sanitizeFilename replaces backslashes as illegal chars on POSIX", () => {
  assert.equal(
    sanitizeFilename("..\\..\\windows\\system32\\config"),
    "windows_system32_config"
  );
});

test("sanitizeFilename removes control characters", () => {
  assert.equal(sanitizeFilename("file\x00name.txt"), "filename.txt");
  assert.equal(sanitizeFilename("file\x1fname.txt"), "filename.txt");
  assert.equal(sanitizeFilename("file\x7fname.txt"), "filename.txt");
  assert.equal(sanitizeFilename("file\x9fname.txt"), "filename.txt");
});

test("sanitizeFilename replaces Windows-illegal characters", () => {
  assert.equal(sanitizeFilename("file<>:|?*.txt"), "file_.txt");
  assert.equal(sanitizeFilename('notes "final".doc'), "notes _final_.doc");
});

test("sanitizeFilename collapses multiple underscores and dots", () => {
  assert.equal(sanitizeFilename("foo___bar.txt"), "foo_bar.txt");
  assert.equal(sanitizeFilename("foo...bar.txt"), "foo.bar.txt");
});

test("sanitizeFilename trims leading/trailing dots, spaces, and underscores", () => {
  assert.equal(sanitizeFilename("...hidden"), "hidden");
  assert.equal(sanitizeFilename("  spaced  "), "spaced");
  assert.equal(sanitizeFilename("___underscored___"), "underscored");
});

test("sanitizeFilename preserves leading dot for dotfiles", () => {
  assert.equal(sanitizeFilename(".gitignore"), ".gitignore");
  assert.equal(sanitizeFilename(".env.example"), ".env.example");
  assert.equal(sanitizeFilename(".hidden"), ".hidden");
});

test("sanitizeFilename prefixes Windows reserved names", () => {
  assert.equal(sanitizeFilename("CON"), "_CON");
  assert.equal(sanitizeFilename("con"), "_con");
  assert.equal(sanitizeFilename("CON.txt"), "_CON.txt");
  assert.equal(sanitizeFilename("PRN"), "_PRN");
  assert.equal(sanitizeFilename("AUX"), "_AUX");
  assert.equal(sanitizeFilename("NUL"), "_NUL");
  assert.equal(sanitizeFilename("COM1"), "_COM1");
  assert.equal(sanitizeFilename("COM9.pdf"), "_COM9.pdf");
  assert.equal(sanitizeFilename("LPT1"), "_LPT1");
  assert.equal(sanitizeFilename("LPT9"), "_LPT9");
});

test("sanitizeFilename does not flag names containing reserved substrings", () => {
  assert.equal(sanitizeFilename("CONCRETE.pdf"), "CONCRETE.pdf");
  assert.equal(sanitizeFilename("auxiliary.txt"), "auxiliary.txt");
  assert.equal(sanitizeFilename("communication.doc"), "communication.doc");
});

test("sanitizeFilename truncates to max length preserving extension", () => {
  const longName = "a".repeat(250) + ".pdf";
  const result = sanitizeFilename(longName);
  assert(result.length <= 200);
  assert(result.endsWith(".pdf"));
});

test("sanitizeFilename handles empty and whitespace-only input", () => {
  assert.equal(sanitizeFilename(""), "unnamed");
  assert.equal(sanitizeFilename("   "), "unnamed");
  assert.equal(sanitizeFilename("\t\n"), "unnamed");
});

test("sanitizeFilename handles all-special-character input", () => {
  assert.equal(sanitizeFilename("***"), "unnamed");
  assert.equal(sanitizeFilename("..."), "unnamed");
});

test("sanitizeFilename preserves Unicode in filenames", () => {
  assert.equal(sanitizeFilename("课程大纲.pdf"), "课程大纲.pdf");
  assert.equal(sanitizeFilename("café-résumé.docx"), "café-résumé.docx");
  assert.equal(sanitizeFilename("日本語テスト.txt"), "日本語テスト.txt");
});

test("sanitizeFilename handles filenames with only path separators", () => {
  assert.equal(sanitizeFilename("/"), "unnamed");
  assert.equal(sanitizeFilename("///"), "unnamed");
});

test("sanitizeSubfolder passes through simple folder names", () => {
  assert.equal(sanitizeSubfolder("syllabus"), "syllabus");
  assert.equal(sanitizeSubfolder("important"), "important");
});

test("sanitizeSubfolder sanitizes each path segment independently", () => {
  const result = sanitizeSubfolder("foo/bar");
  const expected = ["foo", "bar"].join(path.sep);
  assert.equal(result, expected);
});

test("sanitizeSubfolder sanitizes traversal segments to unnamed", () => {
  assert.equal(sanitizeSubfolder("../secret"), "unnamed/secret");
  assert.equal(sanitizeSubfolder("../../etc"), "unnamed/unnamed/etc");
});

test("sanitizeSubfolder handles empty input", () => {
  assert.equal(sanitizeSubfolder(""), "unnamed");
  assert.equal(sanitizeSubfolder("   "), "unnamed");
});

test("confineToDirectory resolves safe paths within the base", () => {
  const result = confineToDirectory("/base/dir", "file.txt");
  assert.equal(result, "/base/dir/file.txt");
});

test("confineToDirectory resolves subdirectory paths", () => {
  const result = confineToDirectory("/base/dir", "sub/file.txt");
  assert.equal(result, "/base/dir/sub/file.txt");
});

test("confineToDirectory throws on path traversal attempts", () => {
  assert.throws(
    () => confineToDirectory("/base/dir", "../secret.txt"),
    /Path traversal blocked/
  );
  assert.throws(
    () => confineToDirectory("/base/dir", "../../etc/passwd"),
    /Path traversal blocked/
  );
  assert.throws(
    () => confineToDirectory("/base/dir", "sub/../../other/file.txt"),
    /Path traversal blocked/
  );
});

test("confineToDirectory throws on absolute path escape", () => {
  assert.throws(
    () => confineToDirectory("/base/dir", "/etc/passwd"),
    /Path traversal blocked/
  );
});

test("confineToDirectory rejects paths resolving to the base directory itself", () => {
  assert.throws(
    () => confineToDirectory("/base/dir", "."),
    /Path traversal blocked/
  );
  assert.throws(
    () => confineToDirectory("/base/dir", "sub/.."),
    /Path traversal blocked/
  );
});

test("slugify lowercases and replaces non-alphanumeric with dashes", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("ECE 297"), "ece-297");
});

test("slugify collapses multiple dashes", () => {
  assert.equal(slugify("foo---bar"), "foo-bar");
  assert.equal(slugify("a   b   c"), "a-b-c");
});

test("slugify strips leading/trailing dashes", () => {
  assert.equal(slugify("--hello--"), "hello");
  assert.equal(slugify("!@#test!@#"), "test");
});

test("slugify handles empty and whitespace-only input", () => {
  assert.equal(slugify(""), "unnamed");
  assert.equal(slugify("   "), "unnamed");
  assert.equal(slugify("\t\n"), "unnamed");
});

test("slugify handles all-special-character input", () => {
  assert.equal(slugify("!!!@@@###"), "unnamed");
  assert.equal(slugify("..."), "unnamed");
  assert.equal(slugify("---"), "unnamed");
});

test("slugify produces valid slugs from realistic Canvas course codes", () => {
  assert.equal(slugify("ECE297H1-F"), "ece297h1-f");
  assert.equal(slugify("MAT 188"), "mat-188");
  assert.equal(slugify("CS 101 - Intro to Programming"), "cs-101-intro-to-programming");
});

test("truncateSlug returns short slugs unchanged", () => {
  assert.equal(truncateSlug("hello", 40), "hello");
});

test("truncateSlug truncates long slugs to max length", () => {
  const long = "a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q-r-s-t-u-v-w";
  const result = truncateSlug(long, 20);
  assert(result.length <= 20);
});

test("truncateSlug strips trailing dashes after truncation", () => {
  const slug = "hello-world-this-is-a-test";
  const result = truncateSlug(slug, 12);
  assert(!result.endsWith("-"));
});

test("truncateSlug uses default max length of 40", () => {
  const long = "a".repeat(50);
  const result = truncateSlug(long);
  assert(result.length <= 40);
});

test("sanitizeDocumentSegment passes through safe characters", () => {
  assert.equal(sanitizeDocumentSegment("page-123"), "page-123");
  assert.equal(sanitizeDocumentSegment("file_v2.txt"), "file_v2.txt");
});

test("sanitizeDocumentSegment replaces special characters with underscores", () => {
  assert.equal(sanitizeDocumentSegment("hello world!"), "hello_world");
});

test("sanitizeDocumentSegment collapses multiple underscores", () => {
  assert.equal(sanitizeDocumentSegment("foo   bar"), "foo_bar");
});

test("sanitizeDocumentSegment trims leading/trailing underscores", () => {
  assert.equal(sanitizeDocumentSegment("  hello  "), "hello");
});

test("sanitizeDocumentSegment handles empty and whitespace-only input", () => {
  assert.equal(sanitizeDocumentSegment(""), "unnamed");
  assert.equal(sanitizeDocumentSegment("   "), "unnamed");
});

test("sanitizeDocumentSegment handles all-special-character input", () => {
  assert.equal(sanitizeDocumentSegment("@#$%^&"), "unnamed");
});

test("sanitizeDocumentSegment truncates overly long segments", () => {
  const long = "a".repeat(250);
  const result = sanitizeDocumentSegment(long);
  assert(result.length <= 200);
});

test("sanitizeDocumentSegment prefixes Windows reserved names", () => {
  assert.equal(sanitizeDocumentSegment("CON"), "_CON");
  assert.equal(sanitizeDocumentSegment("NUL"), "_NUL");
  assert.equal(sanitizeDocumentSegment("LPT1.txt"), "_LPT1.txt");
});

test("sanitizeDocumentSegment does not flag names containing reserved substrings", () => {
  assert.equal(sanitizeDocumentSegment("CONCRETE"), "CONCRETE");
  assert.equal(sanitizeDocumentSegment("conquer"), "conquer");
});

test("slugify integration: pathological course codes", () => {
  assert.equal(slugify(""), "unnamed");
  assert.equal(slugify("12345"), "12345");
  const long = "A".repeat(100);
  assert.equal(truncateSlug(slugify(long)).length, 40);
});

test("slugify integration: pathological assignment names", () => {
  const allPunctuation = "...!!!???";
  assert.equal(slugify(allPunctuation), "unnamed");

  const longName = "Introduction to " + "Very ".repeat(50) + "Long Course";
  const slug = truncateSlug(slugify(longName));
  assert(slug.length <= 40);
  assert(!slug.endsWith("-"));
});
