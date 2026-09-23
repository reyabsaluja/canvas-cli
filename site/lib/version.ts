import { readFileSync } from "node:fs";
import path from "node:path";

/** canvas-cli's version, read from the CLI's package.json at build time. */
export const VERSION: string = JSON.parse(
  readFileSync(path.join(process.cwd(), "..", "package.json"), "utf8")
).version;
