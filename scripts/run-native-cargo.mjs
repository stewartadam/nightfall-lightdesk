// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { fileURLToPath } from "node:url";
import { exitWithOutcome, runOwnedCommand } from "./owned-process.mjs";

/**
 * Select one runtime workspace graph, using every crate's default features, for
 * linting, tests, and the browser-test backend.
 * `nextest` expands to `cargo nextest run`; `test` remains for doctests, which nextest cannot run.
 */
export function nativeCargoArgs(command, args = []) {
  return [
    ...(command === "nextest" ? ["nextest", "run"] : [command]),
    // Select test targets so the backend build and nextest share one unit graph with dev
    // dependencies. Examples are compiled only by Clippy, since no test executes them.
    ...(command === "build" || command === "nextest" ? ["--tests"] : []),
    "--workspace",
    "--exclude",
    "app-tauri",
    ...args,
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (!["build", "clippy", "nextest", "test"].includes(command)) {
    throw new Error("Expected build, clippy, nextest, or test");
  }
  exitWithOutcome(
    await runOwnedCommand("cargo", nativeCargoArgs(command, args), {
      spawnOptions: { stdio: "inherit" },
    }),
  );
}
