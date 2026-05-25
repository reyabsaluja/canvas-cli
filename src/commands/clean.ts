import { existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { getConfigDir } from "../config/paths.js";
import { deleteAllCredentials } from "../config/credentials.js";
import { deleteStoredConfig, listProfiles } from "../config/store.js";
import { C } from "./login-picker.js";

interface CleanOptions {
  all?: boolean;
  yes?: boolean;
}

const LOCAL_DIR = ".canvas-cli";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        total += dirSize(full);
      } else {
        total += statSync(full).size;
      }
    }
  } catch {}
  return total;
}

async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(`  ${message} (y/N) `, (answer) => {
      rl.close();
      res(answer.trim().toLowerCase() === "y");
    });
  });
}

export async function cleanCommand(options: CleanOptions): Promise<void> {
  const localPath = resolve(LOCAL_DIR);
  const localExists = existsSync(localPath);
  const configDir = getConfigDir();
  const configExists = existsSync(configDir);

  if (!localExists && (!options.all || !configExists)) {
    console.log(`\n  ${C.dim("Nothing to clean.")}\n`);
    return;
  }

  console.log("");

  if (localExists) {
    const size = dirSize(localPath);
    console.log(`  ${C.text("Local data:")} ${C.muted(localPath)} ${C.dim(`(${formatBytes(size)})`)}`);
    const subdirs = readdirSync(localPath, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const sub of subdirs) {
      const subSize = dirSize(join(localPath, sub));
      console.log(`    ${C.dim("•")} ${sub}/ ${C.dim(`(${formatBytes(subSize)})`)}`);
    }
  }

  if (options.all && configExists) {
    const profiles = listProfiles();
    console.log(`  ${C.text("Global config:")} ${C.muted(configDir)}`);
    if (profiles.length > 0) {
      console.log(`    ${C.dim("•")} profiles: ${profiles.join(", ")}`);
    }
  }

  console.log("");

  const scope = options.all ? "all local data and global config/credentials" : "local cached data";
  const proceed = options.yes || (await confirm(C.warm(`Remove ${scope}?`)));

  if (!proceed) {
    console.log(`  ${C.dim("Cancelled.")}\n`);
    return;
  }

  if (localExists) {
    rmSync(localPath, { recursive: true, force: true });
    console.log(`  ${C.success("✓")} ${C.text("Removed")} ${C.muted(localPath)}`);
  }

  if (options.all && configExists) {
    const profiles = listProfiles();
    for (const profile of profiles) {
      deleteAllCredentials(profile);
      deleteStoredConfig(profile);
    }
    rmSync(configDir, { recursive: true, force: true });
    console.log(`  ${C.success("✓")} ${C.text("Removed")} ${C.muted(configDir)}`);
  }

  console.log("");
}
