// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { fileURLToPath } from "node:url";

import {
  exitWithOutcome,
  registerOwnedProcess,
  runOwnedCommand,
} from "../owned-process.mjs";

const [markerPath] = process.argv.slice(2);
const childFixture = fileURLToPath(
  new URL("./owned-process-child.mjs", import.meta.url),
);
const processRegistry = process.env.NIGHTFALL_PLAYWRIGHT_PROCESS_REGISTRY;
registerOwnedProcess(processRegistry, process.pid, false);

/** Forwards child readiness to the fixture command process. */
function forwardChildReady() {
  process.send?.({ ready: true });
}

/** Registers the detached child group and observes its readiness message. */
function registerChildGroup(child) {
  registerOwnedProcess(
    processRegistry,
    child.pid,
    process.platform !== "win32",
  );
  child.once("message", forwardChildReady);
}

const outcome = await runOwnedCommand(
  process.execPath,
  [childFixture, markerPath, "0"],
  {
    onSpawn: registerChildGroup,
    shutdownGraceMs: 100,
    spawnOptions: {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  },
);

exitWithOutcome(outcome);
