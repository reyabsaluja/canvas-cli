import DocPage from "@/components/DocPage";
import CodeBlock from "@/components/CodeBlock";
import { Callout, Table } from "@/components/blocks";
import { A, Body, C, SectionHeading } from "@/components/prose";
import { metadataFor } from "@/lib/nav";

export const metadata = metadataFor("/cli-reference/");

function Usage({ children }: { children: string }) {
  return <CodeBlock lang="bash">{children}</CodeBlock>;
}

export default function CLIReference() {
  return (
    <DocPage href="/cli-reference/">
      <SectionHeading id="commands">Commands</SectionHeading>
      <Body>
        Most of canvas-cli happens inside the interactive shell, which you open by running <C>canvas-cli</C> on
        its own. The commands below handle setup and scripting. For what you type inside the shell, see{" "}
        <A href="/slash-commands/">Slash commands</A>.
      </Body>
      <Table
        head={["Command", "Does"]}
        rows={[
          [<C key="0">canvas-cli</C>, "Open the interactive shell (runs the sign-in wizard first if nothing is set up)"],
          [<C key="1">canvas-cli login</C>, "Set up your Canvas account and AI provider"],
          [<C key="2">canvas-cli status</C>, "Show what is configured"],
          [<C key="3">canvas-cli ingest &lt;course&gt;</C>, "Download a course into the local cache"],
          [<C key="4">canvas-cli clean</C>, "Delete local data, and optionally your sign-in"],
          [<C key="5">canvas-cli logout</C>, "Remove a profile's stored sign-in"],
          [<C key="6">canvas-cli examples</C>, "Print common workflows"],
        ]}
      />
      <Body>
        Every command has <C>--help</C>. Run <C>canvas-cli help &lt;command&gt;</C> or{" "}
        <C>canvas-cli &lt;command&gt; --help</C> for the details.
      </Body>

      <SectionHeading id="login">login</SectionHeading>
      <Usage>{`canvas-cli login [--profile <name>]`}</Usage>
      <Body>
        Walks through your Canvas address, access token, and AI provider, verifying the token with Canvas before
        saving anything. If the profile is already set up, it asks before overwriting. It needs an interactive
        terminal.
      </Body>
      <Table
        head={["Option", "Effect"]}
        rows={[[<C key="1">--profile &lt;name&gt;</C>, "Set up a separate named profile, such as a second school"]]}
      />
      <Body>
        See the <A href="/quickstart/#sign-in">Quickstart</A> for a walkthrough and{" "}
        <A href="/configuration/#credentials">Credentials</A> for where everything is stored.
      </Body>

      <SectionHeading id="status">status</SectionHeading>
      <Usage>{`canvas-cli status [--profile <name>]`}</Usage>
      <Body>
        Prints the active profile, Canvas address, whether a token is set, the AI provider and model, the config
        folder, and where your credentials are stored. It does not contact Canvas; use <C>/doctor</C> in the
        shell to test the connection.
      </Body>
      <CodeBlock lang="text" copy={false}>{`  canvas-cli status

  Profile        default
  Canvas URL     https://school.instructure.com/api/v1
  Access Token   configured
  AI Provider    anthropic (model: claude-opus-5)
  Config Dir     /Users/you/.config/canvas-cli
  Credentials    macOS Keychain`}</CodeBlock>
      <Table
        head={["Option", "Effect"]}
        rows={[[<C key="1">--profile &lt;name&gt;</C>, <>Inspect a profile other than the active one (default: <C>CANVAS_CLI_PROFILE</C>, then <C>default</C>)</>]]}
      />

      <SectionHeading id="ingest">ingest</SectionHeading>
      <Usage>{`canvas-cli ingest [options] <course>`}</Usage>
      <Body>
        Downloads a course into <C>.canvas-cli/courses/</C> in the current folder: its structure, documents, and
        the text of every file. <C>&lt;course&gt;</C> is a course code, a name, or any unique part of either. If
        it matches no course, or more than one, canvas-cli lists the candidates and stops.
      </Body>
      <Table
        head={["Option", "Effect"]}
        rows={[
          [<C key="1">--json</C>, "Print a JSON summary instead of text, for scripts"],
          [<C key="2">--no-feedback</C>, "Leave out grader comments, feedback files, and rubric scores on your submissions"],
          [<C key="3">--refresh</C>, "Mark this run as a refresh. Every run re-fetches from Canvas; files already on disk are kept"],
        ]}
      />
      <CodeBlock>{`canvas-cli ingest CS101
canvas-cli ingest "Intro to"
canvas-cli ingest CS101 --json > summary.json`}</CodeBlock>
      <Body>
        Progress is written to stderr, so <C>--json</C> output stays clean when piped. See{" "}
        <A href="/ingestion/">Course ingestion</A> for what is captured.
      </Body>

      <SectionHeading id="clean">clean</SectionHeading>
      <Usage>{`canvas-cli clean [--all] [-y]`}</Usage>
      <Body>
        Deletes the <C>.canvas-cli</C> folder in the current directory: course caches, workspaces, conversations,
        and exports. It lists what it will remove, with sizes, and asks first.
      </Body>
      <Table
        head={["Option", "Effect"]}
        rows={[
          [<C key="1">--all</C>, "Also delete every profile's sign-in, including Keychain entries, and the config folder"],
          [<><C>-y</C>, <C>--yes</C></>, "Skip the confirmation"],
        ]}
      />
      <Callout kind="note">
        <p>
          Without a terminal to ask in, <C>clean</C> treats the question as answered &ldquo;no&rdquo;. Pass{" "}
          <C>-y</C> in scripts.
        </p>
      </Callout>

      <SectionHeading id="logout">logout</SectionHeading>
      <Usage>{`canvas-cli logout [--profile <name>]`}</Usage>
      <Body>
        Removes a profile&rsquo;s stored token, AI keys, and settings. Without <C>--profile</C> it removes the{" "}
        <C>default</C> profile. Local course data is untouched; use <C>clean</C> for that.
      </Body>

      <SectionHeading id="examples">examples</SectionHeading>
      <Usage>{`canvas-cli examples`}</Usage>
      <Body>Prints a short list of common workflows: getting started, using a subscription, ingesting, profiles, and debugging.</Body>

      <SectionHeading id="global">Global Options</SectionHeading>
      <Table
        head={["Option", "Effect"]}
        rows={[
          [<><C>-V</C>, <C>--version</C></>, "Print the version"],
          [<C key="2">--debug</C>, <>Write diagnostic detail to stderr, with every secret masked. <C>DEBUG=canvas-cli</C> does the same</>],
          [<><C>-h</C>, <C>--help</C></>, "Show help for canvas-cli or a command"],
        ]}
      />
      <CodeBlock>{`canvas-cli --debug ingest CS101 2> debug.log`}</CodeBlock>

      <SectionHeading id="exit-codes">Exit Codes</SectionHeading>
      <Table
        head={["Code", "Meaning"]}
        rows={[
          [<C key="0">0</C>, "Success"],
          [<C key="1">1</C>, "Something failed: Canvas rejected the token, the network was unreachable, no course matched, or ingestion failed"],
          [<C key="2">2</C>, <>Configuration is missing or inconsistent, for example no Canvas address, or <C>CANVAS_BASE_URL</C> set without <C>CANVAS_ACCESS_TOKEN</C></>],
          [<C key="130">130</C>, <>Cancelled with <C>Ctrl+C</C></>],
        ]}
      />
      <Body>
        Errors print a one-line explanation and a suggested fix, such as{" "}
        <C>Run `canvas-cli login` to set up</C>.
      </Body>
    </DocPage>
  );
}
