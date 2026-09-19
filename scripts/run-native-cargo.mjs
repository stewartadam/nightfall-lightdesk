// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { fileURLToPath } from "node:url";
import { exitWithOutcome, runOwnedCommand } from "./owned-process.mjs";

/** Select one static workspace graph for linting, tests, and the browser-test backend. */
export function nativeCargoArgs(command, args = []) {
  return [
    command,
    // Include dev dependencies when building the backend so Cargo uses the test graph.
    ...(command === "build" ? ["--tests"] : []),
    "--workspace",
    "--no-default-features",
    "--features",
    "nightfall-app/full,nightfall-app/beatgrid-detect,nightfall-flow/fx-module",
    ...args,
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (!["build", "clippy", "test"].includes(command)) {
    throw new Error("Expected build, clippy, or test");
  }
  exitWithOutcome(
    await runOwnedCommand("cargo", nativeCargoArgs(command, args), {
      spawnOptions: { stdio: "inherit" },
    }),
  );
}
