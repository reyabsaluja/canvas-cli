import DocPage from "@/components/DocPage";
import CodeBlock from "@/components/CodeBlock";
import { Callout, Figure, Table } from "@/components/blocks";
import { A, Body, C, Kbd, Li, List, SectionHeading, SubHeading, Term } from "@/components/prose";
import { metadataFor } from "@/lib/nav";
import answer from "@/assets/tui-answer.png";
import unconfirmed from "@/assets/tui-unconfirmed.png";
import notFound from "@/assets/tui-not-found.png";

export const metadata = metadataFor("/asking-questions/");

export default function AskingQuestions() {
  return (
    <DocPage href="/asking-questions/">
      <SectionHeading id="loop">How It Works</SectionHeading>
      <Body>
        You can ask questions in any scope, and the assistant answers by reading your course material rather
        than from memory. What it can reach depends on where you are:
      </Body>
      <Table
        head={["Scope", "Answers from"]}
        rows={[
          ["Global", "Your course list, recent workspaces, upcoming work across courses, and announcements"],
          ["Course", "That course's cached files, pages, modules, assignments, lectures, and announcements"],
          [
            "Workspace",
            "Everything in the course, plus the assignment's workup and every document the investigation read, with the checks described below",
          ],
        ]}
      />
      <Body>
        A workspace question goes through the most careful path. First canvas-cli decides whether the answer is
        already in hand: a follow-up about something just read, or a plain fact the workup states. Otherwise the
        assistant works in a loop of up to <Term>30 tool calls</Term>. It plans which source is likely to hold
        the answer, calls a tool, looks at what came back, and decides what to read next. It is told to read
        documents rather than answer from search snippets, and to check a second source when a question compares
        two things.
      </Body>
      <Figure
        src={answer}
        alt="A workspace answer about Lab 3 deliverables: the assistant read the handout, then answered with page citations and source lines."
        caption="One read of the handout, then an answer that cites the page for each claim."
      />

      <SectionHeading id="tools">Tools</SectionHeading>
      <Body>In a workspace, the assistant can call these. Each call appears in the conversation as it happens:</Body>
      <Table
        head={["Tool", "What it does"]}
        rows={[
          [<C key="1">search_workspace</C>, "Search the workspace and the course's documents; returns matching passages"],
          [<C key="2">search_course</C>, "Search the whole course cache: modules, pages, assignments, quizzes, grading scheme, tools, announcements, lectures, and files"],
          [<C key="3">read_file</C>, "Read a document, up to about 120,000 characters, or one page or heading of it"],
          [<C key="4">list_files</C>, "List every document and file available"],
          [<C key="5">download_course_file</C>, "Fetch a course file that ingestion skipped, and read it"],
          [<C key="6">list_assignments</C>, "The course's assignments and due dates"],
          [<C key="7">list_announcements</C>, "Announcement and discussion titles, optionally filtered"],
          [<C key="8">read_thread</C>, "An announcement or discussion with all its replies"],
          [<C key="9">open_lecture</C>, "Open a lecture's slides or recording"],
          [<C key="10">open_resource</C>, "Open any file or link on your machine"],
        ]}
      />
      <Body>
        Every read starts with the document&rsquo;s outline, so the assistant can go straight to{" "}
        <C>Page 57</C> or a heading instead of reading everything. Tool output is collapsed to a few lines;{" "}
        <Kbd>Ctrl</Kbd> <Kbd>O</Kbd> expands it.
      </Body>

      <SectionHeading id="search">Search</SectionHeading>
      <Body>
        Searches match the way people phrase course questions. Common words are dropped, words are reduced to
        their stems so &ldquo;deadlines&rdquo; finds &ldquo;deadline&rdquo;, and course vocabulary is treated as
        related: due and deadline, rubric and grading, late and penalty, lecture and slides, lab and practical,
        homework and problem set, starter and template, among others. When two announcements match equally, the
        newer one ranks first.
      </Body>
      <Body>
        Within a conversation the assistant remembers what it has already read, including which parts of a long
        document it has not seen yet, so a follow-up question does not start from zero.
      </Body>

      <SectionHeading id="citations">Citations</SectionHeading>
      <Body>
        Answers name the section each claim came from, down to the page of a PDF or the heading of a page:{" "}
        <C>Lab3_Fourier_Series.pdf — Page 4</C>, <C>Syllabus — Grading</C>. Under the answer, a line for each
        source shows its kind and the section that supports the answer. Slides are cited by slide, spreadsheets
        by sheet.
      </Body>

      <SectionHeading id="checks">Checks</SectionHeading>
      <Body>
        Before a workspace answer is shown, canvas-cli compares it with everything the assistant actually read.
        It checks:
      </Body>
      <List>
        <Li>
          <Term>Dates</Term>, in any format, and whether a weekday written next to a date is really that day
        </Li>
        <Li>
          <Term>Figures</Term>: times, percentages, marks and points, counts, room numbers, sizes, and numbers
          written as words (&ldquo;ten percent&rdquo;)
        </Li>
        <Li>
          <Term>Mismatched pairs</Term>, such as a date that the schedule lists next to a different lab
        </Li>
        <Li>
          <Term>&ldquo;Must&rdquo;</Term> in an answer when the source only says &ldquo;may&rdquo; or
          &ldquo;recommended&rdquo;
        </Li>
      </List>
      <Body>
        Anything it cannot find in the evidence is named in a <Term>Grounding</Term> note under the answer:
      </Body>
      <Figure
        src={unconfirmed}
        alt="An answer stating the midterm is on October 21, worth 25%, and 90 minutes long, followed by a Grounding note: this answer includes details I could not confirm in the sources I read (90 minutes)."
        caption="The date and weight are in the course outline. The length is not, so it is flagged."
      />
      <Body>
        The same note appears, worded differently, when an answer rests on search snippets instead of a full
        read, or on the workup summary instead of a fresh look at the document. Numbers you used in your own
        question are not flagged.
      </Body>

      <SubHeading>When something isn&rsquo;t there</SubHeading>
      <Body>
        If the answer is that the course does not say, the note lists exactly where the assistant looked, so you
        can judge how thorough it was:
      </Body>
      <Figure
        src={notFound}
        alt="An answer saying an illness extension is not specified, with a Grounding note listing a course search, the course outline read in full, the announcements, and a workspace search."
        caption="Not found after checking: every search and read, with what each returned."
      />
      <Callout kind="note">
        <p>
          The checks run on workspace answers. Course and global chat use the same kind of tool loop, with tools
          suited to their scope, but skip the verification and recovery passes. For questions where exact details
          matter, open the assignment as a workspace.
        </p>
      </Callout>

      <SectionHeading id="recovery">Recovery Pass</SectionHeading>
      <Body>
        Models sometimes stop early. After the assistant answers, canvas-cli looks for signs of that and, if it
        finds one, does up to two more reads outside the 30-step budget:
      </Body>
      <List>
        <Li>An answer that says something was not found triggers the tools it never tried: the assignment list, announcements, and course and workspace search.</Li>
        <Li>An answer that quotes a date or figure from a search snippet gets that document read in full.</Li>
        <Li>An announcement that was listed but never opened gets opened.</Li>
        <Li>A comparison grounded in only one source gets the other side found and read.</Li>
      </List>
      <Body>
        You will see <C>Checking the source before I commit to that…</C> while it happens. If the new reading
        changes anything, the answer is rewritten from it; if not, the original stands.
      </Body>

      <SectionHeading id="tips">Tips</SectionHeading>
      <List>
        <Li>
          <Term>Ask in a workspace</Term> when the details matter. That is where answers are checked, and the
          assistant already knows which documents belong to the assignment.
        </Li>
        <Li>
          <Term>Name the part you mean.</Term> &ldquo;What does Part 3 ask for?&rdquo; sends it straight to the
          right section.
        </Li>
        <Li>
          <Term>Pin a file</Term> with <C>@</C> to put it in front of the assistant directly. See{" "}
          <A href="/shell/#pins">@ Pins</A>.
        </Li>
        <Li>
          <Term>Start over with <C>/clear</C></Term> if an earlier answer keeps steering the conversation wrong.
        </Li>
        <Li>
          <Term>Refresh the course</Term> with <C>/refresh</C> after your instructor posts something new; answers
          only see what has been downloaded.
        </Li>
      </List>
      <CodeBlock lang="text" copy={false} caption="Questions that work well in a workspace.">{`what exactly do I submit, and in what format?
how is part 2 marked?
did the prof change the due date?
is lab 3 worth more than lab 2?
open the lab handout`}</CodeBlock>
    </DocPage>
  );
}
