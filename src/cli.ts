#!/usr/bin/env node

import { createRequire } from "node:module";
import { Command } from "commander";
import { initDebug, debug } from "./debug.js";
import { ingestCourseCommand } from "./commands/ingest-course.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { statusCommand } from "./commands/status.js";
import { examplesCommand } from "./commands/examples.js";
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
  .description(
    "A terminal interface for Canvas LMS — manage courses, assignments, and content from the command line."
  )
  .version(version, "-V, --version", "output the current version")
  .option("--debug", "Enable verbose debug output to stderr")
  .addHelpText(
    "after",
    `
Examples:
  $ canvas-cli login                  Set up credentials (interactive wizard)
  $ canvas-cli ingest CS101           Download course content for offline use
  $ canvas-cli status                 Verify your configuration
  $ canvas-cli                        Launch the interactive TUI

Run canvas-cli <command> --help for detailed usage of each command.
Run canvas-cli examples for common workflows.`
  );

const SKIP_CREDENTIAL_LOADING = new Set(["login", "logout", "status", "examples"]);

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
  .option(
    "--profile <name>",
    "Named profile for managing multiple Canvas instances (e.g., school, work)"
  )
  .addHelpText(
    "after",
    `
Examples:
  $ canvas-cli login                  Guided setup for Canvas URL, token, and AI provider
  $ canvas-cli login --profile work   Configure a separate profile for a work account`
  )
  .action(loginCommand);

program
  .command("logout")
  .description("Remove stored credentials and configuration")
  .option("--profile <name>", "Profile to remove (defaults to \"default\")")
  .addHelpText(
    "after",
    `
Examples:
  $ canvas-cli logout                 Remove the default profile's credentials
  $ canvas-cli logout --profile work  Remove only the "work" profile`
  )
  .action(logoutCommand);

program
  .command("status")
  .description("Show current configuration and connection status")
  .option("--profile <name>", "Profile to inspect (defaults to active profile)")
  .addHelpText(
    "after",
    `
Examples:
  $ canvas-cli status                 Show active profile, Canvas URL, and token status
  $ canvas-cli status --profile work  Inspect the "work" profile configuration`
  )
  .action(statusCommand);

program
  .command("ingest <course>")
  .description(
    "Ingest course structure and content into a local cache for offline access"
  )
  .option("--refresh", "Force re-download even if a cached version exists")
  .option("--json", "Output a machine-readable JSON summary instead of formatted text")
  .addHelpText(
    "after",
    `
Arguments:
  course        Course code, name, or partial match (e.g., "CS101", "Intro to Bio")

Examples:
  $ canvas-cli ingest CS101           Download modules, pages, and files for CS101
  $ canvas-cli ingest "Intro to"      Match by partial course name
  $ canvas-cli ingest CS101 --refresh Re-download even if already cached
  $ canvas-cli ingest CS101 --json    Output JSON for scripting or piping`
  )
  .action(ingestCourseCommand);

program
  .command("examples")
  .description("Show common workflows and usage patterns")
  .addHelpText(
    "after",
    `
Examples:
  $ canvas-cli examples              Print categorized usage patterns and workflows`
  )
  .action(examplesCommand);

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
