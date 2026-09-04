import assert from "node:assert/strict";
import test, { after, afterEach, before } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeCodexModel,
  listCodexModels,
  readCodexModelCache,
  resetCodexModelCacheForTests,
  resolveCodexModel,
} from "../src/ai/backends/codex-models.js";
import { buildCodexArgs } from "../src/ai/backends/codex.js";
import { deriveModelDisplayName, getModelCapabilities } from "../src/ai/model-capabilities.js";
import { formatModelName } from "../src/ai/provider.js";
import { getModelOptions } from "../src/commands/login-providers.js";

/** Trimmed copy of the shape Codex 0.149 writes to `$CODEX_HOME/models_cache.json`. */
const FIXTURE = {
  fetched_at: "2026-09-04T21:29:02.446793Z",
  etag: 'W/"1e10c2927ad7b0d7cddc841252b75cb1"',
  client_version: "0.149.1",
  models: [
    {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      description: "Proven previous-generation model for coding and general work.",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast responses with lighter reasoning" },
        { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
        { effort: "high", description: "Greater reasoning depth for complex problems" },
        { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
      ],
      visibility: "list",
      priority: 12,
      upgrade: null,
      context_window: 400000,
    },
    {
      slug: "gpt-reserve",
      display_name: "GPT-Reserve",
      description: "Fast and affordable agentic coding model.",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low", description: "" },
        { effort: "medium", description: "" },
        { effort: "high", description: "" },
      ],
      visibility: "hide",
      priority: 3,
      upgrade: null,
      context_window: 400000,
    },
    {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      description: "Reliable agentic workhorse for everyday tasks.",
      default_reasoning_level: "low",
      supported_reasoning_levels: [
        { effort: "max", description: "Maximum reasoning depth for the hardest problems" },
        { effort: "low", description: "Fast responses with lighter reasoning" },
        { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
        { effort: "high", description: "Greater reasoning depth for complex problems" },
        { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
        { effort: "ultra", description: "Beyond our scale; must be ignored" },
      ],
      visibility: "list",
      priority: 6,
      upgrade: null,
      context_window: 400000,
    },
  ],
};

let root: string;
let withCache: string;
let emptyHome: string;
let corruptHome: string;
let wrongShapeHome: string;
let savedCodexHome: string | undefined;

function useHome(dir: string): void {
  process.env.CODEX_HOME = dir;
  resetCodexModelCacheForTests();
}

before(() => {
  savedCodexHome = process.env.CODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "canvas-cli-codex-models-"));
  withCache = join(root, "with-cache");
  emptyHome = join(root, "empty");
  corruptHome = join(root, "corrupt");
  wrongShapeHome = join(root, "wrong-shape");
  for (const dir of [withCache, emptyHome, corruptHome, wrongShapeHome]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(withCache, "models_cache.json"), JSON.stringify(FIXTURE));
  writeFileSync(join(corruptHome, "models_cache.json"), "{ not json");
  writeFileSync(join(wrongShapeHome, "models_cache.json"), JSON.stringify({ models: "nope" }));
});

afterEach(() => {
  resetCodexModelCacheForTests();
});

after(() => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  resetCodexModelCacheForTests();
  rmSync(root, { recursive: true, force: true });
});

test("readCodexModelCache reads $CODEX_HOME/models_cache.json and returns null when unusable", () => {
  useHome(withCache);
  const cache = readCodexModelCache();
  assert.ok(cache);
  assert.equal(cache.path, join(withCache, "models_cache.json"));
  assert.equal(cache.fetchedAt, FIXTURE.fetched_at);
  assert.equal(cache.clientVersion, "0.149.1");
  assert.equal(cache.models.length, 3);

  useHome(emptyHome);
  assert.equal(readCodexModelCache(), null, "missing file");
  useHome(corruptHome);
  assert.equal(readCodexModelCache(), null, "corrupt JSON");
  useHome(wrongShapeHome);
  assert.equal(readCodexModelCache(), null, "models is not an array");

  // An explicit env wins over process.env and never throws for a bad path.
  assert.equal(readCodexModelCache({ CODEX_HOME: join(root, "does-not-exist") }), null);
  assert.ok(readCodexModelCache({ CODEX_HOME: withCache }));
});

test("listCodexModels orders visible models by priority, hides hidden ones, and filters effort levels", () => {
  useHome(withCache);
  const models = listCodexModels();
  assert.deepEqual(
    models.map((m) => m.slug),
    ["gpt-5.6-sol", "gpt-5.5"],
    "ascending priority, gpt-reserve hidden"
  );
  const [sol, five] = models;
  assert.equal(sol!.displayName, "GPT 5.6 Sol");
  assert.equal(sol!.description, "Reliable agentic workhorse for everyday tasks.");
  assert.equal(sol!.defaultEffort, "low");
  assert.deepEqual(sol!.effortLevels, ["low", "medium", "high", "xhigh", "max"], "ultra dropped, app order kept");
  assert.equal(five!.displayName, "GPT 5.5");
  assert.deepEqual(five!.effortLevels, ["low", "medium", "high", "xhigh"]);

  useHome(emptyHome);
  assert.deepEqual(listCodexModels(), []);
});

test("resolveCodexModel maps 'default' to the first visible model only when the cache is readable", () => {
  useHome(withCache);
  assert.equal(resolveCodexModel("default"), "gpt-5.6-sol");
  assert.equal(resolveCodexModel("gpt-5.5"), "gpt-5.5");
  assert.equal(resolveCodexModel("something-else"), "something-else");

  useHome(emptyHome);
  assert.equal(resolveCodexModel("default"), "default");
  useHome(corruptHome);
  assert.equal(resolveCodexModel("default"), "default");
});

test("describeCodexModel names stored ids, including 'default'", () => {
  useHome(withCache);
  assert.deepEqual(describeCodexModel("default"), { slug: "gpt-5.6-sol", displayName: "GPT 5.6 Sol", isDefault: true });
  assert.deepEqual(describeCodexModel("gpt-5.5"), { slug: "gpt-5.5", displayName: "GPT 5.5", isDefault: false });
  assert.equal(describeCodexModel("gpt-reserve"), null, "hidden models are not offered");
  assert.equal(describeCodexModel("not-a-model"), null);

  useHome(emptyHome);
  assert.equal(describeCodexModel("default"), null);
  assert.equal(describeCodexModel("gpt-5.5"), null);
});

test("the memo notices a rewritten cache file after a reset", () => {
  useHome(withCache);
  assert.equal(resolveCodexModel("default"), "gpt-5.6-sol");
  const home = join(root, "rewritten");
  mkdirSync(home, { recursive: true });
  const file = join(home, "models_cache.json");
  writeFileSync(file, JSON.stringify(FIXTURE));
  useHome(home);
  assert.equal(resolveCodexModel("default"), "gpt-5.6-sol");
  writeFileSync(file, JSON.stringify({ ...FIXTURE, models: FIXTURE.models.filter((m) => m.slug !== "gpt-5.6-sol") }));
  resetCodexModelCacheForTests();
  assert.equal(resolveCodexModel("default"), "gpt-5.5");
});

test("buildCodexArgs passes the resolved default model as -m only when the cache is readable", () => {
  useHome(withCache);
  const args = buildCodexArgs({ model: "default", cwd: "/tmp/x" });
  assert.ok(args.includes("--ignore-user-config"));
  assert.deepEqual(args.slice(args.indexOf("-m"), args.indexOf("-m") + 2), ["-m", "gpt-5.6-sol"]);

  const explicit = buildCodexArgs({ model: "gpt-5.5", cwd: "/tmp/x" });
  assert.deepEqual(explicit.slice(explicit.indexOf("-m"), explicit.indexOf("-m") + 2), ["-m", "gpt-5.5"]);

  useHome(emptyHome);
  const noCache = buildCodexArgs({ model: "default", cwd: "/tmp/x" });
  assert.ok(!noCache.includes("-m"), "without a cache the default must not pass -m");

  // The env passed in wins over process.env so runCodex resolves against the env it runs with.
  const viaEnv = buildCodexArgs({ model: "default", cwd: "/tmp/x", env: { CODEX_HOME: withCache } });
  assert.deepEqual(viaEnv.slice(viaEnv.indexOf("-m"), viaEnv.indexOf("-m") + 2), ["-m", "gpt-5.6-sol"]);
});

test("display names show the real model behind 'default' and fall back to 'Codex default'", () => {
  useHome(withCache);
  assert.equal(formatModelName("default"), "GPT 5.6 Sol (Codex default)");
  assert.equal(formatModelName("default", "high"), "GPT 5.6 Sol (Codex default) · high");
  assert.equal(deriveModelDisplayName("gpt-5.6-sol"), "GPT 5.6 Sol");

  useHome(emptyHome);
  assert.equal(formatModelName("default"), "Codex default");
  assert.equal(deriveModelDisplayName("default"), "Codex default");
});

test("deriveModelDisplayName uses the cache display_name for a slug the id derivation does not recognise", () => {
  const home = join(root, "odd-slug");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "models_cache.json"),
    JSON.stringify({
      ...FIXTURE,
      models: [
        { ...FIXTURE.models[2], slug: "sol-preview", display_name: "Sol Preview", priority: 1 },
        ...FIXTURE.models,
      ],
    })
  );
  useHome(home);
  assert.equal(deriveModelDisplayName("sol-preview"), "Sol Preview");
  assert.equal(formatModelName("default"), "Sol Preview (Codex default)");
});

test("getModelCapabilities reads Codex effort levels from the cache and falls back when unknown", () => {
  useHome(withCache);
  assert.deepEqual(getModelCapabilities("codex", "gpt-5.5"), { control: "cli", effortLevels: ["low", "medium", "high", "xhigh"] });
  assert.deepEqual(getModelCapabilities("codex", "default"), { control: "cli", effortLevels: ["low", "medium", "high", "xhigh", "max"] });
  assert.deepEqual(getModelCapabilities("codex", "mystery-model").effortLevels, ["low", "medium", "high", "xhigh", "max"]);

  useHome(emptyHome);
  assert.deepEqual(getModelCapabilities("codex", "gpt-5.5").effortLevels, ["low", "medium", "high", "xhigh", "max"]);
});

test("getModelOptions('codex') lists the cache's visible models plus Custom, else the static entry", () => {
  useHome(withCache);
  assert.deepEqual(getModelOptions("codex"), [
    { label: "GPT 5.6 Sol", value: "gpt-5.6-sol", description: "Codex default · Reliable agentic workhorse for everyday tasks." },
    { label: "GPT 5.5", value: "gpt-5.5", description: "Proven previous-generation model for coding and general work." },
    { label: "Custom", value: "__custom__", description: "enter model ID" },
  ]);

  useHome(emptyHome);
  const fallback = getModelOptions("codex");
  assert.deepEqual(fallback.map((o) => o.value), ["default", "__custom__"]);
  assert.equal(fallback[0]!.label, "Codex default");
});
