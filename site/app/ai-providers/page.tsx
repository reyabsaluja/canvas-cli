import DocPage from "@/components/DocPage";
import CodeBlock from "@/components/CodeBlock";
import { Callout, Figure, Table } from "@/components/blocks";
import { A, Body, C, Li, List, SectionHeading, SubHeading, Term } from "@/components/prose";
import { metadataFor } from "@/lib/nav";
import loginModel from "@/assets/tui-login-model.png";

export const metadata = metadataFor("/ai-providers/");

export default function AIProviders() {
  return (
    <DocPage href="/ai-providers/">
      <SectionHeading id="choosing">Choosing</SectionHeading>
      <Body>
        canvas-cli needs one AI provider for its assistant, and any of these works. Pick one in the sign-in
        wizard (<C>canvas-cli login</C>), switch any time with <C>/model</C> in the shell, or set it in the{" "}
        <A href="/configuration/#variables">environment</A>.
      </Body>
      <Table
        head={["Provider", "Default model", "You need"]}
        rows={[
          ["GitHub Copilot", <C key="1">auto</C>, "A Copilot plan (Free, or the free Pro that students get) and the copilot CLI"],
          ["ChatGPT via Codex", "Codex's current default", "A ChatGPT plan and the codex CLI. Experimental"],
          ["Anthropic", <><C>claude-opus-5</C></>, "An Anthropic API key"],
          ["OpenAI", <><C>gpt-5.6</C></>, "An OpenAI API key"],
          ["Google", <><C>gemini-3.8-flash</C></>, "A Google AI Studio API key"],
          ["AWS Bedrock", <><C>us.anthropic.claude-sonnet-5</C></>, "AWS credentials with Bedrock model access"],
        ]}
      />
      <Body>
        If you already have GitHub Copilot or a ChatGPT plan, start there: there is no key to manage and usage
        counts against the plan you pay for. Otherwise any API key works. A student using the assistant a few
        times a week typically spends a dollar or two a month on API usage, less with the smaller models; your
        provider&rsquo;s pricing page has current rates.
      </Body>

      <SectionHeading id="features">What Needs AI</SectionHeading>
      <Table
        head={["Feature", "Needs a provider"]}
        rows={[
          ["Browsing courses, assignments, files, and modules", "No"],
          [<><C>/timeline</C>, <C>/grade</C>, <C>/announcements</C>, <C>/thread</C></>, "No"],
          [<><C>canvas-cli ingest</C> and <C>/refresh</C></>, "No"],
          [<><C>/lecture</C>, <C>/open</C>, <C>/doctor</C></>, "No"],
          ["Asking questions in any scope", "Yes"],
          ["Opening an assignment as a workspace", "Yes"],
          [<C key="q">/quiz</C>, "Yes"],
          [<C key="p">/pdf</C>, "Optional: without one, it exports the conversation in a simple layout"],
        ]}
      />

      <SectionHeading id="anthropic">Anthropic</SectionHeading>
      <List ordered>
        <Li>
          Sign in at <A href="https://console.anthropic.com/">console.anthropic.com</A> and open{" "}
          <Term>API Keys</Term>.
        </Li>
        <Li>
          Create a key named &ldquo;canvas-cli&rdquo; and copy it. It starts with <C>sk-ant-</C>.
        </Li>
        <Li>
          Run <C>canvas-cli login</C>, choose Anthropic, and paste it. Or set it in the environment:
        </Li>
      </List>
      <CodeBlock title=".env">{`AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...`}</CodeBlock>

      <SectionHeading id="openai">OpenAI</SectionHeading>
      <List ordered>
        <Li>
          Sign in at <A href="https://platform.openai.com/">platform.openai.com</A> and open <Term>API keys</Term>.
        </Li>
        <Li>Create a secret key and copy it. It starts with <C>sk-</C>.</Li>
        <Li>Choose OpenAI in <C>canvas-cli login</C> and paste it, or:</Li>
      </List>
      <CodeBlock title=".env">{`AI_PROVIDER=openai
OPENAI_API_KEY=sk-...`}</CodeBlock>

      <SectionHeading id="google">Google</SectionHeading>
      <List ordered>
        <Li>
          Sign in at <A href="https://aistudio.google.com/">aistudio.google.com</A> and choose{" "}
          <Term>Get API key</Term>.
        </Li>
        <Li>Create a key in a new or existing project and copy it.</Li>
        <Li>Choose Google (Gemini) in <C>canvas-cli login</C> and paste it, or:</Li>
      </List>
      <CodeBlock title=".env">{`AI_PROVIDER=google
GOOGLE_API_KEY=...`}</CodeBlock>

      <SectionHeading id="bedrock">AWS Bedrock</SectionHeading>
      <Body>
        For people already on AWS. Bedrock uses IAM credentials instead of an API key, and the Claude models
        must be enabled for your account first.
      </Body>
      <List ordered>
        <Li>
          In the AWS console, open <Term>Amazon Bedrock → Model access</Term> and request the Anthropic models in
          your region.
        </Li>
        <Li>
          Create an IAM user or role allowed to call <C>bedrock:InvokeModel</C>, and access keys for it.
        </Li>
        <Li>
          Choose AWS Bedrock in <C>canvas-cli login</C> and enter the region, keys, and model id, or:
        </Li>
      </List>
      <CodeBlock title=".env">{`AI_PROVIDER=bedrock
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...`}</CodeBlock>
      <Body>
        <C>AWS_SESSION_TOKEN</C> works for temporary credentials, and <C>AWS_BEARER_TOKEN_BEDROCK</C> for bearer
        token authentication. Model ids start with <C>us.anthropic.</C>; use a <C>global.</C>, <C>eu.</C>,{" "}
        <C>jp.</C>, or <C>au.</C> prefix for other regions.
      </Body>

      <SectionHeading id="subscriptions">Subscriptions</SectionHeading>
      <Body>
        canvas-cli can run on a <Term>GitHub Copilot</Term> or <Term>ChatGPT</Term> plan through the vendor&rsquo;s
        own command-line tool. There is no API key: the vendor&rsquo;s CLI holds your login, and usage counts
        against your plan. You install the CLI yourself; canvas-cli finds it on your <C>PATH</C> or in the usual
        global install folders.
      </Body>
      <SubHeading>GitHub Copilot</SubHeading>
      <Body>
        Works with Copilot Free, and with the free Copilot Pro that students get through{" "}
        <A href="https://education.github.com/">GitHub Education</A>.
      </Body>
      <CodeBlock>{`npm install -g @github/copilot
copilot login`}</CodeBlock>
      <Body>
        Then choose GitHub Copilot in <C>canvas-cli login</C>, which checks that the CLI is installed and offers
        to run <C>copilot login</C> for you. The default model, <C>auto</C>, lets Copilot pick; any model id the
        Copilot CLI accepts can be entered as a custom model.
      </Body>
      <SubHeading>ChatGPT via Codex</SubHeading>
      <CodeBlock>{`npm install -g @openai/codex
codex login`}</CodeBlock>
      <Body>
        Then choose ChatGPT via Codex. The model list shows the models your plan offers, read from Codex&rsquo;s
        own model catalog, and the default runs whatever Codex currently uses by default, shown by name in the
        header.
      </Body>
      <Callout kind="warning" title="Experimental">
        <p>
          OpenAI has not published terms that explicitly cover third-party tools using a ChatGPT plan through the
          Codex CLI. This path uses your own local <C>codex login</C>, and usage counts against your plan.
        </p>
      </Callout>
      <SubHeading>How it runs</SubHeading>
      <Body>
        For each request, canvas-cli starts the vendor&rsquo;s CLI in non-interactive mode, in an empty temporary
        folder, with the CLI&rsquo;s own tools for running commands, reading and writing files, and browsing
        turned off. The Canvas tools are offered to it over a local connection that only accepts a secret token
        created for that one request, so every tool still runs inside canvas-cli. Codex runs with a read-only
        sandbox and without saving a session. See <A href="/privacy/#subscriptions">Privacy</A>.
      </Body>
      <Body>A few differences from API keys:</Body>
      <List>
        <Li>Subscription providers are never picked automatically; choose them in the wizard or set <C>AI_PROVIDER</C>.</Li>
        <Li>Copilot streams answers as they are written; Codex shows each message once it is complete.</Li>
        <Li>The 30-step tool budget is not enforced on these providers.</Li>
        <Li>
          Copilot rejects requests over about 400 KB. If you hit that, start fresh with <C>/clear</C> or ask
          about fewer documents at once.
        </Li>
      </List>
      <Callout kind="note" title="Claude Pro and Max">
        <p>
          Using a Claude subscription is deliberately not supported: Anthropic does not allow third-party tools to
          offer claude.ai sign-in without approval. Claude models are available with an Anthropic API key or
          through Bedrock.
        </p>
      </Callout>

      <SectionHeading id="models">Models</SectionHeading>
      <Body>
        The sign-in wizard and <C>/model</C> list the models for each provider, with a <Term>Custom</Term> option
        for any other id. To choose one without the picker, set <C>AI_MODEL</C>:
      </Body>
      <Figure
        src={loginModel}
        alt="The model picker in the login wizard, listing Claude Fable 5.1, Claude Opus 5 (recommended), Claude Sonnet 5, and older Claude models, plus a Custom option."
        caption="Picking an Anthropic model during sign-in."
      />
      <Table
        head={["Provider", "Models"]}
        rows={[
          [
            "Anthropic",
            <>
              <C>claude-fable-5-1</C>, <C>claude-opus-5</C> (default), <C>claude-sonnet-5</C>, <C>claude-fable-5</C>,{" "}
              <C>claude-opus-4-8</C>, <C>claude-opus-4-7</C>, <C>claude-sonnet-4-6</C>, <C>claude-haiku-4-5</C>
            </>,
          ],
          [
            "OpenAI",
            <>
              <C>gpt-5.6</C> (default, Sol), <C>gpt-5.6-terra</C>, <C>gpt-5.6-luna</C>, <C>gpt-6-astra</C> (limited
              access), <C>gpt-5.5</C>, <C>gpt-5.4</C>
            </>,
          ],
          [
            "Google",
            <>
              <C>gemini-3.8-flash</C> (default), <C>gemini-3.1-pro-preview</C>, <C>gemini-3.7-flash</C>,{" "}
              <C>gemini-3.5-flash</C>, <C>gemini-3.5-flash-lite</C>, <C>gemini-2.5-pro</C>
            </>,
          ],
          [
            "AWS Bedrock",
            <>
              The Claude models above with a <C>us.anthropic.</C> prefix; <C>us.anthropic.claude-sonnet-5</C> is the
              default
            </>,
          ],
          ["GitHub Copilot", <><C>auto</C>, or any id the copilot CLI accepts</>],
          ["ChatGPT via Codex", "Codex's default, or any model your plan offers"],
        ]}
      />
      <CodeBlock title=".env">{`AI_MODEL=claude-sonnet-5`}</CodeBlock>
      <Body>
        <C>/model key</C> replaces the stored API key, or AWS credentials for Bedrock, without going through the
        rest of the setup.
      </Body>

      <SectionHeading id="effort">Effort</SectionHeading>
      <Body>
        Most models can think before they answer, and the <Term>effort</Term> level sets how much. Higher effort
        is slower and costs more, and helps most on long documents and tricky comparisons.
      </Body>
      <Table
        head={["Level", "Good for"]}
        rows={[
          [<C key="1">low</C>, "Quick lookups"],
          [<C key="2">medium</C>, "Most questions"],
          [<C key="3">high</C>, "Careful reading and multi-part questions"],
          [<C key="4">xhigh</C>, "Long, multi-step reasoning; newer Claude and GPT models"],
          [<C key="5">max</C>, "No limit on thinking; newer Claude and GPT models"],
        ]}
      />
      <Body>
        Choose it with <C>/model effort</C>, which only offers the levels the current model supports, or set{" "}
        <C>AI_EFFORT</C>. A level the model does not support rounds up to the nearest one it does, or down to its
        highest: <C>xhigh</C> becomes <C>max</C> on Claude Sonnet 4.6 and <C>high</C> on Gemini. Copilot and
        Codex receive the level exactly as you set it.
      </Body>
      <CodeBlock title=".env">{`AI_EFFORT=high`}</CodeBlock>

      <SectionHeading id="detection">Auto-Detection</SectionHeading>
      <Body>
        If <C>AI_PROVIDER</C> is not set and no provider was chosen at sign-in, canvas-cli uses the first API key
        it finds, in this order: <C>ANTHROPIC_API_KEY</C>, <C>OPENAI_API_KEY</C>, <C>GOOGLE_API_KEY</C>. Bedrock,
        Copilot, and Codex are never detected this way.
      </Body>
      <Body>
        <C>AI_PROVIDER</C> accepts a few aliases: <C>gemini</C> for Google; <C>aws-bedrock</C> and{" "}
        <C>amazon-bedrock</C>; <C>github-copilot</C>; and <C>chatgpt</C> or <C>openai-codex</C> for Codex. An
        unrecognized value turns AI off rather than guessing, and so does choosing a provider without its key.
      </Body>
    </DocPage>
  );
}
