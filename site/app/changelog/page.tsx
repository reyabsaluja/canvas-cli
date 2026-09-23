import DocPage from "@/components/DocPage";
import InlineMarkdown from "@/components/InlineMarkdown";
import { A, Body, Li, List, SectionHeading, SubHeading } from "@/components/prose";
import { readChangelog, releaseId } from "@/lib/changelog";
import { REPO, metadataFor } from "@/lib/nav";

export const metadata = metadataFor("/changelog/");

const groupId = (version: string, title: string) => `${releaseId(version)}-${title.toLowerCase().replace(/\W+/g, "-")}`;

export default function Changelog() {
  const releases = readChangelog();
  // With one release the rail walks its groups; with several, one dot per release.
  const sections =
    releases.length === 1
      ? releases[0].groups.map((g) => ({ id: groupId(releases[0].version, g.title), label: g.title }))
      : releases.map((r) => ({ id: releaseId(r.version), label: r.version }));

  return (
    <DocPage href="/changelog/" sections={sections}>
      <Body>
        Every release, newest first, from <A href={`${REPO}/blob/main/CHANGELOG.md`}>CHANGELOG.md</A>. Each version
        is also a <A href={`${REPO}/releases`}>GitHub release</A> with its binaries.
      </Body>

      {releases.map((release) => (
        <section key={release.version} className="flex flex-col gap-5">
          <SectionHeading id={releaseId(release.version)}>
            {release.version === "Unreleased" ? "Unreleased" : `Version ${release.version}`}
            {release.date && (
              <span className="font-rounded text-[15px] text-subtle ml-3 tracking-normal">{release.date}</span>
            )}
          </SectionHeading>
          {release.intro.map((line) => (
            <Body key={line}>
              <InlineMarkdown text={line} />
            </Body>
          ))}
          {release.groups.map((group) => (
            <div key={group.title} className="flex flex-col gap-3">
              <SubHeading id={groupId(release.version, group.title)}>{group.title}</SubHeading>
              <List>
                {group.items.map((item, i) => (
                  <Li key={i}>
                    <InlineMarkdown text={item} />
                  </Li>
                ))}
              </List>
            </div>
          ))}
        </section>
      ))}
    </DocPage>
  );
}
