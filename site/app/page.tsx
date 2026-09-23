import Image from "next/image";
import Link from "next/link";
import DocPage from "@/components/DocPage";
import CodeBlock from "@/components/CodeBlock";
import Tabs from "@/components/Tabs";
import { Callout, Figure } from "@/components/blocks";
import { A, Body, C, SectionHeading, Term } from "@/components/prose";
import { INSTALL_URL, REPO } from "@/lib/nav";
import { VERSION } from "@/lib/version";
import tuiHome from "@/assets/tui-home.png";
import tuiAnswer from "@/assets/tui-answer.png";
import tuiTimeline from "@/assets/tui-timeline.png";

/** Left column of the overview block: what canvas-cli works with. */
const WORKS_WITH = [
  "Any school on Canvas LMS",
  "macOS and Linux",
  "Windows, through npm",
  "Claude, GPT, and Gemini",
  "AWS Bedrock",
  "GitHub Copilot plans",
  "ChatGPT plans",
];

const START_HERE = [
  { href: "/quickstart/", label: "Quickstart" },
  { href: "/installation/", label: "Installation" },
  { href: "/shell/", label: "The interactive shell" },
  { href: "/ai-providers/", label: "AI providers" },
];

/** Column label inside the overview block - smaller than a section heading. */
function ColumnHeading({ children, className = "" }: { children: string; className?: string }) {
  return <h3 className={`font-pixel text-[16px] tracking-[-0.01em] mb-3 text-foreground ${className}`}>{children}</h3>;
}

export default function Overview() {
  return (
    <DocPage
      href="/"
      eyebrow={`Version ${VERSION}`}
      headerLink={{ label: "GitHub", href: REPO }}
      hero={
        <>
          <p className="font-rounded text-[18px] text-[#2a3140] dark:text-white text-center max-w-[600px] mx-auto leading-[1.5]">
            Canvas LMS in your terminal. Browse courses, open assignments, check grades, and ask questions an
            assistant answers from your own course material, with the page it came from.
          </p>

          {/* The portfolio's atmospheric glow, in canvas-cli's red and amber. */}
          <div className="relative isolate mt-10 mb-5">
            <div
              className="absolute -inset-8 opacity-60 blur-3xl -z-10 dark:-inset-6 dark:opacity-30"
              style={{
                background: "linear-gradient(135deg, #e8553f, #f0b429, #e82429, #e8553f, transparent)",
              }}
            />
            <Image
              src={tuiHome}
              alt="The canvas-cli home screen: a red pixel-art canvas wordmark over a panel listing the school, model, four connected courses, and the main slash commands."
              priority
              sizes="(min-width: 1024px) 760px, 100vw"
              className="relative z-10 w-full h-auto rounded-md"
            />
          </div>
        </>
      }
    >
      {/* OVERVIEW — what it works with on the left, the write-up on the right */}
      <div
        id="overview"
        className="grid grid-cols-1 md:grid-cols-[minmax(0,0.5fr)_minmax(0,1fr)] gap-x-10 gap-y-8 mt-6"
      >
        <div className="flex flex-col">
          <ColumnHeading>Works With</ColumnHeading>
          <ul className="flex flex-col gap-1">
            {WORKS_WITH.map((item) => (
              <li key={item} className="font-rounded text-[15px] text-muted">
                {item}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col">
          <ColumnHeading>Overview</ColumnHeading>
          <p className="font-rounded text-[16px] leading-[1.6] text-muted">
            canvas-cli is a terminal interface for Canvas. It downloads what your courses contain, the files,
            pages, announcements, and lecture links, into a local cache, and opens each assignment as a
            workspace with a brief, a plan, and every source it read. The assistant on top answers from that
            material and checks its own answer before you see it. Everything it stores stays in your project
            folder.
          </p>

          <ColumnHeading className="mt-8">Start Here</ColumnHeading>
          <ul className="flex flex-col gap-1">
            {START_HERE.map(({ href, label }) => (
              <li key={href}>
                <Link
                  href={href}
                  className="font-rounded text-[16px] text-muted underline underline-offset-[3px] hover:text-foreground"
                >
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* INSTALL */}
      <SectionHeading id="install">Install</SectionHeading>
      <Body>
        The install script puts a single self-contained binary in <C>~/.local/bin</C>, so there is nothing
        else to set up. If you already use Node.js, the npm package works everywhere, Windows included.
      </Body>
      <Tabs
        tabs={[
          {
            label: "macOS and Linux",
            content: (
              <>
                <CodeBlock>{`curl -fsSL ${INSTALL_URL} | bash`}</CodeBlock>
                <p className="font-rounded text-[15px] text-muted">
                  Checks the download against the release&rsquo;s SHA-256 sums before installing. Run it again
                  any time to update.
                </p>
              </>
            ),
          },
          {
            label: "npm",
            content: (
              <>
                <CodeBlock>{`npm install -g @reyabsaluja/canvas-cli`}</CodeBlock>
                <p className="font-rounded text-[15px] text-muted">Needs Node.js 20.10 or later. Works on Windows.</p>
              </>
            ),
          },
          {
            label: "bun",
            content: <CodeBlock>{`bun add -g @reyabsaluja/canvas-cli`}</CodeBlock>,
          },
          {
            label: "npx",
            content: (
              <>
                <CodeBlock>{`npx @reyabsaluja/canvas-cli`}</CodeBlock>
                <p className="font-rounded text-[15px] text-muted">Runs the latest version without installing it.</p>
              </>
            ),
          },
        ]}
      />
      <Body>Then start it from the folder you want to keep your coursework in:</Body>
      <CodeBlock>{`cd ~/school
canvas-cli`}</CodeBlock>
      <Body>
        The first run walks you through connecting to your school&rsquo;s Canvas with a personal access token
        and, if you want the AI features, picking a provider. The <A href="/quickstart/">Quickstart</A> goes
        through it step by step.
      </Body>

      {/* WHAT IT DOES */}
      <SectionHeading id="what-it-does">What It Does</SectionHeading>
      <Body>
        canvas-cli opens into a chat shell. Type a question, or a slash command: <C>/courses</C> moves you
        into a course, <C>/assignments</C> into an assignment, and <C>/recent</C> back to whatever you had
        open last. The header always says where you are, and <C>/help</C> only lists what works there.
      </Body>
      <Body>
        Opening an assignment for the first time turns it into a <Term>workspace</Term>. canvas-cli reads the
        instructions, the attached files, the syllabus, and anything the course links to, then writes an
        assignment brief, a step-by-step plan, and a record of which facts came from where. The second time
        you open it, it loads instantly.
      </Body>
      <Body>
        Setup lives outside the shell: <C>canvas-cli login</C> to connect, <C>canvas-cli status</C> to check
        what is configured, and <C>canvas-cli ingest</C> to download a course ahead of time.
      </Body>

      {/* GROUNDED */}
      <SectionHeading id="grounded">Grounded Answers</SectionHeading>
      <Body>
        Ask what you need to submit, when a lab is really due, or what you lost marks on last time, and the
        assistant searches your course before it answers. It reads the actual documents rather than guessing
        from their titles, and every answer names the section it came from, down to{" "}
        <C>Lab4.pdf — Page 57</C>.
      </Body>
      <Body>
        Before an answer reaches you, <Term>every date and figure in it is checked</Term> against what the
        assistant actually read. Anything it could not confirm is flagged in the answer, and its confidence
        drops. When something is not in the course at all, it says so and lists where it looked.
      </Body>
      <Figure
        src={tuiAnswer}
        alt="A workspace answer in canvas-cli listing lab deliverables, each cited to a page of the lab handout, ending with a confidence line."
        caption="Figure 1. An answer in a workspace. Each claim points at the page it came from."
      />

      {/* STUDY TOOLS */}
      <SectionHeading id="study">Study Tools</SectionHeading>
      <Body>
        The rest of Canvas is a command away. <C>/timeline</C> draws everything due in the next week, month,
        or term as a Gantt chart. <C>/grade</C> shows where you stand in each course and what you need on the
        rest to reach a letter. <C>/quiz</C> writes a practice quiz from the course material, and{" "}
        <C>/pdf</C> turns a conversation into a typeset study sheet.
      </Body>
      <Figure
        src={tuiTimeline}
        alt="The /timeline view: a Gantt chart of upcoming assignments across four courses over the next two weeks."
        caption="Figure 2. /timeline across every course, two weeks out."
      />

      {/* LOCAL FIRST */}
      <SectionHeading id="local-first">Local First</SectionHeading>
      <Body>
        Course material is downloaded once into a <C>.canvas-cli</C> folder in your project, and every
        answer is built from those files. That makes answers fast and repeatable, and it means the assistant
        is working from what your instructors actually posted.
      </Body>
      <Body>
        canvas-cli has <Term>no telemetry</Term>. Your Canvas token only ever goes to Canvas, AI keys only to
        their provider, and on macOS both live in the Keychain. <A href="/privacy/">Privacy and security</A>{" "}
        lists every place data goes.
      </Body>
      <Callout kind="note">
        <p>
          AI is optional. Browsing, the timeline, grades, announcements, and ingestion all work without a
          provider. <A href="/ai-providers/#features">What needs AI</A> has the full list.
        </p>
      </Callout>

      {/* HOW IT WORKS */}
      <SectionHeading id="how-it-works">How It Works</SectionHeading>
      <Body>
        Three layers, each usable without the next. The Canvas client talks to your school&rsquo;s REST API
        with your personal token, retrying politely when Canvas rate-limits. Ingestion turns a course into
        plain files: JSON indexes, extracted text for every PDF, Word, PowerPoint, and Excel file, and pages
        it generates itself for quizzes, the grading scheme, and the course calendar.
      </Body>
      <Body>
        The assistant sits on top. It works in a loop of up to 30 steps with a small set of tools, search the
        course, read a document or one page of it, list assignments, open a thread, and a verifier reviews the
        answer against the evidence before it is shown. It runs on Claude, GPT, or Gemini through their APIs,
        or on the <A href="/ai-providers/#subscriptions">GitHub Copilot or ChatGPT plan</A> you already pay
        for.
      </Body>

      {/* NEXT STEPS */}
      <SectionHeading id="next-steps">Next Steps</SectionHeading>
      <ul className="flex flex-col gap-3 font-rounded text-[17px] leading-[1.6] text-muted">
        <li>
          <A href="/quickstart/">Quickstart</A>: sign in, pick your courses, and ask your first question
        </li>
        <li>
          <A href="/workspaces/">Assignment workspaces</A>: what happens when you open an assignment
        </li>
        <li>
          <A href="/asking-questions/">Asking questions</A>: how answers are found, cited, and checked
        </li>
        <li>
          <A href="/slash-commands/">Slash commands</A>: everything you can type in the shell
        </li>
        <li>
          <A href="/troubleshooting/">Troubleshooting</A>: fixes for the common problems
        </li>
      </ul>
    </DocPage>
  );
}
