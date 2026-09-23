import type { ReactNode } from "react";
import DocPage from "@/components/DocPage";
import { Callout, Table } from "@/components/blocks";
import { A, Body, C, SectionHeading } from "@/components/prose";
import { metadataFor } from "@/lib/nav";

export const metadata = metadataFor("/slash-commands/");

type Row = [command: ReactNode, does: ReactNode, more?: string];

function CommandTable({ rows }: { rows: Row[] }) {
  return (
    <Table
      head={["Command", "What it does", "More"]}
      rows={rows.map(([command, does, more]) => [
        command,
        does,
        more ? (
          <A key="more" href={more}>
            Details
          </A>
        ) : (
          ""
        ),
      ])}
    />
  );
}

export default function SlashCommands() {
  return (
    <DocPage href="/slash-commands/">
      <Body>
        Type <C>/</C> in the shell to see the commands for the current scope as you type; <C>/help</C> lists them
        all. Commands only work in the scopes shown here, and trying one elsewhere tells you where it does
        work. Arguments in angle brackets are yours to fill in.
      </Body>

      <SectionHeading id="everywhere">Everywhere</SectionHeading>
      <CommandTable
        rows={[
          [<C key="1">/help</C>, "List the commands for the current scope"],
          [<C key="2">/clear</C>, "Start this scope's conversation over and reset what the assistant remembers", "/shell/#sessions"],
          [<><C>/copy</C> [<C>all</C> | <C>last &lt;N&gt;</C>]</>, "Copy the last answer, the last N messages, or everything", "/study-tools/#copy"],
          [<><C>/pdf &lt;instructions&gt;</C></>, <>Make a PDF from the conversation. Alias <C>/make-pdf</C></>, "/study-tools/#pdf"],
          [<><C>/open &lt;name&gt;</C></>, "In global scope, jump to a course or workspace; elsewhere, open a file or link", "/study-tools/#open"],
          [<C key="6">/manage-courses</C>, "Add, remove, or rename the courses canvas-cli shows"],
          [<><C>/model</C> [<C>effort</C> | <C>key</C>]</>, "Switch AI provider and model, change effort, or replace the API key", "/ai-providers/#models"],
          [<C key="8">/doctor</C>, "Check your configuration, token, Canvas connection, and AI provider", "/troubleshooting/#doctor"],
          [<C key="9">/login</C>, "Run the sign-in wizard again"],
          [<C key="10">/quit</C>, <>Save and exit. Aliases <C>/exit</C>, <C>/q</C></>],
        ]}
      />
      <Body>
        While the command menu is open, <C>Enter</C> takes the highlighted suggestion. In a course or workspace,
        where <C>/quiz</C> also starts with <C>q</C>, type <C>/quit</C> in full.
      </Body>

      <SectionHeading id="global">Global Scope</SectionHeading>
      <CommandTable
        rows={[
          [<C key="1">/courses</C>, "Pick a course to open", "/shell/#moving"],
          [<C key="2">/recent</C>, "Reopen a recent course or workspace", "/shell/#moving"],
          [<><C>/timeline</C> [<C>week</C> | <C>month</C> | <C>semester</C> | <C>next &lt;N&gt; days</C>] [<C>--all</C>]</>, "Gantt chart of upcoming work across every course", "/study-tools/#timeline"],
          [<><C>/grade</C> [<C>need &lt;target&gt;</C>] [<C>&lt;course&gt;</C>]</>, "Grades for every course, one course's breakdown, or what you need for a target", "/study-tools/#grades"],
          [<C key="5">/announcements</C>, "Browse announcements from every course", "/study-tools/#announcements"],
          [<><C>/thread &lt;id or title&gt;</C></>, "Read a discussion or announcement with its replies", "/study-tools/#announcements"],
        ]}
      />

      <SectionHeading id="course">Course Scope</SectionHeading>
      <CommandTable
        rows={[
          [<C key="1">/assignments</C>, "Pick an assignment to open as a workspace", "/workspaces/"],
          [<C key="2">/files</C>, "List the course's downloaded files", "/study-tools/#browse"],
          [<C key="3">/modules</C>, "List the course's modules", "/study-tools/#browse"],
          [<><C>/lecture &lt;query&gt;</C></>, <>Find and open lecture slides or recordings. Alias <C>/lec</C></>, "/study-tools/#lectures"],
          [<><C>/quiz</C> [<C>&lt;count&gt;</C>] [<C>easy</C> | <C>medium</C> | <C>hard</C>] [<C>flash</C>] [<C>&lt;topic&gt;</C>]</>, "A practice quiz from the course material", "/study-tools/#quiz"],
          [<><C>/timeline</C>, <C>/grade</C>, <C>/announcements</C>, <C>/thread</C></>, "As in global scope, for this course"],
          [<C key="7">/refresh</C>, "Download the course again from Canvas", "/ingestion/#running"],
          [<C key="8">/back</C>, "Return to global scope"],
          [<C key="9">/home</C>, "Return to global scope"],
        ]}
      />

      <SectionHeading id="workspace">Workspace Scope</SectionHeading>
      <CommandTable
        rows={[
          [<C key="1">/overview</C>, "What the assignment is and what is expected", "/workspaces/#views"],
          [<C key="2">/requirements</C>, <>Deliverables and constraints. Alias <C>/reqs</C></>, "/workspaces/#views"],
          [<C key="3">/plan</C>, "The step-by-step action plan", "/workspaces/#views"],
          [<C key="4">/resources</C>, "The documents that matter, and why", "/workspaces/#views"],
          [<C key="5">/evidence</C>, "Which conclusions came from which source, and what is still open", "/workspaces/#views"],
          [<C key="6">/status</C>, "The workspace's folder, freshness, and what was extracted", "/workspaces/#views"],
          [<><C>/lecture</C>, <C>/quiz</C></>, "As in course scope"],
          [<C key="8">/refresh</C>, "Re-download the course and rebuild the workspace", "/workspaces/#refresh"],
          [<C key="9">/back</C>, "Return to the course"],
          [<C key="10">/home</C>, "Return to global scope"],
        ]}
      />
      <Callout kind="tip" title="Beyond slash commands">
        <p>
          In a course or workspace, type <C>@</C> and a file name to attach that file to your next question. See{" "}
          <A href="/shell/#pins">@ Pins</A>.
        </p>
      </Callout>
    </DocPage>
  );
}
