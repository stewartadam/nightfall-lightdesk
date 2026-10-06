// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { join } from "node:path";

import {
  exitWithOutcome,
  registerOwnedProcess,
  runOwnedCommand,
} from "./owned-process.mjs";

const backendPort = Number.parseInt(process.env.NIGHTFALL_PORT ?? "3030", 10);
const viteEntrypoint = join(
  process.cwd(),
  "node_modules",
  "vite",
  "bin",
  "vite.js",
);
const processRegistry = process.env.NIGHTFALL_PLAYWRIGHT_PROCESS_REGISTRY;
const viteMode = process.env.NIGHTFALL_PLAYWRIGHT_VITE_MODE ?? "dev";
registerOwnedProcess(processRegistry, process.pid, false);

/** Returns the Vite command line for the run's frontend mode. */
function viteArguments() {
  const listen = ["--host", "127.0.0.1", "--port", `${backendPort + 1}`];
  switch (viteMode) {
    case "dev":
      return ["dev", ...listen];
    // The e2e build the wrapper produced, served from its own output directory.
    case "e2e":
      return ["preview", "--mode", "e2e", ...listen];
    // A prebuilt distribution, such as the browser demo artifact.
    case "preview":
      return [
        "preview",
        ...listen,
        "--base",
        process.env.NIGHTFALL_PLAYWRIGHT_VITE_BASE ?? "/demo/app/",
      ];
    default:
      throw new Error(`Unknown NIGHTFALL_PLAYWRIGHT_VITE_MODE: ${viteMode}`);
  }
}

/** Registers the Vite child group and forwards its output through the wrapper. */
function configureViteChild(child) {
  registerOwnedProcess(
    processRegistry,
    child.pid,
    process.platform !== "win32",
  );
  child.stdout?.pipe(process.stdout, { end: false });
  child.stderr?.pipe(process.stderr, { end: false });
}

const outcome = await runOwnedCommand(
  process.execPath,
  [viteEntrypoint, ...viteArguments()],
  {
    onSpawn: configureViteChild,
    spawnOptions: {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  },
);

exitWithOutcome(outcome);
