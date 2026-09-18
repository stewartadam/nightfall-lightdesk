// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const [mode, markerPath] = process.argv.slice(2);
const wrapperFixture = fileURLToPath(
  new URL("./owned-process-wrapper.mjs", import.meta.url),
);
const wrapper = spawn(process.execPath, [wrapperFixture, markerPath], {
  detached: process.platform !== "win32",
  env: process.env,
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});

/** Applies the requested leader behavior after its stubborn child is ready. */
function handleChildReady() {
  if (mode === "exit-zero") process.exit(0);
  if (mode === "exit-failure") process.exit(7);
}

wrapper.once("message", handleChildReady);

/** Keeps the command leader alive until the lifecycle runner terminates it. */
function ignoreShutdownSignal() {}

process.on("SIGINT", ignoreShutdownSignal);
process.on("SIGTERM", ignoreShutdownSignal);
