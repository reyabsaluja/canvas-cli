import DocPage from "@/components/DocPage";
import CodeBlock from "@/components/CodeBlock";
import { Callout, Figure, Table } from "@/components/blocks";
import { A, Body, C, Li, List, SectionHeading, Term } from "@/components/prose";
import { metadataFor } from "@/lib/nav";
import preparation from "@/assets/tui-preparation.png";
import plan from "@/assets/tui-plan.png";

export const metadata = metadataFor("/workspaces/");

export default function Workspaces() {
  return (
    <DocPage href="/workspaces/">
      <SectionHeading id="opening">Opening One</SectionHeading>
      <Body>
        A workspace is an assignment that canvas-cli has already read for you. Open one from a course with{" "}
        <C>/assignments</C>, or reopen a previous one with <C>/recent</C>. The first time takes a minute or so
        while canvas-cli investigates; after that it opens instantly.
      </Body>
      <Callout kind="note">
        <p>
          Building a workspace needs an <A href="/ai-providers/">AI provider</A>. Without one, canvas-cli stops
          with <C>AI provider not configured — cannot run assignment workup</C>.
        </p>
      </Callout>

      <SectionHeading id="preparation">Preparation</SectionHeading>
      <Body>The progress screen shows each stage as it runs:</Body>
      <List ordered>
        <Li>
          <Term>Resolving the assignment</Term> from Canvas, with its description, dates, and rubric.
        </Li>
        <Li>
          <Term>Checking the course cache</Term>, and <A href="/ingestion/">ingesting</A> the course first if it
          has not been downloaded yet.
        </Li>
        <Li>
          <Term>Enriching</Term> the assignment with what the cache already knows: the syllabus, related modules,
          and linked files.
        </Li>
        <Li>
          <Term>Investigating</Term>. An agent with up to 15 steps lists the downloaded files, searches modules,
          and reads documents, up to 60,000 characters at a time, one page or heading at a time when a document
          is longer. It cannot finish until it has read the main instruction document and confirmed where the due
          date comes from.
        </Li>
        <Li>
          <Term>Synthesizing</Term> what it found into a structured workup: overview, deliverables, constraints,
          resources, a reading order, an action plan, open questions, and a trace of which source each conclusion
          came from.
        </Li>
        <Li>
          <Term>Creating the workspace</Term> on disk, and opening it.
        </Li>
      </List>
      <Figure
        src={preparation}
        alt="The workspace preparation screen: a listing of downloaded files, the lab handout and course outline being read, then synthesizing assignment workup and creating workspace."
        caption="Preparing Lab 3. Each tool call shows a preview; Ctrl+O expands it."
      />
      <Body>
        If the model fails partway through, the workspace is still created, marked as partial with low
        confidence, so you are never left with nothing.
      </Body>

      <SectionHeading id="views">Views</SectionHeading>
      <Body>Inside a workspace, these commands show parts of the workup without asking the model again:</Body>
      <Table
        head={["Command", "Shows"]}
        rows={[
          [<C key="1">/overview</C>, "What the assignment is and what is expected, in a few sentences"],
          [<><C>/requirements</C> or <C>/reqs</C></>, "Deliverables and constraints as two lists"],
          [<C key="3">/plan</C>, "Numbered steps, each with the detail you need to do it"],
          [<C key="4">/resources</C>, "The documents that matter, and why each one does"],
          [<C key="5">/evidence</C>, "Each conclusion with its source, and the questions still open"],
          [<C key="6">/status</C>, "Where the workspace lives, whether it is current, and how much was extracted"],
        ]}
      />
      <Figure
        src={plan}
        alt="The /plan output for Lab 3: six numbered steps from the pre-lab derivation to writing and submitting the report."
        caption="/plan in the Lab 3 workspace."
      />
      <Body>
        For anything the workup does not answer, just ask. The assistant goes back to the documents themselves;
        see <A href="/asking-questions/">Asking questions</A>.
      </Body>

      <SectionHeading id="files">Files</SectionHeading>
      <Body>
        Every workspace is a folder under <C>.canvas-cli/sessions/</C>, named after the course, assignment, and
        its Canvas id. You can open these files in any editor:
      </Body>
      <Table
        head={["File", "Contents"]}
        rows={[
          [<C key="1">assignment.md</C>, "The brief: due date, points, how to submit, overview, deliverables, constraints, resources, reading order, the source trace, and Canvas's original description"],
          [<C key="2">plan.md</C>, "The action plan, each step with a goal, what to use, and what it produces, plus a deliverables checklist"],
          [<C key="3">notes.md</C>, "A scaffold for your own notes. canvas-cli writes it once and never overwrites it"],
          [<C key="4">workup.json</C>, "The structured workup the views above are drawn from"],
          [<C key="5">assignment.json</C>, "The assignment as Canvas returned it"],
          [<C key="6">session.json</C>, "When it was prepared and last opened, and its state"],
          [<C key="7">extracted/</C>, "The text of every document the investigation read"],
          [<C key="8">attachments/</C>, "Canvas files linked from the assignment description"],
          [<C key="9">work/</C>, "An empty folder for your own work"],
        ]}
      />
      <Body>
        The conversation itself is stored separately, in <C>.canvas-cli/chat-sessions/</C>.
      </Body>

      <SectionHeading id="due-dates">Due-Date Conflicts</SectionHeading>
      <Body>
        The investigation records the due date a course document states, even when Canvas has one too, and
        compares the two by calendar day. <C>assignment.md</C> and <C>plan.md</C> then say which case you are in:
      </Body>
      <CodeBlock lang="markdown" copy={false} caption="When they agree, and when they do not.">{`- **Due:** Fri, Sep 25, 2026 at 11:59 PM *(Canvas, matches the syllabus/schedule)*

- **Due:** Fri, Sep 25, 2026 at 11:59 PM *(Canvas)*
- **Due-date conflict:** the syllabus/schedule says **October 2**, which does not match Canvas. Confirm with the instructor before relying on either.`}</CodeBlock>
      <Body>
        If Canvas has no due date, the document&rsquo;s date is used and marked as inferred. A date is only
        taken from a document the investigation actually confirmed.
      </Body>

      <SectionHeading id="refresh">Staying Current</SectionHeading>
      <Body>
        A workspace is <Term>stale</Term> when the course has been downloaded again since the workspace was
        prepared, for example after <C>/refresh</C> in the course. It still opens straight away, with{" "}
        <C>stale · /refresh recommended</C> in the status line, so you are never blocked.
      </Body>
      <Body>
        Running <C>/refresh</C> inside the workspace downloads the course again from Canvas and redoes the whole
        investigation. It keeps your <C>notes.md</C> and your conversation.
      </Body>
    </DocPage>
  );
}
