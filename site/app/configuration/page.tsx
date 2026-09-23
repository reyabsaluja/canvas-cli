import DocPage from "@/components/DocPage";
import CodeBlock from "@/components/CodeBlock";
import { Callout, Table } from "@/components/blocks";
import { A, Body, C, Li, List, SectionHeading, Term } from "@/components/prose";
import { metadataFor } from "@/lib/nav";

export const metadata = metadataFor("/configuration/");

export default function Configuration() {
  return (
    <DocPage href="/configuration/">
      <SectionHeading id="where">Where Things Live</SectionHeading>
      <Body>canvas-cli keeps two kinds of state in two places:</Body>
      <Table
        head={["Location", "Holds"]}
        rows={[
          [
            <C key="1">~/.config/canvas-cli/</C>,
            "Your sign-in: the Canvas address, AI provider settings, and (outside the macOS Keychain) your secrets. One set per profile.",
          ],
          [
            <C key="2">.canvas-cli/</C>,
            <>
              In whatever folder you run canvas-cli from: course caches, workspaces, conversations, exports, and your
              course list. See <A href="/local-files/">Local files</A>.
            </>,
          ],
        ]}
      />
      <Body>
        Set <C>XDG_CONFIG_HOME</C> to move the first one; it becomes <C>$XDG_CONFIG_HOME/canvas-cli</C>. The
        folder is readable only by you, and so is every file in it.
      </Body>

      <SectionHeading id="credentials">Credentials</SectionHeading>
      <Body>
        <C>canvas-cli login</C> stores your Canvas token and any AI keys once, so you never paste them again.
        Where they go depends on your system:
      </Body>
      <List>
        <Li>
          <Term>macOS:</Term> the login Keychain, under the service <C>canvas-cli</C>, one item per profile and
          secret. No plaintext copy is written, and any old one is removed.
        </Li>
        <Li>
          <Term>Linux and Windows</Term>, or when the Keychain is unavailable: files under{" "}
          <C>~/.config/canvas-cli/credentials/</C>, readable only by you.
        </Li>
      </List>
      <Body>
        Setting <C>CANVAS_CLI_CREDENTIAL_BACKEND=file</C> forces the file store on macOS too, which is mainly
        useful in tests and CI. <C>canvas-cli status</C> tells you which store is in use. Subscription providers
        store nothing: their login belongs to the vendor&rsquo;s own CLI.
      </Body>

      <SectionHeading id="profiles">Profiles</SectionHeading>
      <Body>
        Profiles keep separate Canvas accounts apart, for example your university and a summer program. Each has
        its own Canvas address, token, and AI settings.
      </Body>
      <CodeBlock>{`canvas-cli login --profile summer     # set one up
canvas-cli status --profile summer    # check it
export CANVAS_CLI_PROFILE=summer      # use it for the shell and ingest`}</CodeBlock>
      <Body>
        <C>login</C>, <C>logout</C>, and <C>status</C> take <C>--profile</C>. The shell and <C>ingest</C> use{" "}
        <C>CANVAS_CLI_PROFILE</C>, or <C>default</C> if it is unset. Profile names can use letters, numbers,
        hyphens, and underscores.
      </Body>
      <Callout kind="note">
        <p>
          <C>canvas-cli logout</C> without <C>--profile</C> always removes the <C>default</C> profile, even when{" "}
          <C>CANVAS_CLI_PROFILE</C> is set. Name the profile to log out of another one.
        </p>
      </Callout>

      <SectionHeading id="env-file">.env Files</SectionHeading>
      <Body>
        Everything <C>login</C> stores can also come from environment variables, or from a <C>.env</C> file in
        the folder you run canvas-cli from. That suits shared machines and scripts, where you would rather not
        store anything:
      </Body>
      <CodeBlock title=".env">{`CANVAS_BASE_URL=https://school.instructure.com/api/v1
CANVAS_ACCESS_TOKEN=12345~abcdef...
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...`}</CodeBlock>
      <Callout kind="warning">
        <p>
          <C>CANVAS_BASE_URL</C> is used exactly as written, so it must include <C>/api/v1</C>, unlike the address
          you type into <C>login</C>. And when the URL comes from the environment, the token must too: canvas-cli
          will not send your stored token to an address it did not store, so a stray <C>.env</C> can never
          redirect it to another host.
        </p>
      </Callout>
      <Body>
        Keep <C>.env</C> out of version control. A real environment variable always wins over the same one in{" "}
        <C>.env</C>.
      </Body>

      <SectionHeading id="variables">Variables</SectionHeading>
      <Table
        head={["Variable", "Purpose"]}
        rows={[
          [<C key="1">CANVAS_BASE_URL</C>, <>Canvas API address, used as is; include <C>/api/v1</C></>],
          [<C key="2">CANVAS_ACCESS_TOKEN</C>, "Canvas personal access token"],
          [<C key="3">CANVAS_CLI_PROFILE</C>, <>Active profile for the shell and <C>ingest</C> (default <C>default</C>)</>],
          [<C key="4">AI_PROVIDER</C>, <><C>anthropic</C>, <C>openai</C>, <C>google</C>, <C>bedrock</C>, <C>copilot</C>, or <C>codex</C>; see <A href="/ai-providers/#detection">aliases</A></>],
          [<C key="5">AI_MODEL</C>, "Model id for the provider"],
          [<C key="6">AI_EFFORT</C>, <><C>low</C>, <C>medium</C>, <C>high</C>, <C>xhigh</C>, or <C>max</C></>],
          [<C key="7">ANTHROPIC_API_KEY</C>, "Anthropic key"],
          [<C key="8">OPENAI_API_KEY</C>, "OpenAI key"],
          [<C key="9">GOOGLE_API_KEY</C>, "Google AI Studio key"],
          [<C key="10">AWS_REGION</C>, "Bedrock region"],
          [<><C>AWS_ACCESS_KEY_ID</C>, <C>AWS_SECRET_ACCESS_KEY</C></>, "Bedrock credentials"],
          [<><C>AWS_SESSION_TOKEN</C>, <C>AWS_BEARER_TOKEN_BEDROCK</C></>, "Temporary or bearer-token Bedrock credentials"],
          [<C key="13">CODEX_HOME</C>, <>Where Codex keeps its model catalog (default <C>~/.codex</C>)</>],
          [<><C>COPILOT_GITHUB_TOKEN</C>, <C>GH_TOKEN</C>, <C>GITHUB_TOKEN</C></>, "Any of these tells canvas-cli that Copilot is signed in"],
          [<C key="15">CANVAS_CLI_CREDENTIAL_BACKEND</C>, <><C>file</C> stores secrets in files instead of the macOS Keychain</>],
          [<C key="16">XDG_CONFIG_HOME</C>, <>Moves the config folder from <C>~/.config</C></>],
          [<C key="17">DEBUG=canvas-cli</C>, <>Same as <C>--debug</C></>],
        ]}
      />

      <SectionHeading id="precedence">Precedence</SectionHeading>
      <Body>When the same setting comes from more than one place, the first of these wins:</Body>
      <List ordered>
        <Li>An environment variable set in your shell</Li>
        <Li>The same variable in <C>.env</C> in the current folder</Li>
        <Li>What <C>canvas-cli login</C> stored for the active profile</Li>
      </List>
      <Body>
        <C>canvas-cli status</C> shows the result, including where the credentials came from, without contacting
        Canvas. <C>/doctor</C> in the shell goes further and checks that they actually work.
      </Body>

      <SectionHeading id="config-json">config.json</SectionHeading>
      <Body>
        Each profile&rsquo;s settings are a small JSON file: <C>config.json</C> for the default profile,{" "}
        <C>config.&lt;profile&gt;.json</C> for others. <C>login</C> and <C>/model</C> write it, and you can edit
        it by hand.
      </Body>
      <CodeBlock lang="json" title="~/.config/canvas-cli/config.json">{`{
  "canvasBaseUrl": "https://school.instructure.com",
  "aiProvider": "anthropic",
  "aiModel": "claude-opus-5",
  "aiEffort": "high",
  "ingestSubmissionFeedback": true
}`}</CodeBlock>
      <Table
        head={["Key", "Meaning"]}
        rows={[
          [<C key="1">canvasBaseUrl</C>, <>Your Canvas address, without <C>/api/v1</C></>],
          [<C key="2">aiProvider</C>, "The provider chosen at sign-in or with /model"],
          [<C key="3">aiModel</C>, "The model id"],
          [<C key="4">aiEffort</C>, "The effort level"],
          [<C key="5">awsRegion</C>, "The Bedrock region"],
          [<C key="6">ingestSubmissionFeedback</C>, <>Set to <C>false</C> to skip your grader feedback during ingestion by default</>],
        ]}
      />
    </DocPage>
  );
}
