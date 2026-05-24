#!/usr/bin/env node

import { createRequire } from "node:module";
import { Command } from "commander";
import { initDebug, debug } from "./debug.js";
import { ingestCourseCommand } from "./commands/ingest-course.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { statusCommand } from "./commands/status.js";
import { loadStoredCredentialsToEnv } from "./config/load-credentials-to-env.js";
import { CanvasCliError, classifyError } from "./errors.js";

let version = "0.0.0";
try {
  const require = createRequire(import.meta.url);
  const pkg: { version: string } = require("../package.json");
  version = pkg.version;
} catch {}

const program = new Command();

program
  .name("canvas-cli")
  .description("A terminal interface for Canvas LMS")
  .version(version, "-V, --version", "output the current version")
  .option("--debug", "Enable verbose debug output to stderr");

const SKIP_CREDENTIAL_LOADING = new Set(["login", "logout", "status"]);

program.hook("preAction", (_thisCommand, actionCommand) => {
  const opts = program.opts();
  initDebug(Boolean(opts.debug));
  debug("general", `canvas-cli v${version} starting`);
  debug("config", "Node.js " + process.version);

  if (!SKIP_CREDENTIAL_LOADING.has(actionCommand.name())) {
    loadStoredCredentialsToEnv();
  }
});

program
  .command("login")
  .description("Set up Canvas credentials interactively")
  .option("--profile <name>", "Profile name for multiple Canvas instances")
  .action(loginCommand);

program
  .command("logout")
  .description("Remove stored credentials")
  .option("--profile <name>", "Profile to remove")
  .action(logoutCommand);

program
  .command("status")
  .description("Show current configuration and connection status")
  .option("--profile <name>", "Profile to inspect")
  .action(statusCommand);

program
  .command("ingest <course>")
  .description("Ingest course structure and content into a local cache")
  .option("--refresh", "Force re-ingestion even if cache exists")
  .option("--json", "Output machine-readable JSON summary")
  .action(ingestCourseCommand);

program
  .command("tui", { isDefault: true, hidden: true })
  .description("Launch interactive TUI")
  .action(() => {
    debug("general", "launching interactive TUI");
    import("./tui/app.js").then(({ launchApp }) => launchApp());
  });

program.parseAsync().catch((err: unknown) => {
  const classified = err instanceof CanvasCliError ? err : classifyError(err);
  console.error(classified.userMessage);
  process.exit(classified.exitCode);
});
