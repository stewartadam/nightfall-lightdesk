// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  exitWithOutcome,
  runOwnedCommand,
  terminateRegisteredProcesses,
} from "../owned-process.mjs";

const [mode, markerPath, cleanupPath] = process.argv.slice(2);
const commandFixture = fileURLToPath(
  new URL("./owned-process-command.mjs", import.meta.url),
);
const processRegistry = `${cleanupPath}.jsonl`;

let outcome;
try {
  outcome = await runOwnedCommand(
    process.execPath,
    [commandFixture, mode, markerPath],
    {
      shutdownGraceMs: 100,
      spawnOptions: {
        env: {
          ...process.env,
          NIGHTFALL_PLAYWRIGHT_PROCESS_REGISTRY: processRegistry,
        },
        stdio: "ignore",
      },
    },
  );
} finally {
  try {
    await terminateRegisteredProcesses(processRegistry, 100);
  } finally {
    rmSync(cleanupPath, { force: true, recursive: true });
    rmSync(processRegistry, { force: true });
  }
}

exitWithOutcome(outcome);
