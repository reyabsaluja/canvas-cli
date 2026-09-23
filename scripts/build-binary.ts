#!/usr/bin/env bun
/**
 * Build standalone canvas-cli executables with `bun build --compile`.
 * These are what install.sh downloads, so users need no Node.js install.
 *
 *   bun run build:binary                        # current platform only
 *   bun run build:binary --all                  # every release target
 *   bun run build:binary --target=linux-x64     # one or more named targets
 *
 * Output: dist-bin/canvas-cli-<target> plus SHA256SUMS.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BunPlugin } from "bun";

const ROOT = path.resolve(import.meta.dir, "..");
const OUT_DIR = path.join(ROOT, "dist-bin");

/** Release targets, named `<os>-<arch>[-musl]` to match install.sh's platform detection. */
export const TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "linux-x64-musl",
  "linux-arm64-musl",
] as const;
type Target = (typeof TARGETS)[number];

/**
 * pdf-parse picks its pdf.js build with a template-literal require, which a
 * bundler cannot follow. The CLI always uses the default version, so pin it.
 */
const pinPdfJsVersion: BunPlugin = {
  name: "pin-pdfjs-version",
  setup(build) {
    build.onLoad({ filter: /pdf-parse[\\/]lib[\\/]pdf-parse\.js$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      const dynamic = "require(`./pdf.js/${options.version}/build/pdf.js`)";
      const version = /version:\s*'(v[\d.]+)'/.exec(source)?.[1];
      if (!source.includes(dynamic) || !version) {
        throw new Error("pdf-parse internals changed; update pin-pdfjs-version in scripts/build-binary.ts");
      }
      return {
        contents: source.replace(dynamic, `require('./pdf.js/${version}/build/pdf.js')`),
        loader: "js",
      };
    });
  },
};

/**
 * pdfkit loads its standard fonts lazily through createRequire, which the
 * bundler leaves as a runtime lookup the executable cannot satisfy. A plain
 * require() of the same `#standard-fonts/*` specifier gets bundled instead.
 */
const bundlePdfkitFonts: BunPlugin = {
  name: "bundle-pdfkit-fonts",
  setup(build) {
    build.onLoad({ filter: /pdfkit[\\/]js[\\/]pdfkit\.node\.mjs$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      const lazyFont = /require\$1\('#standard-fonts\//g;
      if (!lazyFont.test(source)) {
        throw new Error("pdfkit internals changed; update bundle-pdfkit-fonts in scripts/build-binary.ts");
      }
      return { contents: source.replace(lazyFont, "require('#standard-fonts/"), loader: "js" };
    });
  },
};

export const BINARY_PLUGINS = [pinPdfJsVersion, bundlePdfkitFonts];

function hostTarget(): Target {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${os}-${arch}` as Target;
}

function parseTargets(argv: string[]): Target[] {
  if (argv.includes("--all")) return [...TARGETS];
  const named = argv
    .filter((arg) => arg.startsWith("--target="))
    .flatMap((arg) => arg.slice("--target=".length).split(","));
  for (const name of named) {
    if (!(TARGETS as readonly string[]).includes(name)) {
      throw new Error(`Unknown target "${name}". Known: ${TARGETS.join(", ")}`);
    }
  }
  return named.length > 0 ? (named as Target[]) : [hostTarget()];
}

async function buildTarget(target: Target, version: string): Promise<string> {
  const outfile = path.join(OUT_DIR, `canvas-cli-${target}`);
  const result = await Bun.build({
    entrypoints: [path.join(ROOT, "src/cli.ts")],
    compile: { target: `bun-${target}` as Bun.Build.CompileTarget, outfile },
    minify: true,
    sourcemap: "inline",
    define: { CANVAS_CLI_VERSION: JSON.stringify(version) },
    plugins: BINARY_PLUGINS,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`Build failed for ${target}`);
  }
  await removeCompileLeftovers();
  if (target.startsWith("darwin-")) adHocSign(outfile);
  return outfile;
}

/** `--compile` leaves a `.<hash>.bun-build` copy of the runtime (~60 MB) in the working directory. */
async function removeCompileLeftovers(): Promise<void> {
  for (const name of await readdir(process.cwd())) {
    if (name.endsWith(".bun-build")) await rm(path.join(process.cwd(), name), { force: true });
  }
}

/**
 * Bun appends the bundled app after the runtime's signature, leaving macOS
 * builds with an invalid one. Re-sign ad hoc so `codesign -v` passes; this
 * needs macOS, which is why the release workflow builds binaries there.
 */
function adHocSign(file: string): void {
  if (process.platform !== "darwin") {
    console.warn(`warning: ${path.basename(file)} left unsigned (codesign needs macOS)`);
    return;
  }
  execFileSync("codesign", ["--force", "--sign", "-", file], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", file], { stdio: "inherit" });
}

async function main(): Promise<void> {
  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")) as { version: string };
  const targets = parseTargets(process.argv.slice(2));

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const sums: string[] = [];
  for (const target of targets) {
    const outfile = await buildTarget(target, pkg.version);
    const digest = createHash("sha256").update(await readFile(outfile)).digest("hex");
    sums.push(`${digest}  ${path.basename(outfile)}`);
    console.log(`built ${path.relative(ROOT, outfile)}`);
  }
  // The executable embeds its sourcemap; the loose copy bun also writes is not shipped.
  await rm(path.join(OUT_DIR, "cli.js.map"), { force: true });
  await writeFile(path.join(OUT_DIR, "SHA256SUMS"), `${sums.join("\n")}\n`);
}

if (import.meta.main) await main();
