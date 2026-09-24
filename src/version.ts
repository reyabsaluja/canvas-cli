import { createRequire } from "node:module";

// Standalone binaries (scripts/build-binary.ts) bake the version in at build
// time because there is no package.json beside them to read.
declare const CANVAS_CLI_VERSION: string | undefined;

function readVersion(): string {
  if (typeof CANVAS_CLI_VERSION === "string") return CANVAS_CLI_VERSION;
  try {
    const require = createRequire(import.meta.url);
    const pkg: { version: string } = require("../package.json");
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}

/** The running canvas-cli version, e.g. "0.1.0". */
export const VERSION = readVersion();
