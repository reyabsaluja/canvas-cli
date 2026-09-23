import DocPage from "@/components/DocPage";
import CodeBlock from "@/components/CodeBlock";
import { Callout, Figure } from "@/components/blocks";
import { A, Body, C, Li, List, SectionHeading, SubHeading, Term } from "@/components/prose";
import { REPO, metadataFor } from "@/lib/nav";
import doctor from "@/assets/tui-doctor.png";

export const metadata = metadataFor("/troubleshooting/");

export default function Troubleshooting() {
  return (
    <DocPage href="/troubleshooting/">
      <SectionHeading id="doctor">Run /doctor</SectionHeading>
      <Body>
        Start here. <C>/doctor</C> in the shell checks each piece of your setup in order and suggests a fix for
        anything that fails:
      </Body>
      <List ordered>
        <Li>Whether a Canvas address is configured, and whether it came from the environment or your profile</Li>
        <Li>Whether a token is present</Li>
        <Li>Whether the token looks like a Canvas token, catching stray spaces, quotes, and placeholder text</Li>
        <Li>A live request to Canvas as you, with the response time</Li>
        <Li>Your AI provider and model</Li>
        <Li>
          The provider itself: for API keys, a real request to check the key; for Copilot and Codex, whether the
          CLI is installed and signed in
        </Li>
      </List>
      <Figure src={doctor} alt="The /doctor output: configuration, token, token format, and Canvas API all pass; AI provider is not configured, with a hint to run canvas-cli login." />
      <Body>
        Outside the shell, <C>canvas-cli status</C> shows what is configured without connecting to anything.
      </Body>

      <SectionHeading id="auth">Sign-In Errors</SectionHeading>
      <SubHeading>&ldquo;Invalid access token&rdquo; or 401</SubHeading>
      <List>
        <Li>
          <Term>The token expired.</Term> If you set an expiry date when you made it, it has passed. Make a new one
          under Account → Settings → Approved Integrations and run <C>canvas-cli login</C>.
        </Li>
        <Li>
          <Term>The token was deleted</Term> in Canvas, or your school revoked it. Check that it still appears under
          Approved Integrations.
        </Li>
        <Li>
          <Term>It was pasted with extra characters.</Term> <C>/doctor</C> flags spaces and quotes around it.
        </Li>
      </List>
      <SubHeading>&ldquo;Canvas API not found at this URL&rdquo; or 404</SubHeading>
      <Body>
        The address is not your school&rsquo;s Canvas. Use the address you see in the browser when you are signed
        in, such as <C>school.instructure.com</C> or <C>canvas.school.edu</C>, without any path. If you set{" "}
        <C>CANVAS_BASE_URL</C> yourself, it must end in <C>/api/v1</C>.
      </Body>
      <SubHeading>A redirect, or a sign-in page</SubHeading>
      <Body>
        Some schools put Canvas behind single sign-on. <C>/doctor</C> reports a redirect when that happens; try
        the address your browser lands on after signing in.
      </Body>
      <SubHeading>No &ldquo;New Access Token&rdquo; button</SubHeading>
      <Body>
        Your school has turned off personal tokens for students. canvas-cli cannot work without one; ask your
        Canvas administrators whether they can be enabled.
      </Body>

      <SectionHeading id="network">Network Errors</SectionHeading>
      <List>
        <Li>
          <Term>A VPN may be required.</Term> Many schools only allow Canvas API access from their network.
        </Li>
        <Li>
          <Term>A firewall may be blocking it.</Term> Campus and workplace networks sometimes block API traffic;
          try another network.
        </Li>
        <Li>
          <Term>Check the connection directly</Term>, replacing the address and token with yours:
        </Li>
      </List>
      <CodeBlock>{`curl -H "Authorization: Bearer YOUR_TOKEN" https://school.instructure.com/api/v1/users/self`}</CodeBlock>
      <Body>
        If that returns your name as JSON, Canvas is reachable and the token works, and the problem is in
        canvas-cli&rsquo;s configuration; <C>canvas-cli status</C> shows what it is using. Rate limits and server
        errors are retried automatically a few times before canvas-cli gives up.
      </Body>

      <SectionHeading id="courses">Missing Courses</SectionHeading>
      <List>
        <Li>
          <Term>Only current courses are listed.</Term> canvas-cli shows the courses Canvas marks as current for
          you. Once a term ends, its courses may drop off.
        </Li>
        <Li>
          <Term>Your course list is per folder.</Term> Starting canvas-cli in a new folder asks you to pick courses
          again. Use <C>/manage-courses</C> to add one you skipped.
        </Li>
        <Li>
          <Term>You were just added.</Term> New enrollments can take a few minutes to appear in the API.
        </Li>
        <Li>
          <Term>A course shows as unavailable.</Term> It is in your list but Canvas no longer returns it. Remove it
          with <C>/manage-courses</C>.
        </Li>
      </List>
      <Body>
        If files or pages are missing from a course, your school may block those parts of the API for students;
        see <A href="/ingestion/#blocked">Blocked APIs</A>. Run <C>/refresh</C> in the course after your
        instructor posts something new.
      </Body>

      <SectionHeading id="ai">AI Not Working</SectionHeading>
      <List>
        <Li>
          <Term>&ldquo;AI is unavailable because no provider key is configured&rdquo;.</Term> Run{" "}
          <C>canvas-cli login</C> or <C>/model</C> and choose a provider. Setting a provider without its key also
          leaves AI off.
        </Li>
        <Li>
          <Term>The key is rejected.</Term> Check it has not been revoked, and that the account has credit.{" "}
          <C>/model key</C> replaces it.
        </Li>
        <Li>
          <Term>Rate limited.</Term> Wait a minute and try again, or switch to a model with higher limits.
        </Li>
        <Li>
          <Term>Copilot or Codex.</Term> <C>/doctor</C> checks that the CLI is installed and signed in. Install it
          with <C>npm install -g @github/copilot</C> or <C>npm install -g @openai/codex</C>, then run{" "}
          <C>copilot login</C> or <C>codex login</C>.
        </Li>
        <Li>
          <Term>&ldquo;The request is too large for GitHub Copilot&rdquo;.</Term> Start over with <C>/clear</C>, or
          ask about fewer documents at once.
        </Li>
        <Li>
          <Term>Thin answers.</Term> The assistant only knows what has been downloaded. Run <C>/refresh</C> in the
          course, and ask in a workspace for assignment details.
        </Li>
      </List>

      <SectionHeading id="install">Install Problems</SectionHeading>
      <SubHeading>&ldquo;command not found: canvas-cli&rdquo;</SubHeading>
      <Body>
        The install folder is not on your <C>PATH</C>. For the install script it is <C>~/.local/bin</C>; add it to
        your shell&rsquo;s startup file and open a new terminal:
      </Body>
      <CodeBlock>{`echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc`}</CodeBlock>
      <SubHeading>An old version keeps running</SubHeading>
      <Body>
        You probably have two installs, one from npm and one from the script. <C>which -a canvas-cli</C> lists
        them in the order your shell finds them; remove the one you do not want.
      </Body>
      <SubHeading>&ldquo;canvas-cli requires Node.js 20 or later&rdquo;</SubHeading>
      <Body>
        The npm package needs Node.js 20.10 or newer. Update Node, or use the install script, which needs no
        Node.js at all.
      </Body>
      <SubHeading>Copying does nothing on Linux</SubHeading>
      <Body>
        <C>/copy</C> needs a clipboard tool: install <C>wl-clipboard</C> on Wayland, or <C>xclip</C> or{" "}
        <C>xsel</C> on X11.
      </Body>

      <SectionHeading id="reset">Starting Over</SectionHeading>
      <List>
        <Li>
          <C>/clear</C> resets the conversation in the current scope.
        </Li>
        <Li>
          <C>/refresh</C> re-downloads a course, or rebuilds a workspace.
        </Li>
        <Li>
          <C>canvas-cli login</C> replaces your sign-in; <C>canvas-cli logout</C> removes it.
        </Li>
        <Li>
          <C>canvas-cli clean</C> deletes the local cache in this folder, and <C>clean --all</C> your sign-in too.
        </Li>
      </List>
      <Callout kind="tip" title="Still stuck?">
        <p>
          Run the failing command with <C>--debug</C> (secrets are masked) and{" "}
          <A href={`${REPO}/issues`}>open an issue</A> with the output and your version from{" "}
          <C>canvas-cli --version</C>.
        </p>
      </Callout>
    </DocPage>
  );
}
