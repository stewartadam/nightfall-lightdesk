#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gdtfEnvironment } from "./gdtf-env.mjs";
import { commandFor } from "./worktree-data-dir.mjs";

const docs = "docs/internal/src/contributing/gdtf-regression-testing.md";

/** Cargo arguments for each ignored GDTF suite. */
const suites = {
  bench: [
    "test",
    "-p",
    "nightfall-fixture-library",
    "--lib",
    "gdtf_bench",
    "--",
    "--ignored",
  ],
  corpus: [
    "test",
    "--release",
    "-p",
    "nightfall-fixture-library",
    "--lib",
    "gdtf_corpus",
    "--",
    "--ignored",
    "--nocapture",
  ],
};

/**
 * Returns why a suite cannot run with the resolved settings, or nothing when it can.
 *
 * Checking up front replaces the Rust tests' bare panics with a message that
 * names the variable to set and the next command to run.
 */
export function missingInput(suite, settings) {
  if (suite === "bench" && !existsSync(settings.NIGHTFALL_GDTF_BENCH_DIR)) {
    return `No GDTF bench archives at ${settings.NIGHTFALL_GDTF_BENCH_DIR}. Run \`pnpm run gdtf:fetch\` first (needs GDTF_SHARE_USER and GDTF_SHARE_PASSWORD), or set NIGHTFALL_GDTF_BENCH_DIR. See ${docs}.`;
  }
  if (suite === "corpus" && !settings.NIGHTFALL_GDTF_CORPUS_DIR) {
    return `Set NIGHTFALL_GDTF_CORPUS_DIR to the GDTF collection directories to check, in the shell or in .env. See ${docs}.`;
  }
  return undefined;
}

/**
 * Runs one GDTF suite through Cargo with settings from the shell and `.env`.
 */
async function main(argv) {
  const [suite, ...extra] = argv;
  if (!suite || !(suite in suites)) {
    throw new Error(
      `usage: run-gdtf-tests.mjs <${Object.keys(suites).join("|")}>`,
    );
  }
  const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const settings = await gdtfEnvironment(projectRoot);
  const problem = missingInput(suite, settings);
  if (problem) throw new Error(problem);

  const child = spawn(commandFor("cargo"), [...suites[suite], ...extra], {
    cwd: projectRoot,
    env: { ...process.env, ...settings },
    stdio: "inherit",
  });
  child.on("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
