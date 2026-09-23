import DocPage from "@/components/DocPage";
import CodeBlock from "@/components/CodeBlock";
import { Callout, Figure, Table } from "@/components/blocks";
import { A, Body, C, Kbd, Li, List, SectionHeading, Term } from "@/components/prose";
import { metadataFor } from "@/lib/nav";
import timeline from "@/assets/tui-timeline.png";
import gradeSummary from "@/assets/tui-grade-summary.png";
import grade from "@/assets/tui-grade.png";
import quizQuestion from "@/assets/tui-quiz-question.png";
import quizResults from "@/assets/tui-quiz-results.png";
import announcements from "@/assets/tui-announcements.png";

export const metadata = metadataFor("/study-tools/");

export default function StudyTools() {
  return (
    <DocPage href="/study-tools/">
      <SectionHeading id="timeline">Timeline</SectionHeading>
      <Body>
        <C>/timeline</C> draws your upcoming work as a Gantt chart: one row per assignment, grouped by course,
        with a marker for today. In global scope it covers every course; in a course, just that one.
      </Body>
      <Figure
        src={timeline}
        alt="A Gantt chart of nine upcoming assignments across four courses, each course in its own color, with a TODAY marker."
        caption="/timeline in global scope."
      />
      <Body>
        Each bar starts when the assignment unlocks, or a week before it is due if it has no unlock date, and
        ends when it is due. Light shading is time when the work is open, a solid block means due within 48
        hours, a denser shade means overdue, and a small square marks something that happens at one moment. Work
        that has already been graded is hidden unless you add <C>--all</C>.
      </Body>
      <Table
        head={["Command", "Shows"]}
        rows={[
          [<C key="1">/timeline</C>, "Two weeks back to four weeks ahead"],
          [<C key="2">/timeline week</C>, "This week, Monday to Sunday"],
          [<C key="3">/timeline month</C>, "This calendar month"],
          [<C key="4">/timeline semester</C>, "From the earliest to the latest due date"],
          [<C key="5">/timeline next 10 days</C>, "The next N days, weeks, or months"],
          [<C key="6">/timeline --all</C>, "Include graded work; combines with any of the above"],
        ]}
      />

      <SectionHeading id="grades">Grades</SectionHeading>
      <Body>
        <C>/grade</C> in global scope lists every course with its current letter and percentage, as Canvas
        reports it.
      </Body>
      <Figure
        src={gradeSummary}
        alt="A grades table for four courses, followed by /grade need A- signals, which reports an average of 90.5% needed on the remaining work."
        caption="/grade, then /grade need A- signals."
      />
      <Body>
        In a course, or with a course name (<C>/grade signals</C>), it shows the breakdown: each assignment group
        with its weight and average, every assignment&rsquo;s score, what is still to come, and how much of the
        final grade has been decided so far.
      </Body>
      <Figure src={grade} alt="The grade breakdown for Signals and Systems: labs, problem sets, and exams with their weights, scores, and due dates for ungraded work." />
      <Body>
        <C>/grade need</C> works out the average you need on the remaining work to reach a target. The target
        can be a letter from A+ down to D&minus;, or a percentage. In global scope, name the course too:
      </Body>
      <CodeBlock lang="text" copy={false}>{`/grade need A-            # in a course
/grade need 85 signals    # anywhere`}</CodeBlock>
      <Body>
        It takes group weights into account, and ignores assignments excluded from the final grade. The answer
        comes with a verdict: very achievable, achievable with strong performance, possible but difficult, or
        not reachable, in which case it tells you the best you can still get. Letters use a standard scale: A
        from 93, A&minus; from 90, B+ from 87, and so on down to D&minus; at 60.
      </Body>

      <SectionHeading id="quiz">Practice Quizzes</SectionHeading>
      <Body>
        <C>/quiz</C> writes a practice quiz from the course material and runs it full screen. It needs an AI
        provider. Arguments can come in any order:
      </Body>
      <Table
        head={["Argument", "Effect", "Default"]}
        rows={[
          ["A number, 1 to 20", "How many questions", "5"],
          [<><C>easy</C>, <C>medium</C>, <C>hard</C></>, "Recall, application, or multi-step reasoning", "medium"],
          [<C key="f">flash</C>, "Flashcards instead of questions", "off"],
          ["Any other words", "The topic to focus on", "What you were just discussing"],
        ]}
      />
      <CodeBlock lang="text" copy={false}>{`/quiz
/quiz 10 hard fourier series
/quiz flash eigenvalues`}</CodeBlock>
      <Body>
        Questions are a mix of multiple choice, true or false, and fill in the blank, drawn only from your course
        material, the recent conversation, and in a workspace, the assignment itself.
      </Body>
      <Figure src={quizQuestion} alt="A multiple-choice practice question about the Gibbs phenomenon with four options." />
      <List>
        <Li>
          Multiple choice: press <Kbd>a</Kbd> to <Kbd>d</Kbd>. True or false: <Kbd>t</Kbd> or <Kbd>f</Kbd>.
        </Li>
        <Li>Fill in the blank: type the answer and press Enter. Capitalization and surrounding spaces are ignored.</Li>
        <Li>
          Flashcards: <Kbd>Space</Kbd> reveals the answer, then <Kbd>y</Kbd> if you knew it or <Kbd>n</Kbd> if
          you did not.
        </Li>
        <Li>
          <Kbd>s</Kbd> skips a multiple-choice or true-or-false question (it counts as wrong), and <Kbd>q</Kbd>{" "}
          or <Kbd>Esc</Kbd> ends the quiz.
        </Li>
      </List>
      <Body>Each answer is followed by an explanation. At the end, your score and a breakdown by topic are added to the conversation:</Body>
      <Figure src={quizResults} alt="Quiz results: 3 of 5 correct, with a topic table showing which topics were missed and the average time per question." />

      <SectionHeading id="lectures">Lectures</SectionHeading>
      <Body>
        <C>/lecture</C> (or <C>/lec</C>) finds lecture material in a course or workspace. With no argument it
        lists every lecture it knows about. With one, it opens the match: slides in your PDF viewer, recordings in
        your browser.
      </Body>
      <CodeBlock lang="text" copy={false}>{`/lecture
/lecture 7
/lec 13 slides
/lecture gibbs phenomenon`}</CodeBlock>
      <Body>
        Lectures are found by their titles (&ldquo;Lecture 7&rdquo;, &ldquo;Week 3&rdquo;, &ldquo;Module
        5&rdquo;) and by embedded players from YouTube, Panopto, Kaltura, Echo360, Zoom, and other hosts. If a
        lecture has both slides and a recording, add <C>slides</C> or <C>video</C> to pick one.
      </Body>

      <SectionHeading id="announcements">Announcements</SectionHeading>
      <Body>
        <C>/announcements</C> opens a full-screen list, newest first, across all courses in global scope or for
        one course. <Kbd>↑</Kbd> <Kbd>↓</Kbd> move, <Kbd>Enter</Kbd> reads one with its replies, and{" "}
        <Kbd>Esc</Kbd> goes back.
      </Body>
      <Figure src={announcements} alt="The announcements list showing four recent announcements from three courses, each with its author and date." />
      <Body>
        <C>/thread</C> reads a discussion or announcement in the chat, with every reply nested beneath it. Give it
        the topic id or part of the title; if several match, it lists them.
      </Body>
      <CodeBlock lang="text" copy={false}>{`/thread room change
/thread 701`}</CodeBlock>

      <SectionHeading id="browse">Files and Modules</SectionHeading>
      <Body>
        In a course, <C>/files</C> lists the downloaded files with their type and size, and <C>/modules</C> lists
        the course&rsquo;s modules in order with how many items each has. Open anything they list with{" "}
        <C>/open</C>.
      </Body>

      <SectionHeading id="open">Opening Things</SectionHeading>
      <Body>
        In a course or workspace, <C>/open</C> opens a file, page, or link with your system&rsquo;s default app.
        As you type, a list of matching resources appears above the input.
      </Body>
      <CodeBlock lang="text" copy={false}>{`/open lab handout
/open list          # everything that can be opened
/open it            # the last PDF you exported`}</CodeBlock>
      <Body>
        You can also just ask: &ldquo;open the lab 3 pdf&rdquo; works the same way. For safety, canvas-cli only
        opens web links and files inside your workspace, course cache, or exports folder. In global scope,{" "}
        <C>/open</C> jumps to a course or workspace instead.
      </Body>

      <SectionHeading id="pdf">PDF Export</SectionHeading>
      <Body>
        <C>/pdf</C> (or <C>/make-pdf</C>) turns the conversation into a study document. Say what you want in it:
      </Body>
      <CodeBlock lang="text" copy={false}>{`/pdf a one-page summary of the lab requirements
/pdf formula sheet for the midterm`}</CodeBlock>
      <Body>
        You can also end any message with <C>/pdf</C>. The model writes the document, and canvas-cli typesets it
        with LaTeX when a compiler is installed (<C>tectonic</C>, <C>pdflatex</C>, <C>xelatex</C>, or{" "}
        <C>lualatex</C>), so equations come out properly. If none is installed, it offers to install Tectonic
        (with Homebrew on macOS, or Chocolatey or Scoop on Windows) or to use a simpler built-in layout instead.
        If the LaTeX fails to compile, the model gets one chance to fix it before canvas-cli falls back to the
        simple layout. Without an AI provider, <C>/pdf</C> still works: it lays out the conversation itself in
        the simple layout.
      </Body>
      <Body>
        The PDF opens when it is ready. It is saved in the workspace&rsquo;s <C>exports/</C> folder, or in{" "}
        <C>.canvas-cli/exports/</C> outside a workspace, named with the time and a short title, alongside the
        Markdown (and LaTeX) it was made from.
      </Body>
      <Callout kind="tip">
        <p>
          On Linux there is no automatic installer; install Tectonic or TeX Live with your package manager and
          canvas-cli will find it.
        </p>
      </Callout>

      <SectionHeading id="copy">Copying</SectionHeading>
      <Table
        head={["Command", "Copies"]}
        rows={[
          [<><C>/copy</C> or <Kbd>Ctrl</Kbd> <Kbd>Y</Kbd></>, "The last answer, with its sources"],
          [<C key="2">/copy last 3</C>, "The last three messages (yours and the assistant's)"],
          [<C key="3">/copy all</C>, "The whole conversation as Markdown"],
        ]}
      />
      <Body>
        Copying uses <C>pbcopy</C> on macOS, <C>clip</C> on Windows, and <C>wl-copy</C>, <C>xclip</C>, or{" "}
        <C>xsel</C> on Linux. See <A href="/troubleshooting/">Troubleshooting</A> if nothing lands on the
        clipboard.
      </Body>
    </DocPage>
  );
}
