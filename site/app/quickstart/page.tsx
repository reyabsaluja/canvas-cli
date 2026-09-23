import DocPage from "@/components/DocPage";
import CodeBlock from "@/components/CodeBlock";
import { Callout, Figure, Step, Steps } from "@/components/blocks";
import { A, Body, C, Kbd, Li, List, SectionHeading, Term } from "@/components/prose";
import { INSTALL_URL, metadataFor } from "@/lib/nav";
import loginProvider from "@/assets/tui-login-provider.png";
import firstRun from "@/assets/tui-first-run.png";
import courses from "@/assets/tui-courses.png";
import course from "@/assets/tui-course.png";
import assignments from "@/assets/tui-assignments.png";
import answer from "@/assets/tui-answer.png";

export const metadata = metadataFor("/quickstart/");

export default function Quickstart() {
  return (
    <DocPage href="/quickstart/">
      <SectionHeading id="before">Before You Begin</SectionHeading>
      <Body>You need three things, and a fourth if you want the assistant:</Body>
      <List>
        <Li>
          A Canvas account at your school, and permission to create a <Term>personal access token</Term>. Most
          schools allow it; a few turn it off for students.
        </Li>
        <Li>A terminal on macOS or Linux. On Windows, install with npm instead (Node.js 20.10 or later).</Li>
        <Li>A folder to work in. canvas-cli keeps its course cache and workspaces in the folder you start it from.</Li>
        <Li>
          Optionally, an AI provider: an API key from Anthropic, OpenAI, or Google, AWS Bedrock credentials, or a
          GitHub Copilot or ChatGPT plan. Browsing, grades, and the timeline work without one.
        </Li>
      </List>

      <Steps>
        <Step n={1} id="install" title="Install canvas-cli">
          <CodeBlock>{`curl -fsSL ${INSTALL_URL} | bash`}</CodeBlock>
          <Body>
            This installs a single binary to <C>~/.local/bin</C>. If that folder is not on your <C>PATH</C>, the
            installer prints the one line to add. On Windows, or if you prefer npm, run{" "}
            <C>npm install -g @reyabsaluja/canvas-cli</C>. <A href="/installation/">Installation</A> covers every
            option.
          </Body>
        </Step>

        <Step n={2} id="token" title="Create a Canvas access token">
          <List ordered>
            <Li>Sign in to your school&rsquo;s Canvas in a browser.</Li>
            <Li>
              Open <Term>Account → Settings</Term> (your profile picture, then Settings).
            </Li>
            <Li>
              Under <Term>Approved Integrations</Term>, choose <Term>+ New Access Token</Term>.
            </Li>
            <Li>Give it a purpose such as &ldquo;canvas-cli&rdquo;, optionally an expiry date, and generate it.</Li>
            <Li>Copy the token now. Canvas only shows it once.</Li>
          </List>
          <Callout kind="warning">
            <p>
              Treat the token like a password: it can do anything you can do in Canvas. If it leaks, delete it
              under Approved Integrations and make a new one.
            </p>
          </Callout>
        </Step>

        <Step n={3} id="sign-in" title="Sign in">
          <Body>Start canvas-cli from the folder you want to use for coursework:</Body>
          <CodeBlock>{`mkdir -p ~/school && cd ~/school
canvas-cli`}</CodeBlock>
          <Body>
            With nothing configured yet, it opens the sign-in wizard. You can also run it any time with{" "}
            <C>canvas-cli login</C>. The wizard asks for three things, and <Kbd>Esc</Kbd> goes back a step:
          </Body>
          <List ordered>
            <Li>
              <Term>Your school&rsquo;s Canvas address</Term>, such as <C>school.instructure.com</C>. Leave off{" "}
              <C>/api/v1</C>; canvas-cli adds it. HTTPS is required.
            </Li>
            <Li>
              <Term>The access token</Term>. It is typed hidden and checked against Canvas right away, so a typo
              or wrong address is caught here rather than later.
            </Li>
            <Li>
              <Term>An AI provider</Term>, or <Term>Skip</Term>. Pick one, then a model and a thinking effort.
              Copilot and ChatGPT use your existing plan through their own CLI, with no API key.
            </Li>
          </List>
          <Figure
            src={loginProvider}
            alt="The canvas-cli login wizard after the Canvas URL and token are verified, showing a list of AI providers: GitHub Copilot, ChatGPT via Codex, OpenAI, Anthropic, Google, AWS Bedrock, and Skip."
            caption="The provider step. The URL and token above it have already been verified."
          />
          <Body>
            On macOS the token and any API key go into your Keychain. Elsewhere they are saved to files only you
            can read under <C>~/.config/canvas-cli</C>. See <A href="/configuration/#credentials">Credentials</A>.
          </Body>
        </Step>

        <Step n={4} id="pick-courses" title="Pick your courses">
          <Body>
            The first time you start canvas-cli in a folder, it lists your current Canvas courses so you can
            choose the ones you care about. Press <Kbd>Space</Kbd> or <Kbd>Enter</Kbd> to select a course, and{" "}
            <Kbd>d</Kbd> when you are done. Next you can give each one a short name, or press <Kbd>Enter</Kbd> to
            keep the original.
          </Body>
          <Figure
            src={firstRun}
            alt="The first-run course picker titled Welcome to canvas, with two of four courses selected and a footer reading d done (2 selected)."
            caption="First run in a folder. The footer counts your selection; d finishes."
          />
          <Body>
            The selection is saved in <C>.canvas-cli/user-courses.json</C> in that folder, so each folder can
            track a different set. Change it later with <C>/manage-courses</C>.
          </Body>
        </Step>

        <Step n={5} id="course" title="Open a course">
          <Body>
            You land in the global home screen. Type <C>/courses</C> and press <Kbd>Enter</Kbd> to pick one. Type
            to filter the list.
          </Body>
          <Figure src={courses} alt="The Courses picker listing four courses with their codes and term." />
          <Body>
            The first time you open a course, canvas-cli downloads it: modules, pages, files, announcements, and
            the text of every document. It takes a few seconds to a minute depending on the course, and{" "}
            <Kbd>Esc</Kbd> cancels. After that the course opens straight away, with what is due next.
          </Body>
          <Figure
            src={course}
            alt="Course scope for Signals and Systems, listing upcoming work: Lab 3 due in 2 days, Problem Set 4 due in 5 days, and the midterm on October 21."
            caption="Course scope. Ask about the course, or open an assignment."
          />
        </Step>

        <Step n={6} id="workspace" title="Open an assignment">
          <Body>
            Type <C>/assignments</C>. Upcoming work is at the top, and anything already submitted is dimmed with a
            check mark.
          </Body>
          <Figure src={assignments} alt="The assignment picker for Signals and Systems. Lab 3, due in 2 days, is highlighted." />
          <Body>
            Choosing one builds a <A href="/workspaces/">workspace</A>: canvas-cli reads the instructions and every
            document they point to, then writes a brief and a plan. This part needs an AI provider. You see each
            step as it happens, and the workspace opens with a summary of the assignment.
          </Body>
        </Step>

        <Step n={7} id="ask" title="Ask a question">
          <Body>Type a question in plain language and press Enter:</Body>
          <CodeBlock lang="text" copy={false}>{`what do I need to submit for this lab?`}</CodeBlock>
          <Figure
            src={answer}
            alt="An answer listing the two files to submit for Lab 3, with each claim cited to a page of Lab3_Fourier_Series.pdf, and source lines below."
            caption="The assistant read the handout before answering. Each claim names its page."
          />
          <Body>
            Press <Kbd>Esc</Kbd> to stop an answer early, <Kbd>Ctrl</Kbd>+<Kbd>Y</Kbd> to copy it, and type{" "}
            <C>/help</C> to see every command available where you are.
          </Body>
        </Step>
      </Steps>

      <SectionHeading id="next">Where Next</SectionHeading>
      <List>
        <Li>
          <A href="/shell/">The interactive shell</A>: scopes, keyboard shortcuts, and <C>@</C> pins
        </Li>
        <Li>
          <A href="/asking-questions/">Asking questions</A>: what the assistant checks before it answers
        </Li>
        <Li>
          <A href="/study-tools/">Study tools</A>: <C>/timeline</C>, <C>/grade</C>, <C>/quiz</C>, and{" "}
          <C>/pdf</C>
        </Li>
        <Li>
          <A href="/ai-providers/">AI providers</A>: choosing a model, or using a plan you already pay for
        </Li>
      </List>
    </DocPage>
  );
}
