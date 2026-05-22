#!/usr/bin/env node

import { createRequire } from "node:module";
import { Command } from "commander";
import { initDebug, debug } from "./debug.js";
import { coursesCommand } from "./commands/courses.js";
import { assignmentsCommand } from "./commands/assignments.js";
import { showAssignmentCommand } from "./commands/show-assignment.js";
import { doAssignmentCommand } from "./commands/do-assignment.js";
import { ingestCourseCommand } from "./commands/ingest-course.js";
import { workCommand } from "./commands/work.js";
import { askCommand } from "./commands/ask.js";

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

program.hook("preAction", () => {
  const opts = program.opts();
  initDebug(Boolean(opts.debug));
  debug("general", `canvas-cli v${version} starting`);
  debug("config", "Node.js " + process.version);
});

program
  .command("courses")
  .description("List your Canvas courses")
  .option("--all", "Include past/inactive courses")
  .option("--json", "Output as JSON")
  .action(coursesCommand);

program
  .command("assignments")
  .description("List upcoming assignments")
  .option("--course <query>", "Filter to a specific course")
  .option("--all", "Show all assignments including old/submitted")
  .option("--include-submitted", "Include submitted assignments")
  .option("--include-no-due-date", "Include assignments with no due date")
  .option("--json", "Output as JSON")
  .action(assignmentsCommand);

const show = program
  .command("show")
  .description("Show details for a resource");

show
  .command("assignment <name>")
  .description("Show detailed info for an assignment")
  .option("--course <query>", "Scope to a specific course")
  .option("--id <assignmentId>", "Look up by Canvas assignment ID")
  .option("--json", "Output as JSON")
  .option("--smart", "Include AI-generated real assignment overview")
  .action(showAssignmentCommand);

program
  .command("do <assignment>")
  .description("Create a local workspace for an assignment")
  .option("--course <query>", "Scope to a specific course")
  .option("--id <assignmentId>", "Look up by Canvas assignment ID")
  .action(doAssignmentCommand);

program
  .command("ingest <course>")
  .description("Ingest course structure and content into a local cache")
  .option("--refresh", "Force re-ingestion even if cache exists")
  .option("--json", "Output machine-readable JSON summary")
  .action(ingestCourseCommand);

program
  .command("work <assignment>")
  .description("Create a rich AI-powered workspace for an assignment")
  .option("--course <query>", "Scope to a specific course")
  .option("--id <assignmentId>", "Look up by Canvas assignment ID")
  .action(workCommand);

program
  .command("ask <question>")
  .description("Ask a question about the current assignment workspace")
  .option("--workspace <path>", "Path to a specific workspace")
  .option("--json", "Output as JSON")
  .option("--debug", "Show retrieval debug info")
  .action(askCommand);

// Default: launch interactive TUI when no subcommand is given
// Check if any subcommand was provided
const args = process.argv.slice(2);
const subcommands = [
  "courses",
  "assignments",
  "show",
  "do",
  "ingest",
  "work",
  "ask",
  "help",
  "--help",
  "-h",
  "--version",
  "-V",
];

const hasSubcommand = args.length > 0 && subcommands.some(
  (cmd) => args[0] === cmd
);

const isDebugOnly = args.every((a) => a === "--debug");

if ((!hasSubcommand && args.length === 0) || isDebugOnly) {
  if (isDebugOnly) initDebug(true);
  import("./tui/app.js").then(({ launchApp }) => launchApp());
} else {
  program.parse();
}
