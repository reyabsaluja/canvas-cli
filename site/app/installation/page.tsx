import DocPage from "@/components/DocPage";
import CodeBlock from "@/components/CodeBlock";
import Tabs from "@/components/Tabs";
import { Callout, Table } from "@/components/blocks";
import { A, Body, C, Li, List, SectionHeading, Term } from "@/components/prose";
import { INSTALL_URL, REPO, metadataFor } from "@/lib/nav";

export const metadata = metadataFor("/installation/");

export default function Installation() {
  return (
    <DocPage href="/installation/">
      <SectionHeading id="requirements">Requirements</SectionHeading>
      <Table
        head={["Install method", "Platforms", "Needs"]}
        rows={[
          [
            "Install script",
            "macOS on Apple Silicon or Intel; Linux on x64 or arm64, glibc or musl (Alpine)",
            "curl or wget",
          ],
          ["npm, bun, or pnpm", "Anything Node.js runs on, including Windows", "Node.js 20.10 or later"],
        ]}
      />
      <Body>
        Either way you also need a Canvas account and a personal access token, and optionally an{" "}
        <A href="/ai-providers/">AI provider</A>. Nothing else is required. <C>/pdf</C> can use a LaTeX
        compiler for nicer output if you have one, and offers to install it the first time.
      </Body>

      <SectionHeading id="script">Install Script</SectionHeading>
      <Body>The recommended way on macOS and Linux. It installs a self-contained binary with no Node.js needed:</Body>
      <CodeBlock>{`curl -fsSL ${INSTALL_URL} | bash`}</CodeBlock>
      <Body>In order, the script:</Body>
      <List ordered>
        <Li>
          Works out your platform. An Intel shell running under Rosetta on Apple Silicon still gets the native
          arm64 build, and Alpine or other musl systems get the musl build.
        </Li>
        <Li>
          Downloads that binary and the release&rsquo;s <C>SHA256SUMS</C> from the latest{" "}
          <A href={`${REPO}/releases`}>GitHub release</A>.
        </Li>
        <Li>Refuses to continue if the checksum does not match.</Li>
        <Li>Runs the new binary once to make sure it starts on your system.</Li>
        <Li>
          Moves it into <C>~/.local/bin/canvas-cli</C>, replacing any older copy in one step.
        </Li>
        <Li>
          Tells you if <C>~/.local/bin</C> is not on your <C>PATH</C>, with the exact line to add for zsh, bash,
          or fish, and warns if another <C>canvas-cli</C> (an npm install, say) would run instead.
        </Li>
      </List>
      <Body>
        The whole script is wrapped in a function, so a download cut off halfway runs nothing. You can{" "}
        <A href={`${REPO}/blob/main/install.sh`}>read it</A> before running it.
      </Body>

      <SectionHeading id="npm">npm and Others</SectionHeading>
      <Body>
        The same program is published to npm as <C>@reyabsaluja/canvas-cli</C>. Use this on Windows, or if you
        already manage command-line tools with a Node package manager.
      </Body>
      <Tabs
        tabs={[
          { label: "npm", content: <CodeBlock>{`npm install -g @reyabsaluja/canvas-cli`}</CodeBlock> },
          { label: "bun", content: <CodeBlock>{`bun add -g @reyabsaluja/canvas-cli`}</CodeBlock> },
          { label: "pnpm", content: <CodeBlock>{`pnpm add -g @reyabsaluja/canvas-cli`}</CodeBlock> },
          {
            label: "npx",
            content: (
              <>
                <CodeBlock>{`npx @reyabsaluja/canvas-cli`}</CodeBlock>
                <p className="font-rounded text-[15px] text-muted">Runs the latest version once, without installing.</p>
              </>
            ),
          },
        ]}
      />

      <SectionHeading id="verify">Verify</SectionHeading>
      <CodeBlock>{`canvas-cli --version`}</CodeBlock>
      <Body>
        This prints the version, for example <C>0.1.0</C>. To check your setup rather than the install, run{" "}
        <C>canvas-cli status</C>, which shows what is configured without contacting Canvas, or{" "}
        <C>/doctor</C> inside the shell, which does.
      </Body>

      <SectionHeading id="update">Update</SectionHeading>
      <Body>
        canvas-cli does not update itself. To get the latest version, run the same command you installed with:
      </Body>
      <Tabs
        tabs={[
          { label: "Install script", content: <CodeBlock>{`curl -fsSL ${INSTALL_URL} | bash`}</CodeBlock> },
          { label: "npm", content: <CodeBlock>{`npm install -g @reyabsaluja/canvas-cli@latest`}</CodeBlock> },
          { label: "bun", content: <CodeBlock>{`bun add -g @reyabsaluja/canvas-cli@latest`}</CodeBlock> },
        ]}
      />
      <Body>
        Your credentials, course caches, and chat history are kept between versions. The{" "}
        <A href="/changelog/">changelog</A> lists what changed.
      </Body>

      <SectionHeading id="options">Script Options</SectionHeading>
      <Body>The script reads a version argument and three environment variables:</Body>
      <Table
        head={["Option", "Effect"]}
        rows={[
          [<C key="a">bash -s -- 0.1.0</C>, "Install a specific version instead of the latest (a leading v is fine)."],
          [<C key="b">CANVAS_CLI_VERSION</C>, "Same as the version argument."],
          [<C key="c">CANVAS_CLI_INSTALL_DIR</C>, <>Install somewhere other than <C>~/.local/bin</C>.</>],
          [<C key="d">CANVAS_CLI_DOWNLOAD_URL</C>, "Fetch the binary and checksums from a mirror instead of GitHub."],
        ]}
      />
      <CodeBlock>{`# A specific version
curl -fsSL ${INSTALL_URL} | bash -s -- 0.1.0

# Into ~/bin instead
curl -fsSL ${INSTALL_URL} | CANVAS_CLI_INSTALL_DIR="$HOME/bin" bash`}</CodeBlock>
      <Body>
        Binaries for every platform are also attached to each{" "}
        <A href={`${REPO}/releases`}>GitHub release</A> if you would rather download one by hand.
      </Body>

      <SectionHeading id="security">How It&rsquo;s Verified</SectionHeading>
      <Body>
        Releases are built by GitHub Actions from a tagged commit. The same run publishes the npm package with{" "}
        <Term>provenance</Term>, which links the package on npm to the exact commit and workflow that built it,
        and attaches the binaries and their SHA-256 sums to the GitHub release. The install script checks the
        download against those sums before it installs anything. If your system has neither{" "}
        <C>sha256sum</C> nor <C>shasum</C>, it warns and skips the check.
      </Body>
      <Body>
        The macOS binaries are ad-hoc signed. Files downloaded with <C>curl</C> are not quarantined, so macOS
        does not show an &ldquo;unidentified developer&rdquo; prompt.
      </Body>

      <SectionHeading id="uninstall">Uninstall</SectionHeading>
      <Body>
        Removing the program leaves your data alone. To remove your credentials, config, and the{" "}
        <C>.canvas-cli</C> folder in the current directory too, clean up first:
      </Body>
      <CodeBlock>{`canvas-cli clean --all`}</CodeBlock>
      <Body>Then remove the program itself:</Body>
      <Tabs
        tabs={[
          { label: "Install script", content: <CodeBlock>{`rm ~/.local/bin/canvas-cli`}</CodeBlock> },
          { label: "npm", content: <CodeBlock>{`npm uninstall -g @reyabsaluja/canvas-cli`}</CodeBlock> },
          { label: "bun", content: <CodeBlock>{`bun remove -g @reyabsaluja/canvas-cli`}</CodeBlock> },
        ]}
      />
      <Callout kind="note">
        <p>
          <C>clean --all</C> only removes the <C>.canvas-cli</C> folder where you run it. If you used canvas-cli in
          several folders, run <C>canvas-cli clean</C> in each, or delete their <C>.canvas-cli</C> folders.
        </p>
      </Callout>

      <SectionHeading id="source">From Source</SectionHeading>
      <Body>
        To run the latest code or contribute, clone the repository. Development uses{" "}
        <A href="https://bun.sh">Bun</A>:
      </Body>
      <CodeBlock>{`git clone ${REPO}.git
cd canvas-cli
bun install
bun run dev            # run from source
bun run check          # typecheck, build, and test
bun run build:binary   # a standalone binary in dist-bin/`}</CodeBlock>
      <Body>
        See <A href={`${REPO}/blob/main/CONTRIBUTING.md`}>CONTRIBUTING.md</A> before opening a pull request.
      </Body>
    </DocPage>
  );
}
