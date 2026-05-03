import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { LoadedWorkspace } from "../ask/types.js";
import type { CourseCache } from "../enrich/cache-loader.js";
import {
  getExtractedFrontPagePath,
  getExtractedSyllabusPath,
} from "../enrich/course-documents.js";
import type { ShellOpenOption } from "./app-types.js";
import { buildLectureIndex } from "./lecture-resources.js";

export interface OpenableResource {
  id: string;
  title: string;
  kind: string;
  targetType: "file" | "url";
  target: string;
  detail?: string;
  searchTerms: string[];
}

export interface OpenResourceContext {
  loaded?: LoadedWorkspace | null;
  cache?: CourseCache | null;
}

export interface OpenResourceResult {
  status: "opened" | "listed" | "missing" | "ambiguous";
  message: string;
  resource?: OpenableResource;
  matches?: OpenableResource[];
}

interface RankedResource {
  resource: OpenableResource;
  score: number;
  matchedTokens: number;
}

type ResourceOpener = (resource: OpenableResource) => Promise<void>;

const OPEN_MISS_SUGGESTION_LIMIT = 5;
const MIN_OPEN_MISS_SUGGESTION_SCORE = 90;
const GENERIC_RESOURCE_TOKENS = new Set([
  "attachment",
  "course",
  "document",
  "downloaded",
  "extract",
  "extracted",
  "file",
  "json",
  "md",
  "page",
  "pdf",
  "ppt",
  "pptx",
  "resource",
  "txt",
  "workspace",
  "zip",
]);

export async function handleOpenResourceQuery(
  query: string,
  context: OpenResourceContext,
  opener: ResourceOpener = openResourceTarget,
  autoResolveAmbiguous: boolean = false
): Promise<OpenResourceResult> {
  const resources = await collectOpenableResources(context);
  if (resources.length === 0) {
    return {
      status: "missing",
      message: "No openable resources are available here yet.",
    };
  }

  const trimmed = query.trim();
  if (!trimmed || trimmed.toLowerCase() === "list") {
    return {
      status: "listed",
      message: formatResourceList(resources),
    };
  }

  let resolved = resolveOpenableResource(trimmed, resources);
  if (resolved.status === "ambiguous" && autoResolveAmbiguous) {
    resolved = { status: "unique", resource: resolved.matches[0]! };
  }
  if (resolved.status === "missing") {
    const suggestions = suggestOpenableResources(
      trimmed,
      resources,
      OPEN_MISS_SUGGESTION_LIMIT
    );
    return {
      status: "missing",
      matches: suggestions.length > 0 ? suggestions : undefined,
      message: formatMissingResourceMessage(trimmed, suggestions),
    };
  }
  if (resolved.status === "ambiguous") {
    return {
      status: "ambiguous",
      matches: resolved.matches,
      message: [
        `Multiple resources matched "${trimmed}".`,
        ...resolved.matches
          .slice(0, 8)
          .map((resource) => `• ${formatResourceSummary(resource)}`),
        "Be more specific or use /open list.",
      ].join("\n"),
    };
  }

  const resource = resolved.resource;
  if (resource.targetType === "file") {
    try {
      const stat = await fs.stat(resource.target);
      if (!stat.isFile()) {
        return {
          status: "missing",
          message: `Matched ${resource.title}, but the local file is no longer available.`,
        };
      }
    } catch {
      return {
        status: "missing",
        message: `Matched ${resource.title}, but the local file is missing.`,
      };
    }
  }

  try {
    await opener(resource);
  } catch (error) {
    return {
      status: "missing",
      message: `Failed to open ${resource.title}: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    };
  }

  return {
    status: "opened",
    resource,
    message: [
      `Opened ${resource.title} (${resource.kind}).`,
      resource.targetType === "file"
        ? displayPath(resource.target)
        : resource.target,
    ].join("\n"),
  };
}

export async function collectOpenableResources(
  context: OpenResourceContext
): Promise<OpenableResource[]> {
  const resources: OpenableResource[] = [];
  const resourcesByTarget = new Map<string, OpenableResource>();
  const preferredLocalTitles = new Set<string>();

  const push = (resource: OpenableResource): void => {
    const key = `${resource.targetType}:${resource.target}`;
    const existing = resourcesByTarget.get(key);
    if (existing) {
      existing.searchTerms = mergeSearchTerms(existing.searchTerms, resource.searchTerms);
      existing.detail = existing.detail ?? resource.detail;
      return;
    }
    resourcesByTarget.set(key, resource);
    resources.push(resource);
    if (resource.targetType === "file" && resource.kind !== "extracted document") {
      preferredLocalTitles.add(normalizeDuplicateTitle(resource.title));
    }
  };

  const loaded = context.loaded ?? null;
  if (loaded) {
    if (loaded.assignmentMd) {
      push(
        createFileResource(
          "workspace-assignment-md",
          "assignment.md",
          "workspace file",
          path.join(loaded.path, "assignment.md"),
          ["assignment", "brief"]
        )
      );
    }
    if (loaded.planMd) {
      push(
        createFileResource(
          "workspace-plan-md",
          "plan.md",
          "workspace file",
          path.join(loaded.path, "plan.md"),
          ["plan", "action plan"]
        )
      );
    }
    if (loaded.notesMd) {
      push(
        createFileResource(
          "workspace-notes-md",
          "notes.md",
          "workspace file",
          path.join(loaded.path, "notes.md"),
          ["notes", "scratch notes"]
        )
      );
    }
    if (loaded.workupJson) {
      push(
        createFileResource(
          "workspace-workup-json",
          "workup.json",
          "workspace file",
          path.join(loaded.path, "workup.json"),
          ["workup", "analysis"]
        )
      );
    }

    for (const attachment of await listWorkspaceFiles(loaded.path, "attachments")) {
      push(
        createFileResource(
          `workspace-attachment:${attachment.relativePath}`,
          attachment.title,
          "workspace attachment",
          attachment.absolutePath,
          [attachment.relativePath]
        )
      );
    }

    for (const attachment of await listWorkspaceFiles(loaded.path, "resources")) {
      push(
        createFileResource(
          `workspace-resource:${attachment.relativePath}`,
          attachment.title,
          "workspace resource",
          attachment.absolutePath,
          [attachment.relativePath]
        )
      );
    }
  }

  const cache = context.cache ?? null;
  const downloadedByFileId = new Map<number, OpenableResource>();
  const downloadedByFilename = new Map<string, OpenableResource>();
  if (cache) {
    for (const attachment of cache.attachments) {
      if (attachment.status !== "downloaded" && attachment.status !== "skipped") {
        continue;
      }
      const resource = createFileResource(
        `course-attachment:${attachment.localPath}`,
        attachment.originalFilename,
        "downloaded attachment",
        path.join(cache.coursePath, attachment.localPath),
        [attachment.reason, attachment.sourceType]
      );
      push(resource);
      if (typeof attachment.canvasFileId === "number") {
        downloadedByFileId.set(attachment.canvasFileId, resource);
      }
      downloadedByFilename.set(
        normalizeDuplicateTitle(attachment.originalFilename),
        resource
      );

      for (const zipEntry of attachment.zipEntries ?? []) {
        const aliases = [
          zipEntry.entryName,
          zipEntry.filename,
          attachment.originalFilename,
          `inside ${attachment.originalFilename}`,
        ];
        push(
          createFileResource(
            `course-attachment:${attachment.localPath}:zip:${zipEntry.entryName}`,
            zipEntry.filename,
            "zip entry",
            path.join(cache.coursePath, zipEntry.localPath),
            aliases
          )
        );
      }
    }

    for (const page of cache.pages) {
      if (!page.htmlUrl) continue;
      push(
        createUrlResource(
          `course-page:${page.pageId}`,
          page.title,
          "page",
          page.htmlUrl,
          [page.pageId]
        )
      );
    }

    for (const module of cache.modules) {
      for (const item of module.items) {
        const url = item.externalUrl ?? item.htmlUrl ?? null;
        if (!url && !item.pageUrl) continue;

        const downloaded =
          (typeof item.contentId === "number" && downloadedByFileId.get(item.contentId)) ??
          downloadedByFilename.get(normalizeDuplicateTitle(item.title)) ??
          null;
        if (downloaded) {
          push({
            ...downloaded,
            id: `module-item-file:${module.id}:${item.id}`,
            searchTerms: mergeSearchTerms(downloaded.searchTerms, [
              item.title,
              module.name,
            ]),
          });
          continue;
        }

        const pageUrl =
          item.pageUrl &&
          cache.pages.find((page) => page.pageId === item.pageUrl)?.htmlUrl;
        const target = url ?? pageUrl;
        if (!target) continue;
        push(
          createUrlResource(
            `module-item:${module.id}:${item.id}`,
            item.title,
            "module item",
            target,
            [module.name, item.type]
          )
        );
      }
    }

    for (const file of cache.files) {
      const downloaded =
        downloadedByFileId.get(file.id) ??
        downloadedByFilename.get(normalizeDuplicateTitle(file.displayName)) ??
        downloadedByFilename.get(normalizeDuplicateTitle(file.filename)) ??
        null;
      if (downloaded) {
        push({
          ...downloaded,
          id: `course-file:${file.id}`,
          searchTerms: mergeSearchTerms(downloaded.searchTerms, [
            file.displayName,
            file.filename,
          ]),
        });
        continue;
      }
      push(
        createUrlResource(
          `course-file:${file.id}`,
          file.displayName,
          "course file",
          file.url,
          [file.filename, file.contentType]
        )
      );
    }

    for (const lecture of buildLectureIndex(cache)) {
      push(lecture);
    }

    const syllabusPath = getExtractedSyllabusPath(cache.coursePath);
    if (await fileExists(syllabusPath)) {
      push(
        createFileResource(
          "course-syllabus",
          "course-syllabus.txt",
          "syllabus extract",
          syllabusPath,
          ["syllabus", "course outline", "schedule"]
        )
      );
    }

    const frontPagePath = getExtractedFrontPagePath(cache.coursePath);
    if (await fileExists(frontPagePath)) {
      push(
        createFileResource(
          "course-front-page",
          "course-front-page.txt",
          "front page extract",
          frontPagePath,
          ["front page", "home page"]
        )
      );
    }
  }

  if (loaded) {
    for (const extracted of loaded.extractedFiles) {
      const extractedTitle = extracted.name.replace(/\.txt$/i, "");
      if (preferredLocalTitles.has(normalizeDuplicateTitle(extractedTitle))) {
        continue;
      }
      push(
        createFileResource(
          `workspace-extracted:${extracted.relativePath}`,
          extracted.name,
          "extracted document",
          path.join(loaded.path, extracted.relativePath),
          [extractedTitle, extracted.relativePath]
        )
      );
    }
  }

  return resources.sort(compareResources);
}

export function buildShellOpenOptions(
  resources: OpenableResource[]
): ShellOpenOption[] {
  const titleCounts = new Map<string, number>();
  for (const resource of resources) {
    const normalized = normalizeDuplicateTitle(resource.title);
    titleCounts.set(normalized, (titleCounts.get(normalized) ?? 0) + 1);
  }

  return resources.map((resource) => {
    const normalized = normalizeDuplicateTitle(resource.title);
    const isDuplicateTitle = (titleCounts.get(normalized) ?? 0) > 1;
    const query = isDuplicateTitle
      ? `${resource.title} ${resource.kind}`
      : resource.title;
    return {
      title: resource.title,
      query,
      detail: resource.kind,
      searchTerms: mergeSearchTerms(resource.searchTerms, [query, resource.kind]),
    };
  });
}

export function searchOpenableResources(
  query: string,
  resources: OpenableResource[],
  limit: number = 8
): OpenableResource[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return resources.slice(0, limit);
  }
  const normalizedQuery = normalizeSearchText(trimmed);
  const queryTokens = tokenize(normalizedQuery);
  if (queryTokens.length === 0) {
    return resources.slice(0, limit);
  }
  return resources
    .map((resource) => rankResource(queryTokens, normalizedQuery, resource))
    .filter((entry) => entry.score > 0)
    .sort(compareRankedResources)
    .slice(0, limit)
    .map((entry) => entry.resource);
}

function suggestOpenableResources(
  query: string,
  resources: OpenableResource[],
  limit: number
): OpenableResource[] {
  const normalizedQuery = normalizeSearchText(query);
  const queryTokens = tokenize(normalizedQuery);
  if (!normalizedQuery || queryTokens.length === 0) {
    return [];
  }

  return resources
    .map((resource) => rankResourceSuggestion(queryTokens, normalizedQuery, resource))
    .filter((entry) => entry.score >= MIN_OPEN_MISS_SUGGESTION_SCORE)
    .sort(compareRankedResources)
    .slice(0, limit)
    .map((entry) => entry.resource);
}

export function resolveOpenableResource(
  query: string,
  resources: OpenableResource[]
):
  | { status: "unique"; resource: OpenableResource }
  | { status: "ambiguous"; matches: OpenableResource[] }
  | { status: "missing" } {
  const normalizedQuery = normalizeSearchText(query);
  const queryTokens = tokenize(normalizedQuery);
  if (!normalizedQuery || queryTokens.length === 0) {
    return { status: "missing" };
  }

  const exact = resources.filter((resource) =>
    resource.searchTerms.some(
      (term) =>
        normalizeSearchText(term) === normalizedQuery ||
        stripKnownExtensions(normalizeSearchText(term)) === normalizedQuery
    )
  );
  if (exact.length === 1) {
    return { status: "unique", resource: exact[0]! };
  }
  if (exact.length > 1) {
    return { status: "ambiguous", matches: exact.sort(compareResources) };
  }

  const ranked = resources
    .map((resource) => rankResource(queryTokens, normalizedQuery, resource))
    .filter((entry) => entry.score > 0)
    .sort(compareRankedResources);
  const top = ranked[0];
  if (!top) {
    return { status: "missing" };
  }

  const closeMatches = ranked.filter(
    (entry) =>
      entry.matchedTokens === top.matchedTokens &&
      entry.score >= top.score - 15
  );
  if (closeMatches.length > 1) {
    return {
      status: "ambiguous",
      matches: closeMatches.map((entry) => entry.resource),
    };
  }

  return { status: "unique", resource: top.resource };
}

export async function openResourceTarget(
  resource: OpenableResource
): Promise<void> {
  const { command, args } = getOpenCommand(resource.target);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export function getOpenCommand(target: string): { command: string; args: string[] } {
  if (process.platform === "darwin") {
    return { command: "open", args: [target] };
  }
  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", target] };
  }
  return { command: "xdg-open", args: [target] };
}

async function listWorkspaceFiles(
  workspacePath: string,
  relativeDir: string
): Promise<Array<{ title: string; relativePath: string; absolutePath: string }>> {
  const root = path.join(workspacePath, relativeDir);
  if (!(await directoryExists(root))) return [];

  const entries: Array<{ title: string; relativePath: string; absolutePath: string }> =
    [];
  await walkDirectory(root, async (absolutePath) => {
    const relativePath = path.relative(workspacePath, absolutePath);
    entries.push({
      title: path.basename(absolutePath),
      relativePath,
      absolutePath,
    });
  });
  return entries;
}

async function walkDirectory(
  directoryPath: string,
  onFile: (absolutePath: string) => Promise<void>
): Promise<void> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      await walkDirectory(absolutePath, onFile);
      continue;
    }
    if (entry.isFile()) {
      await onFile(absolutePath);
    }
  }
}

function createFileResource(
  id: string,
  title: string,
  kind: string,
  filePath: string,
  aliases: string[] = []
): OpenableResource {
  return {
    id,
    title,
    kind,
    targetType: "file",
    target: filePath,
    detail: displayPath(filePath),
    searchTerms: buildSearchTerms(title, kind, aliases),
  };
}

function createUrlResource(
  id: string,
  title: string,
  kind: string,
  url: string,
  aliases: string[] = []
): OpenableResource {
  return {
    id,
    title,
    kind,
    targetType: "url",
    target: url,
    detail: url,
    searchTerms: buildSearchTerms(title, kind, aliases),
  };
}

function buildSearchTerms(
  title: string,
  kind: string,
  aliases: string[]
): string[] {
  const terms = [title, kind, ...aliases.filter(Boolean)];
  const withoutTxt = title.replace(/\.txt$/i, "");
  const withoutExt = withoutTxt.replace(/\.[^.]+$/, "");
  if (withoutTxt !== title) terms.push(withoutTxt);
  if (withoutExt !== withoutTxt) terms.push(withoutExt);
  return [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
}

function mergeSearchTerms(existing: string[], next: string[]): string[] {
  return [...new Set([...existing, ...next.filter(Boolean)])];
}

function rankResource(
  queryTokens: string[],
  normalizedQuery: string,
  resource: OpenableResource
): RankedResource {
  const normalizedTerms = resource.searchTerms.map(normalizeSearchText);
  const tokenSet = new Set(tokenize(normalizedTerms.join(" ")));
  const matchedTokens = queryTokens.filter((token) => tokenSet.has(token)).length;

  let score = 0;
  for (const term of normalizedTerms) {
    if (term === normalizedQuery) {
      score = Math.max(score, 500);
      continue;
    }
    if (stripKnownExtensions(term) === normalizedQuery) {
      score = Math.max(score, 470);
      continue;
    }
    if (term.startsWith(normalizedQuery)) {
      score = Math.max(score, 420);
      continue;
    }
    if (term.includes(normalizedQuery)) {
      score = Math.max(score, 320);
    }
  }

  const hasTextMatch = score > 0 || matchedTokens > 0;
  if (!hasTextMatch) {
    return {
      resource,
      score: 0,
      matchedTokens,
    };
  }

  if (matchedTokens === queryTokens.length) {
    score = Math.max(score, 260 + matchedTokens * 10);
  } else {
    score += matchedTokens * 24;
  }

  score += resourceTypePriority(resource);
  if (normalizedQuery.includes("pdf") && /\.pdf$/i.test(resource.title)) {
    score += 18;
  }
  if (normalizedQuery.includes("page") && resource.kind.includes("page")) {
    score += 12;
  }

  return {
    resource,
    score,
    matchedTokens,
  };
}

function rankResourceSuggestion(
  queryTokens: string[],
  normalizedQuery: string,
  resource: OpenableResource
): RankedResource {
  const normalizedTerms = resource.searchTerms.map(normalizeSearchText);
  const candidateTokens = [
    ...new Set(normalizedTerms.flatMap((term) => tokenize(term))),
  ];
  const strictRank = rankResource(queryTokens, normalizedQuery, resource);
  let score = Math.min(strictRank.score, 260);
  let matchedTokens = strictRank.matchedTokens;
  let matchedSpecificTokens = queryTokens.filter(
    (token) =>
      !GENERIC_RESOURCE_TOKENS.has(token) && candidateTokens.includes(token)
  ).length;

  for (const queryToken of queryTokens) {
    let bestTokenScore = 0;
    let bestTokenSpecific = false;
    for (const candidateToken of candidateTokens) {
      const tokenScore = scoreTokenSimilarity(queryToken, candidateToken);
      if (tokenScore > bestTokenScore) {
        bestTokenScore = tokenScore;
        bestTokenSpecific =
          !GENERIC_RESOURCE_TOKENS.has(queryToken) &&
          !GENERIC_RESOURCE_TOKENS.has(candidateToken);
      }
    }
    if (bestTokenScore >= 45) {
      score += bestTokenScore;
      matchedTokens += 1;
      if (bestTokenSpecific) {
        matchedSpecificTokens += 1;
      }
    }
  }

  for (const term of normalizedTerms) {
    if (!term) continue;
    if (term.includes(normalizedQuery) || normalizedQuery.includes(term)) {
      score += 45;
      break;
    }
    const similarity = stringSimilarity(normalizedQuery, term);
    if (similarity >= 0.7) {
      score += Math.round(similarity * 70);
      break;
    }
  }

  if (matchedSpecificTokens === 0) {
    score = 0;
  }
  if (score > 0) {
    score += resourceTypePriority(resource);
  }
  if (matchedTokens < Math.min(2, queryTokens.length)) {
    score = Math.min(score, 70);
  }

  return {
    resource,
    score,
    matchedTokens,
  };
}

function scoreTokenSimilarity(queryToken: string, candidateToken: string): number {
  if (!queryToken || !candidateToken) return 0;
  if (queryToken === candidateToken) return 100;

  const shorter = queryToken.length <= candidateToken.length ? queryToken : candidateToken;
  const longer = queryToken.length > candidateToken.length ? queryToken : candidateToken;
  if (shorter.length >= 4 && longer.startsWith(shorter)) {
    return 72;
  }
  if (shorter.length >= 4 && longer.includes(shorter)) {
    return 58;
  }

  const similarity = stringSimilarity(queryToken, candidateToken);
  if (similarity >= 0.8) return Math.round(similarity * 85);
  if (Math.min(queryToken.length, candidateToken.length) >= 3 && similarity >= 0.72) {
    return Math.round(similarity * 70);
  }
  return 0;
}

function stringSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const maxLength = Math.max(a.length, b.length);
  if (maxLength === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLength;
}

function levenshteinDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + substitutionCost
      );
    }
    for (let j = 0; j <= b.length; j++) {
      previous[j] = current[j]!;
    }
  }

  return previous[b.length]!;
}

function resourceTypePriority(resource: OpenableResource): number {
  switch (resource.kind) {
    case "downloaded attachment":
    case "workspace attachment":
    case "workspace resource":
      return 30;
    case "zip entry":
      return 28;
    case "workspace file":
      return 24;
    case "page":
    case "module item":
      return 14;
    case "course file":
      return 10;
    case "syllabus extract":
    case "front page extract":
      return 8;
    case "extracted document":
      return 4;
    default:
      return 0;
  }
}

function compareResources(a: OpenableResource, b: OpenableResource): number {
  const priorityDelta = resourceTypePriority(b) - resourceTypePriority(a);
  if (priorityDelta !== 0) return priorityDelta;
  return a.title.localeCompare(b.title);
}

function compareRankedResources(a: RankedResource, b: RankedResource): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.matchedTokens !== a.matchedTokens) {
    return b.matchedTokens - a.matchedTokens;
  }
  return compareResources(a.resource, b.resource);
}

function formatMissingResourceMessage(
  query: string,
  suggestions: OpenableResource[]
): string {
  if (suggestions.length === 0) {
    return `No openable resource matched "${query}".\nUse /open list to browse available resources.`;
  }

  return [
    `No openable resource matched "${query}".`,
    "",
    "Closest resources:",
    ...suggestions.map((resource) => `• ${formatResourceSummary(resource)}`),
    "",
    "Use /open <name> to open one of these, or /open list to browse available resources.",
  ].join("\n");
}

function formatResourceList(resources: OpenableResource[]): string {
  const lines = ["Openable resources", ""];
  for (const resource of resources.slice(0, 24)) {
    lines.push(`• ${formatResourceSummary(resource)}`);
  }
  if (resources.length > 24) {
    lines.push(`• ... ${resources.length - 24} more`);
  }
  lines.push("", "Use /open <name> to open a specific resource.");
  return lines.join("\n");
}

function formatResourceSummary(resource: OpenableResource): string {
  return `${resource.title} — ${resource.kind}${
    resource.detail ? ` (${resource.detail})` : ""
  }`;
}

function displayPath(target: string): string {
  const relative = path.relative(process.cwd(), target);
  return relative && !relative.startsWith("..") ? relative : target;
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  return normalizeSearchText(value)
    .split(/\s+/)
    .filter(Boolean);
}

function stripKnownExtensions(value: string): string {
  return value.replace(/\b(pdf|txt|md|json|docx?|pptx?|zip)\b/g, "").replace(/\s+/g, " ").trim();
}

function normalizeDuplicateTitle(value: string): string {
  return normalizeSearchText(value.replace(/\.txt$/i, ""));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function directoryExists(directoryPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(directoryPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
