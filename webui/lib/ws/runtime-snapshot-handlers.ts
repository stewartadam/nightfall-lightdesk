// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  applyActiveInstancesSnapshot,
  applyControlsSnapshot,
  applyMetricsSnapshot,
  applyUndoStateSnapshot,
} from "../../state/runtime-snapshots";
import type { WsMessageHandlerRegistry } from "./message-registry";
import type { AnyWsMessage } from "./types";

/** Registers runtime snapshot handlers with no transport or correlation state. */
export function registerRuntimeSnapshotHandlers(
  registry: WsMessageHandlerRegistry<AnyWsMessage>,
): void {
  registry.register("Metrics", (message) => {
    applyMetricsSnapshot(message.data);
  });

  registry.register("ActiveInstances", (message) => {
    applyActiveInstancesSnapshot(message.data);
  });

  registry.register("Controls", (message) => {
    applyControlsSnapshot(message.data);
  });

  registry.register("UndoState", (message) => {
    applyUndoStateSnapshot(message.data);
  });
}
