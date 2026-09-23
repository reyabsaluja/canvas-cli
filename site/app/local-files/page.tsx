import DocPage from "@/components/DocPage";
import CodeBlock from "@/components/CodeBlock";
import { Callout, Table } from "@/components/blocks";
import { A, Body, C, SectionHeading } from "@/components/prose";
import { metadataFor } from "@/lib/nav";

export const metadata = metadataFor("/local-files/");

export default function LocalFiles() {
  return (
    <DocPage href="/local-files/">
      <SectionHeading id="layout">Layout</SectionHeading>
      <Body>
        Everything canvas-cli learns about your courses is written to a <C>.canvas-cli</C> folder in the
        directory you start it from. It is plain JSON, text, and the original files, so you can read, search, or
        back it up with ordinary tools. Nothing in it is needed by anyone else, so keep it out of version
        control.
      </Body>
      <CodeBlock lang="text" copy={false}>{`.canvas-cli/
├── user-courses.json              your course list and short names
├── courses/
│   └── ece216-101/                one folder per ingested course
├── sessions/
│   └── ece216-lab-3-fourier-series-10100/   one folder per workspace
├── chat-sessions/
│   ├── index.json
│   ├── global-home.json
│   ├── course-101.json
│   └── workspace-ece216-lab-3-fourier-series-10100.json
└── exports/                       PDFs made outside a workspace`}</CodeBlock>
      <Body>
        Because the folder belongs to the directory, you can keep separate setups side by side, one folder per
        term for example, each with its own course list and cache.
      </Body>

      <SectionHeading id="courses">courses/</SectionHeading>
      <Body>
        One folder per course, named from its code and Canvas id, written by <A href="/ingestion/">ingestion</A>.
      </Body>
      <Table
        head={["Path", "Contents"]}
        rows={[
          [<C key="1">course.json</C>, "Name, code, term, dates, and the syllabus"],
          [<C key="2">assignments.json</C>, "Every assignment, with dates, rubric, and your feedback"],
          [<C key="3">modules.json</C>, "Modules and their items, in order"],
          [<C key="4">files.json</C>, "The Files tab index"],
          [<C key="5">pages.json</C>, "Every page, including the generated reference pages"],
          [<><C>announcements.json</C>, <C>discussions.json</C></>, "Posts and their replies"],
          [<C key="7">lectures.json</C>, "Discovered lectures: slides, recordings, and embeds"],
          [<C key="8">external-links.json</C>, "Linked outside content and whether it was captured"],
          [<C key="9">syllabus-candidates.json</C>, "Likely syllabus sources, ranked"],
          [<C key="10">attachments.json</C>, "Every file downloaded, skipped, or failed, and why"],
          [<C key="11">ingestion.json</C>, "When it ran and what it counted"],
          [<C key="12">attachments/</C>, "The original files, in folders by where they came from"],
          [<C key="13">extracted/</C>, "Plain text for pages, assignments, posts, links, and every document"],
        ]}
      />
      <Body>
        Files are written atomically, so an interrupted run never leaves a half-written file, and nothing is
        deleted when you ingest again. Content removed from Canvas stays in the cache until you clean it.
      </Body>

      <SectionHeading id="sessions">sessions/</SectionHeading>
      <Body>
        One folder per <A href="/workspaces/">workspace</A>, named from the course code, assignment name, and id.
        It holds the brief (<C>assignment.md</C>), the plan (<C>plan.md</C>), your notes (<C>notes.md</C>, never
        overwritten), the structured workup (<C>workup.json</C>), the text the investigation read, and an empty{" "}
        <C>work/</C> folder for you. <A href="/workspaces/#files">Assignment workspaces</A> lists every file.
      </Body>

      <SectionHeading id="chat-sessions">chat-sessions/</SectionHeading>
      <Body>
        One JSON file per conversation: <C>global-home</C> for the home screen, <C>course-&lt;id&gt;</C> per
        course, and <C>workspace-&lt;folder&gt;</C> per workspace, plus an <C>index.json</C> that{" "}
        <C>/recent</C> reads. Each file holds the messages and a little metadata, such as the last PDF you
        exported, which is what <C>/open it</C> opens. Deleting a file starts that conversation fresh.
      </Body>

      <SectionHeading id="exports">exports/</SectionHeading>
      <Body>
        PDFs from <C>/pdf</C> made outside a workspace, named with the UTC date and time and a short title, such
        as <C>20260923-201500-lab-3-study-guide.pdf</C>, with the Markdown (and LaTeX) source beside each. PDFs
        made inside a workspace go to that workspace&rsquo;s own <C>exports/</C> folder.
      </Body>

      <SectionHeading id="config">Config Directory</SectionHeading>
      <Body>Separate from all of this, your sign-in lives in your home folder:</Body>
      <CodeBlock lang="text" copy={false}>{`~/.config/canvas-cli/
├── config.json                    default profile settings
├── config.summer.json             another profile
└── credentials/                   only when the Keychain is not used
    ├── default.canvas-token
    └── default.anthropic-key`}</CodeBlock>
      <Body>
        See <A href="/configuration/">Profiles and settings</A>. The folder and files are readable only by you.
      </Body>

      <SectionHeading id="cleaning">Cleaning Up</SectionHeading>
      <Table
        head={["Command", "Removes"]}
        rows={[
          [<C key="1">canvas-cli clean</C>, <>The <C>.canvas-cli</C> folder in the current directory</>],
          [<C key="2">canvas-cli clean --all</C>, <>That, plus every profile&rsquo;s sign-in and the config folder</>],
          [<C key="3">canvas-cli logout</C>, "One profile's sign-in, leaving local data alone"],
        ]}
      />
      <Callout kind="note">
        <p>
          To free space without losing your workspaces, delete a course&rsquo;s folder under{" "}
          <C>.canvas-cli/courses/</C>. It is downloaded again the next time you open the course.
        </p>
      </Callout>
    </DocPage>
  );
}
