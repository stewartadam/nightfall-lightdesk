#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { constants } from "node:fs";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { nightfallTestDataDir } from "./nightfall-test-data-dir.mjs";
import {
  readEnvMap,
  resolveEnvPath,
  resolveMainWorktree,
  resolvePersistentNightfallDataDir,
} from "./worktree-data-dir.mjs";

/**
 * Returns whether a filesystem path exists.
 */
async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * Returns whether a directory exists and contains at least one entry.
 */
async function directoryHasEntries(path) {
  if (!(await pathExists(path))) {
    return false;
  }

  const pathStat = await stat(path);
  if (!pathStat.isDirectory()) {
    throw new Error(`${path} exists but is not a directory`);
  }

  const entries = await readdir(path);
  return entries.length > 0;
}

/**
 * Returns the worktree-local Nightfall data directory from .env.
 */
async function resolveTargetDataDir(projectRoot) {
  const worktreeEnv = await readEnvMap(join(projectRoot, ".env"));
  const configuredDataDir = worktreeEnv.NIGHTFALL_DATA_DIR?.trim();
  if (!configuredDataDir) {
    return "";
  }
  return resolveEnvPath(configuredDataDir, projectRoot);
}

/**
 * Returns whether an entry from the source data directory should be seeded.
 */
export function shouldCopySeedDataDirEntry(sourceDataDir, sourcePath) {
  const backupDir = resolve(sourceDataDir, "backups");
  const entryPath = resolve(sourcePath);
  return entryPath !== backupDir && !entryPath.startsWith(`${backupDir}${sep}`);
}

/**
 * Seeds a target data directory and optionally replaces its existing contents.
 *
 * The replacement is staged beside the target so a copy failure leaves the
 * existing directory untouched.
 */
export async function seedDataDirectory(
  sourceDataDir,
  targetDataDir,
  { force = false } = {},
) {
  const targetHasEntries = await directoryHasEntries(targetDataDir);
  if (targetHasEntries && !force) {
    return false;
  }

  const copyOptions = {
    recursive: true,
    force: false,
    errorOnExist: false,
    mode: constants.COPYFILE_FICLONE,
    filter: (sourcePath) =>
      shouldCopySeedDataDirEntry(sourceDataDir, sourcePath),
  };

  if (!targetHasEntries) {
    await mkdir(dirname(targetDataDir), { recursive: true });
    await cp(sourceDataDir, targetDataDir, copyOptions);
    return true;
  }

  const stagingRoot = await mkdtemp(
    join(dirname(targetDataDir), ".nightfall-data-seed-"),
  );
  const stagedDataDir = join(stagingRoot, "data");
  try {
    await cp(sourceDataDir, stagedDataDir, copyOptions);
    await rm(targetDataDir, { recursive: true, force: true });
    await rename(stagedDataDir, targetDataDir);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
  return true;
}

/** Restricts forced replacement to the sandbox generated for this worktree. */
export function assertSafeReplacementTarget(projectRoot, targetDataDir) {
  const resolvedTarget = resolve(targetDataDir);
  const expectedTarget = resolve(nightfallTestDataDir(projectRoot));
  if (resolvedTarget !== expectedTarget) {
    throw new Error(
      `Refusing to replace Nightfall data outside the worktree sandbox ${expectedTarget}: ${resolvedTarget}`,
    );
  }
}

/** Parses seed behavior and an optional target worktree from CLI arguments. */
export function parseCliOptions(args) {
  let force = false;
  let projectRoot;
  for (const arg of args) {
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg.startsWith("--project-root=")) {
      const value = arg.slice("--project-root=".length).trim();
      if (!value) {
        throw new Error("--project-root requires a path");
      }
      projectRoot = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { force, projectRoot };
}

/** Skips unavailable input normally but rejects it during forced re-seeding. */
function skipUnavailableSeed(force, level, message) {
  if (force) {
    throw new Error(message);
  }
  process.stdout.write(`${level}: ${message}\n`);
}

/**
 * Copies the persistent Nightfall data directory into a secondary worktree.
 */
async function main({ force = false, projectRoot: targetProjectRoot } = {}) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = targetProjectRoot
    ? resolve(targetProjectRoot)
    : dirname(scriptDir);
  const mainWorktree = await resolveMainWorktree(projectRoot);

  if (!mainWorktree) {
    skipUnavailableSeed(
      force,
      "WARN",
      "Could not resolve main worktree; skipping data dir seed",
    );
    return;
  }
  if (mainWorktree === projectRoot) {
    skipUnavailableSeed(
      force,
      "INFO",
      "Running in main worktree; skipping data dir seed",
    );
    return;
  }

  const targetDataDir = await resolveTargetDataDir(projectRoot);
  if (!targetDataDir) {
    skipUnavailableSeed(
      force,
      "INFO",
      "Worktree .env has no NIGHTFALL_DATA_DIR; skipping data dir seed",
    );
    return;
  }

  const sourceDataDir = await resolvePersistentNightfallDataDir(mainWorktree);
  if (resolve(sourceDataDir) === resolve(targetDataDir)) {
    skipUnavailableSeed(
      force,
      "INFO",
      `Source and target data dirs are both ${targetDataDir}; skipping seed`,
    );
    return;
  }
  if (!(await pathExists(sourceDataDir))) {
    skipUnavailableSeed(
      force,
      "INFO",
      `No source Nightfall data dir at ${sourceDataDir}; skipping seed`,
    );
    return;
  }
  if (!force && (await directoryHasEntries(targetDataDir))) {
    process.stdout.write(
      `INFO: Nightfall data dir already exists at ${targetDataDir}; skipping seed\n`,
    );
    return;
  }

  if (force) {
    assertSafeReplacementTarget(projectRoot, targetDataDir);
  }
  await seedDataDirectory(sourceDataDir, targetDataDir, { force });
  process.stdout.write(
    `OK: ${force ? "Re-seeded" : "Seeded"} Nightfall data dir from ${sourceDataDir} to ${targetDataDir}\n`,
  );
}

/**
 * Returns whether this module was invoked directly by Node.
 */
function isDirectInvocation(moduleUrl, argvPath) {
  return (
    Boolean(argvPath) && pathToFileURL(resolve(argvPath)).href === moduleUrl
  );
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  main(parseCliOptions(process.argv.slice(2))).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`WARN: ${message}\n`);
    process.exit(1);
  });
}
