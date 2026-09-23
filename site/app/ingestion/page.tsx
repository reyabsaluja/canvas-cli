import DocPage from "@/components/DocPage";
import CodeBlock from "@/components/CodeBlock";
import { Callout, Table } from "@/components/blocks";
import { A, Body, C, Kbd, Li, List, SectionHeading, Term } from "@/components/prose";
import { metadataFor } from "@/lib/nav";

export const metadata = metadataFor("/ingestion/");

export default function Ingestion() {
  return (
    <DocPage href="/ingestion/">
      <SectionHeading id="running">Running It</SectionHeading>
      <Body>
        Ingestion turns a Canvas course into plain files in <C>.canvas-cli/courses/</C>, which is everything the
        assistant and the workspaces read from. It happens automatically the first time you open a course in the
        shell. To do it ahead of time, or from a script, use the command:
      </Body>
      <CodeBlock>{`canvas-cli ingest ECE216              # by course code
canvas-cli ingest "Signals and"      # or any unique part of the name
canvas-cli ingest ECE216 --json      # machine-readable summary
canvas-cli ingest ECE216 --no-feedback`}</CodeBlock>
      <Body>Progress goes to stderr, and a summary of what was fetched follows:</Body>
      <CodeBlock lang="text" copy={false} caption="canvas-cli ingest ECE216, for the demo course used throughout these docs.">{`Ingesting Signals and Systems...

Course ingested

  Course  Signals and Systems
  Code    ECE216
  Term    Fall 2026
  Path    .canvas-cli/courses/ece216-101

Fetched:
  - 6 assignments
  - 2 modules
  - 4 module items
  - 3 files
  - 3 assignment groups (weights and drop rules on the grading-scheme page)
  - 1 external tools (Piazza, Zoom, Ed, ... from course navigation)
  - 2 pages
  - 2 announcements

Likely syllabus sources:
  1. Course Syllabus (built-in) [syllabus_body] high
  2. Grading scheme: assignment groups and weights [page] medium

Attachments:
  - Lecture 7 - Fourier Series.pdf downloaded (module file in "Week 3: Fourier Series")
  - Lab3_Fourier_Series.pdf downloaded (module file in "Week 3: Fourier Series")
  - ECE216_Course_Outline.pdf downloaded (module file in "Course Information")`}</CodeBlock>
      <Body>
        Running it again fetches everything from Canvas again and rewrites the indexes and extracted text.
        Files that are already on disk are not downloaded a second time, so repeat runs are quick. In the shell,{" "}
        <C>/refresh</C> in a course does the same. <Kbd>Ctrl</Kbd> <Kbd>C</Kbd> stops a run cleanly.
      </Body>

      <SectionHeading id="captured">What&rsquo;s Captured</SectionHeading>
      <Table
        head={["From Canvas", "What canvas-cli keeps"]}
        rows={[
          ["Course", "Name, code, term, dates, and the syllabus"],
          ["Assignments", "Descriptions, due dates (including per-section dates), points, submission rules, rubrics, and group weights"],
          ["Modules", "Every item in order, with prerequisites and completion requirements"],
          ["Pages", "Every page, including ones only reachable by links from other pages"],
          ["Files", "The whole Files tab, folder by folder, plus files attached to assignments, posts, and replies"],
          ["Announcements and discussions", "Every post with all its replies, in thread order"],
          ["Quizzes, tools, calendar", "Turned into reference pages; see below"],
          ["Your submissions", "Grader comments, feedback files, and rubric scores on your own work"],
          ["Linked content", "The text of external pages and documents the course links to"],
          ["Lectures", "Slides and recordings, found wherever they are posted or embedded"],
        ]}
      />
      <Body>
        Files are downloaded four at a time, up to 200 MB each, and only from your Canvas site. The Files tab
        crawl skips images, audio, and video and takes up to 1,000 documents; files a module or assignment points
        at are always fetched.
      </Body>

      <SectionHeading id="reference-pages">Reference Pages</SectionHeading>
      <Body>
        Some of the most useful information in Canvas is not in any document. Ingestion writes it into pages of
        its own, which search and the assistant treat like any other page:
      </Body>
      <Table
        head={["Page", "Contains"]}
        rows={[
          [<C key="1">Quiz: &lt;title&gt;</C>, "One per quiz: type, open, due, and lock dates, time limit, attempts, points, question count, and instructions"],
          [<C key="2">Grading scheme: assignment groups and weights</C>, "Each group's weight and drop rules, and roughly how much of the final grade each assignment is worth"],
          [<C key="3">Course tools and external links</C>, "The course's navigation tools, such as Piazza, Ed, Zoom, or Gradescope, with what each is for"],
          [<C key="4">Calendar event: &lt;title&gt;</C>, "One per event, with time, location, and description"],
          [<C key="5">Course calendar</C>, "Every event in date order, so exam slots and office hours are searchable"],
        ]}
      />

      <SectionHeading id="extraction">Extraction</SectionHeading>
      <Body>
        Every downloaded document gets a plain-text copy under <C>extracted/</C>, organized so it can be read one
        section at a time:
      </Body>
      <Table
        head={["Format", "Extracted as"]}
        rows={[
          ["PDF", <>Page by page, under <C>## Page N</C> headings. Pages that are only images are marked as such.</>],
          ["Word (.docx)", "Headings, lists, tables, footnotes, headers and footers, and reviewer comments"],
          ["PowerPoint (.pptx)", <>One <C>## Slide N</C> section per slide, with speaker notes and comments</>],
          ["Excel (.xlsx)", "One section per sheet, with formulas beside their values, up to 1,000 rows per sheet"],
          ["Zip archives", <>Unpacked into <C>&lt;name&gt;.zip.unpacked/</C>, three levels deep, each file extracted</>],
          ["Plain text and code", "Kept as is: .txt, .md, .csv, .py, .c, .h, .java, .js, .ts, .s, .asm"],
          ["HTML", "Converted to text, keeping the indentation of code blocks"],
        ]}
      />
      <Body>
        Each document keeps up to 400,000 characters, so a long textbook chapter is not cut short. When a PDF is
        longer than that, it is cut at a page boundary and the note says which pages were left out.
      </Body>
      <Callout kind="note">
        <p>
          Some formats are downloaded but not extracted: older Office files (.doc, .ppt, .xls), OpenDocument,
          RTF, LaTeX, and notebooks. Scanned PDFs have no text to extract, since there is no OCR. The files are
          still there for you to open with <C>/open</C>.
        </p>
      </Callout>
      <Body>
        Zip archives are opened with limits, 100 MB per file, 5,000 files, and 1 GB in total, so a malicious or
        broken archive cannot fill your disk.
      </Body>

      <SectionHeading id="hidden">Hidden Content</SectionHeading>
      <Body>Course material often hides inside other material. Ingestion follows it:</Body>
      <List>
        <Li>
          <Term>Canvas file links</Term> in every form course pages use: plain links, embedded PDF viewers, and
          module items that point at a file.
        </Li>
        <Li>
          <Term>External content</Term> linked or embedded in pages, assignments, the syllabus, announcements, and
          replies. Google Docs, Slides, and Sheets are fetched through their export links; PDFs and Office files
          are extracted; web pages are reduced to their text; caption files (.vtt, .srt), which are usually
          lecture transcripts, are kept as text. Up to 30,000 characters are kept from each link. Your Canvas token is only ever sent to your Canvas site, never to
          an outside host.
        </Li>
        <Li>
          <Term>Lecture recordings</Term> embedded from YouTube, Vimeo, Panopto, Kaltura, Echo360, Mediasite,
          Zoom, Loom, Google Drive, and Canvas Studio, numbered by lecture wherever the titles allow. Recordings
          are indexed, not downloaded.
        </Li>
      </List>

      <SectionHeading id="feedback">Your Feedback</SectionHeading>
      <Body>
        Ingestion also saves what graders said about <Term>your</Term> submissions: comments, attached feedback
        files, and rubric scores, criterion by criterion. Canvas only returns your own submissions, so nothing
        about other students is ever requested. Feedback appears as a <C>## Submission Feedback</C> section in
        each assignment&rsquo;s text, which is how the assistant can answer &ldquo;what did I lose marks on in
        Lab 2?&rdquo;.
      </Body>
      <Body>
        To leave it out, pass <C>--no-feedback</C>, or set <C>&quot;ingestSubmissionFeedback&quot;: false</C> in
        your profile&rsquo;s <A href="/configuration/#config-json">config.json</A> to make that the default.
      </Body>

      <SectionHeading id="json">JSON Output</SectionHeading>
      <Body>
        <C>--json</C> prints a single JSON object instead of the summary, for scripts. It includes the counts,
        what happened to every attachment, and the path to the course cache:
      </Body>
      <CodeBlock lang="json" copy={false}>{`{
  "ingestion": {
    "version": 1,
    "ingestedAt": "2026-09-23T21:56:25.761Z",
    "courseId": 101,
    "courseName": "Signals and Systems",
    "courseCode": "ECE216",
    "counts": { "assignments": 6, "modules": 2, "files": 3, "pages": 2, "lectures": 1, ... },
    ...
  },
  "coursePath": ".canvas-cli/courses/ece216-101",
  "announcements": ..., "discussions": ..., "externalLinks": ..., "syllabusCandidates": ...,
  "attachments": [{ "filename": "Lab3_Fourier_Series.pdf", "sourceType": "...", "status": "downloaded", "reason": "..." }]
}`}</CodeBlock>

      <SectionHeading id="blocked">Blocked APIs</SectionHeading>
      <Body>
        Some schools block parts of the Canvas API for students, most often Files and Pages. Ingestion carries on
        without them: a blocked section comes back empty instead of failing the run, and the summary marks it{" "}
        <C>(API not accessible)</C>. Module items and assignment descriptions usually still work, so most
        documents are found anyway through the links in them. Quizzes, course tools, and grading groups are
        optional in the same way.
      </Body>
      <Body>
        Temporary errors, rate limits and server errors, are retried up to three times. Authentication and
        permission errors are not, since retrying cannot fix them. See{" "}
        <A href="/troubleshooting/">Troubleshooting</A>.
      </Body>
    </DocPage>
  );
}
