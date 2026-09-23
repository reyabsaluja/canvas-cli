import DocPage from "@/components/DocPage";
import CodeBlock from "@/components/CodeBlock";
import { Callout, Figure, Table } from "@/components/blocks";
import { A, Body, C, Kbd, Li, List, SectionHeading, SubHeading, Term } from "@/components/prose";
import { metadataFor } from "@/lib/nav";
import home from "@/assets/tui-home.png";
import course from "@/assets/tui-course.png";

export const metadata = metadataFor("/shell/");

export default function Shell() {
  return (
    <DocPage href="/shell/">
      <SectionHeading id="scopes">Three Scopes</SectionHeading>
      <Body>
        Running <C>canvas-cli</C> with no command opens a single chat shell. What the shell knows about, and
        which commands it offers, depends on the <Term>scope</Term> you are in. There are three, and the header
        and the status line under the input always tell you which one you are in.
      </Body>
      <Table
        head={["Scope", "What it covers", "Get there with"]}
        rows={[
          ["Global", "All your courses at once: deadlines, grades, announcements", <C key="g">/home</C>],
          ["Course", "One course: its files, modules, lectures, and assignments", <C key="c">/courses</C>],
          ["Workspace", "One assignment, with everything canvas-cli read to prepare it", <C key="w">/assignments</C>],
        ]}
      />
      <Body>
        <C>/help</C> lists only the commands that work in the current scope. Running a command in the wrong
        scope tells you where it works instead of failing silently, for example{" "}
        <C>/plan is only available in a workspace. Open an assignment first</C>.
      </Body>

      <SubHeading id="global">Global</SubHeading>
      <Body>
        The home screen. The panel shows your school, the model in use, your courses, and recent workspaces,
        with the most useful commands beside them. Ask broad questions here, or use <C>/timeline</C>,{" "}
        <C>/grade</C>, and <C>/announcements</C> across every course.
      </Body>
      <Figure src={home} alt="The canvas-cli home screen with the red canvas wordmark and a panel listing the school, model, courses, and commands." />

      <SubHeading id="course">Course</SubHeading>
      <Body>
        Entering a course shows its name and code, then what is due next. The shell opens immediately and loads
        the course&rsquo;s assignments and cached material in the background; the status line reads{" "}
        <C>loading course data</C> until it is done. Questions here are answered from that course&rsquo;s own
        files.
      </Body>
      <Figure src={course} alt="Course scope for Signals and Systems with its upcoming work." />

      <SubHeading id="workspace">Workspace</SubHeading>
      <Body>
        An assignment you have opened. It starts with a summary of the assignment and adds commands for the brief:{" "}
        <C>/overview</C>, <C>/requirements</C>, <C>/plan</C>, <C>/resources</C>, <C>/evidence</C>, and{" "}
        <C>/status</C>. The status line shows <C>Course &gt; Assignment</C>. See{" "}
        <A href="/workspaces/">Assignment workspaces</A>.
      </Body>

      <SectionHeading id="moving">Moving Around</SectionHeading>
      <Table
        head={["Command", "Where", "What it does"]}
        rows={[
          [<C key="1">/courses</C>, "Global", "Pick a course from your list. Type to filter."],
          [<C key="2">/assignments</C>, "Course", "Pick an assignment. Upcoming work first; submitted work is dimmed."],
          [<C key="3">/recent</C>, "Global", "Reopen a course or workspace you used before, most recent first."],
          [
            <C key="4">/open &lt;name&gt;</C>,
            "Global",
            "Jump straight to a course by name or code, or to a recent workspace by name.",
          ],
          [<C key="5">/back</C>, "Course, workspace", "Up one level: workspace to its course, course to global."],
          [<C key="6">/home</C>, "Course, workspace", "Straight back to global."],
        ]}
      />
      <Body>
        In course and workspace scope, <C>/open</C> opens files and links instead. See{" "}
        <A href="/study-tools/#open">Opening things</A>.
      </Body>

      <SectionHeading id="input">Typing</SectionHeading>
      <Body>
        Type a question and press <Kbd>Enter</Kbd>. Start with <C>/</C> and a menu of the commands available
        here appears as you type; <Kbd>↑</Kbd> <Kbd>↓</Kbd> move through it and <Kbd>Tab</Kbd> completes the
        highlighted one.
      </Body>
      <Table
        head={["Key", "What it does"]}
        rows={[
          [<Kbd key="1">Enter</Kbd>, "Send the message, or accept the highlighted suggestion"],
          [<Kbd key="2">Tab</Kbd>, "Complete the highlighted command, file, or pin"],
          [<Kbd key="3">Esc</Kbd>, "Stop the answer being written, or close the command menu"],
          [
            <span key="4">
              <Kbd>Ctrl</Kbd> <Kbd>C</Kbd>
            </span>,
            "Stop the answer; with nothing running, clear what you typed; on an empty line, quit",
          ],
          [
            <span key="5">
              <Kbd>Ctrl</Kbd> <Kbd>Y</Kbd>
            </span>,
            <>Copy the last answer, same as <C>/copy</C></>,
          ],
          [
            <span key="6">
              <Kbd>Ctrl</Kbd> <Kbd>O</Kbd>
            </span>,
            "Expand or collapse the output of the assistant's tool calls",
          ],
          [
            <span key="7">
              <Kbd>↑</Kbd> <Kbd>↓</Kbd>
            </span>,
            "Scroll the conversation, or move through a suggestion list",
          ],
          [
            <span key="8">
              <Kbd>PgUp</Kbd> <Kbd>PgDn</Kbd>
            </span>,
            <>
              Scroll a page at a time (also <Kbd>Ctrl</Kbd> <Kbd>P</Kbd> and <Kbd>Ctrl</Kbd> <Kbd>N</Kbd>)
            </>,
          ],
          [
            <span key="9">
              <Kbd>Home</Kbd> <Kbd>End</Kbd>
            </span>,
            "Jump to the start or end of the conversation",
          ],
        ]}
      />
      <Body>
        You can keep typing while an answer is being written; <Kbd>Enter</Kbd> waits until it finishes. If you
        stop an answer before any of it appears, your question goes back into the input so you can edit it.
      </Body>
      <Callout kind="note">
        <p>
          The input is a single line. A pasted line break sends the message, and <Kbd>↑</Kbd> scrolls the
          conversation rather than recalling your previous question.
        </p>
      </Callout>

      <SectionHeading id="pins">@ Pins</SectionHeading>
      <Body>
        In a course or workspace, you can attach a file to your next question by typing <C>@</C> and its name.
        A list of matching files appears as you type; <Kbd>Tab</Kbd> completes one.
      </Body>
      <CodeBlock lang="text" copy={false}>{`@lab3_fourier_series_pdf summarize the pre-lab in three bullet points`}</CodeBlock>
      <Body>
        Pin names are the file&rsquo;s title in lower case, with spaces, dots, dashes, and slashes turned into
        underscores. You only need enough of the name to be unambiguous: an exact match wins, then a unique
        prefix, then a unique fragment. If a pin matches nothing, or more than one file, canvas-cli tells you and
        sends nothing.
      </Body>
      <Body>
        Anything canvas-cli has on disk can be pinned: workspace files such as <C>plan.md</C> and{" "}
        <C>notes.md</C>, downloaded course files and files inside zips, extracted pages and documents, and PDFs
        you exported. Up to 15,000 characters of the file are included with your question.
      </Body>

      <SectionHeading id="sessions">Sessions</SectionHeading>
      <Body>
        Every scope keeps its own conversation: one for global, one per course, and one per workspace. Leave a
        course and come back next week and the conversation is where you left it, and in a workspace the
        assistant remembers what it already read. Conversations are saved as you go, and again if the terminal
        closes unexpectedly.
      </Body>
      <Body>
        <C>/clear</C> starts the current scope&rsquo;s conversation over. In a workspace it also resets what the
        assistant remembers, which helps when an earlier answer is steering later ones in the wrong direction.
        Conversations live in <C>.canvas-cli/chat-sessions/</C>; see <A href="/local-files/#chat-sessions">Local files</A>.
      </Body>
      <List>
        <Li>
          <C>/copy</C> copies the last answer, <C>/copy last 3</C> the last three messages, and <C>/copy all</C>{" "}
          the whole conversation as Markdown.
        </Li>
        <Li>
          <C>/quit</C> (or <C>/exit</C>, or <Kbd>Ctrl</Kbd> <Kbd>C</Kbd> on an empty line) saves and exits.
        </Li>
      </List>
    </DocPage>
  );
}
