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
import {
  startPlaywrightSharedVite,
  terminatePlaywrightBackendPool,
} from "./playwright-backend-pool.mjs";
import { extractPlaywrightCliOptions } from "./playwright-cli-options.mjs";
import { sharedBrowsersPath } from "./playwright-path.mjs";
import {
  resolvePlaywrightRunMode,
  resolvePlaywrightViteMode,
} from "./playwright-run-mode.mjs";
import { playwrightSandboxError } from "./playwright-sandbox.mjs";

const cliEntrypoint = join(
  process.cwd(),
  "node_modules",
  "@playwright",
  "test",
  "cli.js",
);
const viteEntrypoint = join(
  process.cwd(),
  "node_modules",
  "vite",
  "bin",
  "vite.js",
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
    process.platform === "win32"
      ? "nightfall-headless.exe"
      : "nightfall-headless";
  return join(metadata.target_directory, "debug", executableName);
}

/** Copies the static test backend into its run root for stable parallel reuse. */
function stagePlaywrightBackend(runRoot, sourcePath) {
  const executableName =
    process.platform === "win32"
      ? "nightfall-playwright-backend.exe"
      : "nightfall-playwright-backend";
  const stagedPath = join(runRoot, executableName);
  copyFileSync(sourcePath, stagedPath, constants.COPYFILE_FICLONE);
  chmodSync(stagedPath, 0o755);
  return stagedPath;
}

/** Builds the e2e bundle the run's shared `vite preview` server serves. */
function buildE2eFrontend() {
  return runOwnedCommand(
    process.execPath,
    [viteEntrypoint, "build", "--mode", "e2e", "--logLevel", "warn"],
    { spawnOptions: { stdio: "inherit" } },
  );
}

/**
 * Rebuilds the dev WASM bridge and browser demo runtime before the frontend
 * starts, since day-to-day dev setup only refreshes the bridge while many
 * specs run against the embedded demo engine. CI restores both packages from
 * its own cached builds, so the step is skipped there.
 */
function buildTestWasm() {
  if (process.env.CI) return Promise.resolve({ code: 0 });
  return runOwnedCommand(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["run", "--silent", "wasm-build:dev"],
    { spawnOptions: { stdio: "inherit" } },
  );
}

const { browser, dataDir, playwrightArgs, rustLog, target, viteMode } =
  extractPlaywrightCliOptions(process.argv.slice(2));
const sandboxError = playwrightSandboxError(playwrightArgs);
if (sandboxError) {
  process.stderr.write(`${sandboxError}\n`);
  process.exit(1);
}
const { isTestRun, needsBackend, targetsEmbeddedDemo } =
  resolvePlaywrightRunMode(playwrightArgs, target);
// The shared server, Playwright and every spec read the resolved mode.
process.env.NIGHTFALL_PLAYWRIGHT_VITE_MODE = resolvePlaywrightViteMode({
  requested: viteMode,
  environment: process.env.NIGHTFALL_PLAYWRIGHT_VITE_MODE,
  targetsEmbeddedDemo,
});
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
  // Each run builds into its own directory, so concurrent runs in one
  // worktree never replace the bundle another run's preview server serves.
  if (runRoot) process.env.NIGHTFALL_E2E_OUT_DIR = join(runRoot, "e2e-build");
  const wasmOutcome = isTestRun ? await buildTestWasm() : undefined;
  if (wasmOutcome && (wasmOutcome.code !== 0 || wasmOutcome.signal)) {
    outcome = wasmOutcome;
  }
  // The e2e bundle builds while Cargo checks the backend.
  const frontendBuild =
    !outcome &&
    isTestRun &&
    process.env.NIGHTFALL_PLAYWRIGHT_VITE_MODE === "e2e"
      ? buildE2eFrontend()
      : undefined;
  let backendExecutable;
  if (!outcome && needsBackend) {
    const preparedBackend = process.env.NIGHTFALL_PLAYWRIGHT_BACKEND_EXECUTABLE;
    const buildOutcome = preparedBackend
      ? { code: 0 }
      : await runOwnedCommand(
          "cargo",
          [
            "build",
            // Test targets align dev-dependency features with the nextest run, so its units are reused.
            "--tests",
            ...(process.env.CI ? ["--timings"] : ["--quiet"]),
            "--bin",
            "nightfall-headless",
          ],
          { spawnOptions: { stdio: "inherit" } },
        );
    if (buildOutcome.code !== 0 || buildOutcome.signal) {
      outcome = buildOutcome;
    } else {
      backendExecutable = stagePlaywrightBackend(
        runRoot,
        preparedBackend ?? playwrightBackendExecutable(),
      );
      seedDataDir = preparePlaywrightDataDir(sourceDataDir, runRoot).runDataDir;
    }
  }

  const frontendOutcome = await frontendBuild;
  if (
    !outcome &&
    frontendOutcome &&
    (frontendOutcome.code !== 0 || frontendOutcome.signal)
  ) {
    outcome = frontendOutcome;
  }

  // One shared server serves every worker: a single e2e build, or one warm
  // dev server where only the first page load compiles the app.
  const sharedViteURL =
    !outcome && runRoot ? await startPlaywrightSharedVite(runRoot) : undefined;

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
                  NIGHTFALL_PLAYWRIGHT_VITE_URL: sharedViteURL,
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
