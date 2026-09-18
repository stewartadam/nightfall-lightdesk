// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { registerLibraryResponseHandlers } from "./library-response-handlers";
import {
  createWsMessageHandlerRegistry,
  type WsMessageHandlerRegistry,
} from "./message-registry";
import { registerRuntimeSnapshotHandlers } from "./runtime-snapshot-handlers";
import { registerSettingsSnapshotHandlers } from "./settings-snapshot-handlers";
import type { AnyWsMessage } from "./types";

/** Creates the bounded first-pass handler registry for main-thread dispatch. */
export function createMainThreadMessageHandlerRegistry(): WsMessageHandlerRegistry<AnyWsMessage> {
  const registry = createWsMessageHandlerRegistry<AnyWsMessage>();
  registerLibraryResponseHandlers(registry);
  registerRuntimeSnapshotHandlers(registry);
  registerSettingsSnapshotHandlers(registry);
  return registry;
}
