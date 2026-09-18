// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  constants,
  copyFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  nightfallDataDirForTestProcess,
  preparePlaywrightDataDir,
} from "./nightfall-test-data-dir.mjs";
import { exitWithOutcome, runOwnedCommand } from "./owned-process.mjs";
import { terminatePlaywrightBackendPool } from "./playwright-backend-pool.mjs";
import { extractPlaywrightCliOptions } from "./playwright-cli-options.mjs";
import { sharedBrowsersPath } from "./playwright-path.mjs";
import { resolvePlaywrightRunMode } from "./playwright-run-mode.mjs";
import { playwrightSandboxError } from "./playwright-sandbox.mjs";

const cliEntrypoint = join(
  process.cwd(),
  "node_modules",
  "@playwright",
  "test",
  "cli.js",
);
const osReleaseMajor = Number.parseInt(os.release().split(".")[0] ?? "0", 10);
const playwrightHostPlatform =
  process.platform === "darwin" &&
  process.arch === "arm64" &&
  osReleaseMajor >= 20
    ? `mac${Math.min(osReleaseMajor - 9, 15)}-arm64`
    : undefined;

/** Returns the backend executable produced in Cargo's active target directory. */
function playwrightBackendExecutable() {
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version=1", "--no-deps"], {
      encoding: "utf8",
    }),
  );
  const executableName =
    process.platform === "win32" ? "nightfall-app.exe" : "nightfall-app";
  return join(metadata.target_directory, "debug", executableName);
}

/** Copies the static test backend into its run root for stable parallel reuse. */
function stagePlaywrightBackend(runRoot) {
  const sourcePath = playwrightBackendExecutable();
  const executableName =
    process.platform === "win32"
      ? "nightfall-playwright-backend.exe"
      : "nightfall-playwright-backend";
  const stagedPath = join(runRoot, executableName);
  copyFileSync(sourcePath, stagedPath, constants.COPYFILE_FICLONE);
  chmodSync(stagedPath, 0o755);
  return stagedPath;
}

const { browser, dataDir, playwrightArgs, rustLog, target } =
  extractPlaywrightCliOptions(process.argv.slice(2));
const sandboxError = playwrightSandboxError(playwrightArgs);
if (sandboxError) {
  process.stderr.write(`${sandboxError}\n`);
  process.exit(1);
}
const { isTestRun, needsBackend } = resolvePlaywrightRunMode(
  playwrightArgs,
  target,
);
const sourceDataDir = needsBackend
  ? await nightfallDataDirForTestProcess(
      process.cwd(),
      dataDir === undefined
        ? process.env
        : { ...process.env, NIGHTFALL_DATA_DIR: dataDir },
    )
  : undefined;
const runRoot = isTestRun
  ? mkdtempSync(join(os.tmpdir(), "nightfall-playwright-pool-"))
  : undefined;
let seedDataDir = sourceDataDir;
let outcome;
try {
  let backendExecutable;
  if (needsBackend) {
    const buildOutcome = await runOwnedCommand(
      "cargo",
      [
        "build",
        "--quiet",
        "-p",
        "nightfall-app",
        "--bin",
        "nightfall-app",
        "--no-default-features",
        "--features",
        "full,beatgrid-detect",
      ],
      { spawnOptions: { stdio: "inherit" } },
    );
    if (buildOutcome.code !== 0 || buildOutcome.signal) {
      outcome = buildOutcome;
    } else {
      backendExecutable = stagePlaywrightBackend(runRoot);
      seedDataDir = preparePlaywrightDataDir(sourceDataDir, runRoot).runDataDir;
    }
  }

  if (!outcome) {
    outcome = await runOwnedCommand(
      process.execPath,
      [cliEntrypoint, ...playwrightArgs],
      {
        spawnOptions: {
          stdio: "inherit",
          env: {
            ...process.env,
            PLAYWRIGHT_BROWSERS_PATH:
              process.env.PLAYWRIGHT_BROWSERS_PATH ?? sharedBrowsersPath,
            NIGHTFALL_TIMELINE_AUDIO_ENABLED:
              process.env.NIGHTFALL_TIMELINE_AUDIO_ENABLED ?? "0",
            ...(browser === undefined
              ? {}
              : { NIGHTFALL_PLAYWRIGHT_BROWSER: browser }),
            ...(rustLog === undefined
              ? {}
              : { NIGHTFALL_PLAYWRIGHT_RUST_LOG: rustLog }),
            ...(runRoot
              ? {
                  NIGHTFALL_PLAYWRIGHT_BACKEND_POOL: "1",
                  NIGHTFALL_PLAYWRIGHT_RUN_ROOT: runRoot,
                  ...(needsBackend
                    ? {
                        NIGHTFALL_DATA_DIR: seedDataDir,
                        NIGHTFALL_PLAYWRIGHT_BACKEND_EXECUTABLE:
                          backendExecutable,
                        NIGHTFALL_PLAYWRIGHT_SEED_DATA_DIR: seedDataDir,
                      }
                    : {}),
                }
              : {}),
            ...(playwrightHostPlatform
              ? { PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: playwrightHostPlatform }
              : {}),
          },
        },
      },
    );
  }
} finally {
  try {
    await terminatePlaywrightBackendPool(runRoot);
  } finally {
    if (runRoot) rmSync(runRoot, { force: true, recursive: true });
  }
}

exitWithOutcome(outcome);
