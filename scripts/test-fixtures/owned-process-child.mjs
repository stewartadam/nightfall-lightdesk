// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { writeFileSync } from "node:fs";
import { createServer } from "node:net";

const [markerPath, processGroupId] = process.argv.slice(2);
const server = createServer();
const recordedProcessGroupId = Number(processGroupId) || process.pid;

/** Records the fixture listener and notifies its parent that startup completed. */
function handleServerListening() {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve fixture listener port");
  }
  writeFileSync(
    markerPath,
    JSON.stringify({
      pid: process.pid,
      port: address.port,
      processGroupId: recordedProcessGroupId,
    }),
    "utf8",
  );
  process.send?.({ ready: true });
}

server.listen(0, "127.0.0.1", handleServerListening);

/** Keeps the fixture alive so forced process-group shutdown can be verified. */
function ignoreShutdownSignal() {}

process.on("SIGINT", ignoreShutdownSignal);
process.on("SIGTERM", ignoreShutdownSignal);
setInterval(() => {}, 1_000);
