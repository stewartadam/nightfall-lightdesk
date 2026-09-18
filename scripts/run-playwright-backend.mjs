// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  exitWithOutcome,
  registerOwnedProcess,
  runOwnedCommand,
} from "./owned-process.mjs";

const processRegistry = process.env.NIGHTFALL_PLAYWRIGHT_PROCESS_REGISTRY;
registerOwnedProcess(processRegistry, process.pid, false);

/** Registers the backend child group and forwards its output through the wrapper. */
function configureBackendChild(child) {
  registerOwnedProcess(
    processRegistry,
    child.pid,
    process.platform !== "win32",
  );
  child.stdout?.pipe(process.stdout, { end: false });
  child.stderr?.pipe(process.stderr, { end: false });
}

const backendExecutable = process.env.NIGHTFALL_PLAYWRIGHT_BACKEND_EXECUTABLE;
const outcome = await runOwnedCommand(
  backendExecutable ?? "cargo",
  backendExecutable
    ? []
    : ["run", "--quiet", "-p", "nightfall-app", "--bin", "nightfall-app"],
  {
    onSpawn: configureBackendChild,
    spawnOptions: {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  },
);

exitWithOutcome(outcome);
