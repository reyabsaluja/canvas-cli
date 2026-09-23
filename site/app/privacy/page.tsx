import DocPage from "@/components/DocPage";
import CodeBlock from "@/components/CodeBlock";
import { Callout, Table } from "@/components/blocks";
import { A, Body, C, Li, List, SectionHeading, Term } from "@/components/prose";
import { metadataFor } from "@/lib/nav";

export const metadata = metadataFor("/privacy/");

export default function Privacy() {
  return (
    <DocPage href="/privacy/">
      <SectionHeading id="no-telemetry">No Telemetry</SectionHeading>
      <Body>
        canvas-cli collects <Term>no telemetry, analytics, or usage data</Term>. It has no crash reporter, no
        update check, and no service of its own to talk to. Every network request it makes is one of the few
        listed below, and each happens because you asked for something. If analytics are ever added, they will be
        opt-in and announced before any data is collected.
      </Body>

      <SectionHeading id="stays">What Stays</SectionHeading>
      <Table
        head={["Location", "Contents"]}
        rows={[
          [
            <C key="1">~/.config/canvas-cli/</C>,
            "Profile settings, and your Canvas token and AI keys when the file store is used. On macOS these secrets are in the Keychain instead.",
          ],
          [
            <C key="2">.canvas-cli/</C>,
            "Downloaded course material, extracted text, workspaces, conversations, and exports, in the folder you run canvas-cli from",
          ],
        ]}
      />
      <Body>
        Your conversations, notes, and course files never leave your machine except as part of a question you
        send to your AI provider.
      </Body>

      <SectionHeading id="leaves">What Leaves</SectionHeading>
      <Table
        head={["Destination", "What is sent", "When"]}
        rows={[
          [
            "Your school's Canvas",
            "Your Canvas token, in the Authorization header",
            "Signing in, ingesting, and any command that reads from Canvas",
          ],
          [
            "Your AI provider (Anthropic, OpenAI, Google, or AWS)",
            "Your API key, and the question with the course material the assistant needs to answer it",
            "Asking questions, preparing workspaces, /quiz, and /pdf",
          ],
          [
            "GitHub or OpenAI, through the copilot or codex CLI",
            "The same prompt content, sent by the vendor's CLI under your own login",
            <>Only with <C key="c">AI_PROVIDER=copilot</C> or <C key="d">codex</C></>,
          ],
          [
            "Websites your course links to",
            "An ordinary request for the page or document, with no credentials",
            "During ingestion, to capture linked documents",
          ],
          [
            "Your AI provider's key-check endpoint",
            "Your API key, in a request that uses a single token at most",
            <>Only when you run <C key="e">/doctor</C></>,
          ],
        ]}
      />
      <Body>
        Each secret goes only to its own service: your Canvas token only to your Canvas site, and each AI key only
        to its provider. Links in course content that point back to your own Canvas site are fetched with your
        token, like any other Canvas request; links to anywhere else never are.
      </Body>
      <Body>
        Opening a file or lecture hands it to your operating system&rsquo;s default app (<C>open</C>,{" "}
        <C>xdg-open</C>, or <C>start</C>), and installing Tectonic for <C>/pdf</C> runs your package manager, but
        only after you choose to.
      </Body>

      <SectionHeading id="secrets">Secrets</SectionHeading>
      <List>
        <Li>
          On macOS, the Canvas token and API keys are stored in the Keychain, and canvas-cli verifies the write
          before removing any older plaintext copy.
        </Li>
        <Li>
          Elsewhere they are stored in files readable only by your user account, in a folder readable only by you.
        </Li>
        <Li>
          The sign-in wizard hides the token and keys as you type them, and <C>status</C> only ever says whether one
          is configured.
        </Li>
        <Li>
          A Canvas address set in the environment is never combined with a stored token, so a <C>.env</C> file
          cannot redirect your saved token to another server. See{" "}
          <A href="/configuration/#env-file">.env files</A>.
        </Li>
        <Li>
          Files are only downloaded from your Canvas site, file names from Canvas are sanitized before anything is
          written to disk, and zip archives are unpacked with size limits.
        </Li>
      </List>

      <SectionHeading id="subscriptions">Subscription CLIs</SectionHeading>
      <Body>
        When you use GitHub Copilot or ChatGPT through their CLIs, canvas-cli keeps them boxed in. Each request
        starts the CLI in a new, empty temporary folder that is deleted afterwards, with its own tools for running
        commands, reading and writing files, and browsing the web removed. The only tools it can use are
        canvas-cli&rsquo;s own, offered over a server that listens on <C>127.0.0.1</C> only and rejects any
        request without a random token created for that one request. The tools themselves run inside canvas-cli.
      </Body>
      <Body>
        Codex runs with a read-only sandbox and without saving the session. Copilot runs without your custom
        instructions or its built-in integrations.
      </Body>
      <Callout kind="note">
        <p>
          Copilot receives the prompt as a command-line argument, so while a request is running, other users on
          the same computer could see it in the process list. On a shared machine, prefer an API key provider.
        </p>
      </Callout>

      <SectionHeading id="debug">Debug Output</SectionHeading>
      <Body>
        <C>--debug</C> (or <C>DEBUG=canvas-cli</C>) writes diagnostic detail to stderr and nowhere else. Before
        anything is printed, tokens, API keys, passwords, authorization headers, and sensitive URL parameters are
        replaced with <C>***</C>, so a debug log is safe to attach to a bug report:
      </Body>
      <CodeBlock>{`canvas-cli --debug ingest CS101 2> debug.log`}</CodeBlock>
      <Body>
        Found a security problem? Please don&rsquo;t post the details in a public issue. Open an{" "}
        <A href="https://github.com/reyabsaluja/canvas-cli/issues">issue</A> asking for a private way to share
        them, and the maintainer will follow up.
      </Body>
    </DocPage>
  );
}
