import { CanvasClient } from "../canvas/client.js";
import { loadConfig } from "../config/env.js";
import { resolveAssignment } from "../domain/resolve-assignment.js";
import { createWorkspace } from "../workspace/create.js";
import { handleError } from "../errors.js";
import chalk from "chalk";
import path from "node:path";

interface DoAssignmentOptions {
  course?: string;
  id?: string;
}

export async function doAssignmentCommand(
  name: string,
  options: DoAssignmentOptions
): Promise<void> {
  const config = loadConfig();
  const client = new CanvasClient(config);

  let rawCourses;
  try {
    rawCourses = await client.getCourses();
  } catch (err) {
    handleError(err);
  }

  let resolved;
  try {
    resolved = await resolveAssignment(name, options, client, rawCourses);
  } catch (err) {
    handleError(err);
  }

  const { detail, course } = resolved;

  let result;
  try {
    result = await createWorkspace(detail, course, config);
  } catch (err) {
    if (err instanceof Error) {
      console.error(`Failed to create workspace: ${err.message}`);
    } else {
      console.error("Failed to create workspace.");
    }
    process.exit(1);
  }

  // Render result
  const relativePath = path.relative(process.cwd(), result.workspacePath);
  console.log("");

  if (result.created) {
    console.log(chalk.bold.green("Workspace ready"));
  } else {
    console.log(chalk.bold.yellow("Workspace updated"));
  }

  console.log("");
  console.log(`  ${chalk.dim("Assignment")}  ${detail.name}`);
  console.log(`  ${chalk.dim("Course    ")}  ${course.name}`);
  console.log(`  ${chalk.dim("Path      ")}  ${relativePath}`);
  console.log("");

  if (result.filesWritten.length > 0) {
    const verb = result.created ? "Created" : "Updated";
    console.log(`${verb}:`);
    for (const f of result.filesWritten) {
      console.log(`  ${chalk.dim("-")} ${f}`);
    }
  }

  if (result.filesSkipped.length > 0) {
    console.log("Preserved:");
    for (const f of result.filesSkipped) {
      console.log(`  ${chalk.dim("-")} ${f} ${chalk.dim("(already exists)")}`);
    }
  }

  // Attachment results
  const { attachments } = result;
  const hasAttachments =
    attachments.downloaded.length > 0 ||
    attachments.skipped.length > 0 ||
    attachments.failed.length > 0;

  if (hasAttachments) {
    console.log("");
    console.log("Attachments:");
    for (const f of attachments.downloaded) {
      console.log(`  ${chalk.dim("-")} ${f} ${chalk.green("downloaded")}`);
    }
    for (const f of attachments.skipped) {
      console.log(`  ${chalk.dim("-")} ${f} ${chalk.dim("(already exists)")}`);
    }
    for (const f of attachments.failed) {
      console.log(`  ${chalk.dim("-")} ${f} ${chalk.red("failed")}`);
    }
  }

  console.log("");
  console.log(chalk.dim("Next:"));
  console.log(chalk.dim(`  - open ${relativePath}/assignment.md to review the brief`));
  if (hasAttachments) {
    console.log(chalk.dim(`  - attachments are in ${relativePath}/attachments/`));
  }
  console.log(chalk.dim(`  - use ${relativePath}/notes.md for scratch notes`));
  console.log(chalk.dim(`  - use ${relativePath}/work/ for your files`));
  console.log("");
}
