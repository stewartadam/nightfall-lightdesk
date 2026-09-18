// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { onCleanup, onMount } from "solid-js";
import { engineRuntime, getWebSocketUrl } from "../../../lib/engine-runtime";
import { getLogger } from "../../../lib/logger";
import { configuredEngineRuntime } from "../../../lib/runtime-config";

const log = getLogger(import.meta.url);

/** Connects the application shell to its configured engine runtime. */
export default function EngineConnection() {
  onMount(() => {
    log.trace("mounting");
    log.debug("Connecting to engine...");
    engineRuntime.start(configuredEngineRuntime(getWebSocketUrl()));
  });

  onCleanup(() => {
    log.trace("unmounting");
    log.debug("Disconnecting from engine...");
    engineRuntime.stop();
  });

  return null; // no UI needed
}
