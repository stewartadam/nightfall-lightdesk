// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  readShowfileJsonSync,
  resolveShowfileSnapshotPath,
} from "./showfile-storage.mjs";

import {
  defaultNightfallDataDir,
  readEnvMap,
  resolveEnvPath,
} from "./worktree-data-dir.mjs";

const SANDBOX_ROOT_DIR = join(tmpdir(), "nightfall-test-data");
const PLAYWRIGHT_SEED_ENTRIES = new Set([
  "default.nightfall-show",
  "fixtures",
  "fx-modules",
  "objects",
  "sample.nightfall-show",
]);
const PLAYWRIGHT_SEED_SHOWFILES = [
  "default.nightfall-show",
  "sample.nightfall-show",
];
/**
 * Repository showfile saved as every E2E seed showfile when the source data root lacks them.
 * It already keeps physical transports off, so it is used as is.
 */
const REPOSITORY_SEED_SHOWFILE = fileURLToPath(
  new URL(
    "../crates/app-runtime/tests/data/procedural-showfile-parse-data.json",
    import.meta.url,
  ),
);

/**
 * Returns a filesystem-safe label for one path segment.
 */
function sanitizePathSegment(value) {
  return value.replace(/[^a-z0-9._-]+/giu, "-").replace(/^-+|-+$/gu, "");
}

/**
 * Returns a short stable hash for a worktree path.
 */
function shortPathHash(path) {
  return createHash("sha256").update(path).digest("hex").slice(0, 10);
}

/**
 * Returns the default sandbox data root for a worktree.
 */
export function nightfallTestDataDir(worktreePath = process.cwd()) {
  const resolvedPath = resolve(worktreePath);
  const slug = sanitizePathSegment(basename(resolvedPath)) || "worktree";
  return join(SANDBOX_ROOT_DIR, `${slug}-${shortPathHash(resolvedPath)}`);
}

/**
 * Returns the Nightfall data root for test processes, preferring an exported
 * override before worktree dotenv configuration and the platform data root.
 */
export async function nightfallDataDirForTestProcess(
  worktreePath = process.cwd(),
  env = process.env,
) {
  const worktreeEnv = await readEnvMap(join(worktreePath, ".env"));
  const configuredDataDir =
    env.NIGHTFALL_DATA_DIR?.trim() || worktreeEnv.NIGHTFALL_DATA_DIR?.trim();
  if (configuredDataDir) {
    return resolveEnvPath(configuredDataDir, worktreePath);
  }
  return defaultNightfallDataDir(env);
}

/** Disables physical transports when one copied seed showfile still enables them. */
export function disablePlaywrightShowfileTransports(showfilePath) {
  showfilePath = resolveShowfileSnapshotPath(showfilePath);
  if (!existsSync(showfilePath)) return false;
  const showfile = JSON.parse(readShowfileJsonSync(showfilePath));
  if (!showfile.settings || typeof showfile.settings !== "object") return false;
  if (
    showfile.settings.network_output_enabled === false &&
    showfile.settings.network_input_enabled === false &&
    showfile.settings.usb_output_enabled === false
  ) {
    return false;
  }
  showfile.settings.network_output_enabled = false;
  showfile.settings.network_input_enabled = false;
  showfile.settings.usb_output_enabled = false;
  const json = `${JSON.stringify(showfile, null, 2)}\n`;
  writeFileSync(
    showfilePath,
    showfilePath.endsWith(".gz") ? gzipSync(json) : json,
  );
  return true;
}

/**
 * Returns whether a source root contains the saved showfiles required by E2E.
 */
export function playwrightSeedDataAvailable(sourceDataDir) {
  return PLAYWRIGHT_SEED_SHOWFILES.every(
    (entry) =>
      statSync(
        resolveShowfileSnapshotPath(
          join(sourceDataDir, entry, "showfile.json"),
        ),
        {
          throwIfNoEntry: false,
        },
      )?.isFile() ?? false,
  );
}

/**
 * Saves the repository seed showfile under every E2E seed showfile name in `dataDir`.
 */
function writeRepositorySeedShowfiles(dataDir) {
  for (const showfileName of PLAYWRIGHT_SEED_SHOWFILES) {
    const showfileDir = join(dataDir, showfileName);
    mkdirSync(showfileDir, { recursive: true });
    copyFileSync(REPOSITORY_SEED_SHOWFILE, join(showfileDir, "showfile.json"));
  }
}

/**
 * Copies stable E2E data into a disposable root, optionally sanitizing showfiles.
 * With `repositoryFallback`, a source without the seed showfiles gets the repository's
 * seed showfile instead, so the backend still starts with saved shows and no world loaded.
 */
function copyPlaywrightDataDir(
  sourceDataDir,
  temporaryRoot,
  { sanitizeShowfiles, repositoryFallback },
) {
  const runDataDir = mkdtempSync(join(temporaryRoot, "nightfall-playwright-"));
  const sourceSeedAvailable = playwrightSeedDataAvailable(sourceDataDir);
  const seedDataAvailable = sourceSeedAvailable || repositoryFallback;
  try {
    if (sourceSeedAvailable) {
      cpSync(sourceDataDir, runDataDir, {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
        filter(sourcePath) {
          const relativePath = relative(sourceDataDir, sourcePath);
          if (!relativePath) return true;
          const [topLevelEntry] = relativePath.split(/[\\/]/u);
          return PLAYWRIGHT_SEED_ENTRIES.has(topLevelEntry);
        },
      });
      if (sanitizeShowfiles) {
        for (const showfileName of PLAYWRIGHT_SEED_SHOWFILES) {
          disablePlaywrightShowfileTransports(
            join(runDataDir, showfileName, "showfile.json"),
          );
        }
      }
    } else if (repositoryFallback) {
      const skippedEntries = [...PLAYWRIGHT_SEED_ENTRIES].filter((entry) =>
        existsSync(join(sourceDataDir, entry)),
      );
      if (skippedEntries.length > 0) {
        console.warn(
          `${sourceDataDir} lacks a saved ${PLAYWRIGHT_SEED_SHOWFILES.join(" or ")} showfile, so Playwright seeds only the repository showfile and skips its ${skippedEntries.join(", ")}.`,
        );
      }
      writeRepositorySeedShowfiles(runDataDir);
    }
    return { runDataDir, seedDataAvailable };
  } catch (error) {
    rmSync(runDataDir, { force: true, recursive: true });
    throw error;
  }
}

/**
 * Creates one run-scoped stable E2E seed with physical transports disabled.
 * Incomplete sources are replaced by the repository's seed showfile, matching CI.
 */
export function preparePlaywrightDataDir(
  sourceDataDir,
  temporaryRoot = tmpdir(),
) {
  return copyPlaywrightDataDir(sourceDataDir, temporaryRoot, {
    sanitizeShowfiles: true,
    repositoryFallback: true,
  });
}

/**
 * Creates one test-scoped clone from an already-sanitized run seed.
 * Incomplete seeds produce an empty root for backend sample-data bootstrap.
 */
export function clonePlaywrightDataDir(
  sourceDataDir,
  temporaryRoot = tmpdir(),
) {
  return copyPlaywrightDataDir(sourceDataDir, temporaryRoot, {
    sanitizeShowfiles: false,
    repositoryFallback: false,
  });
}
