// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { registerBoardHandlers } from "./board-handlers";
import { registerClipHandlers } from "./clip-handlers";
import { registerCommandResultHandlers } from "./command-result-handlers";
import { registerCueHandlers } from "./cue-handlers";
import { registerDeskHandlers } from "./desk-handlers";
import { registerFixtureHandlers } from "./fixture-handlers";
import { registerFlowHandlers } from "./flow-handlers";
import { registerFxHandlers } from "./fx-handlers";
import { registerLibraryResponseHandlers } from "./library-response-handlers";
import {
  createWsMessageHandlerRegistry,
  type WsMessageHandlerRegistry,
} from "./message-registry";
import { registerOutputHandlers } from "./output-handlers";
import { registerProgrammerHandlers } from "./programmer-handlers";
import { registerReferenceHandlers } from "./reference-handlers";
import { registerRuntimeSnapshotHandlers } from "./runtime-snapshot-handlers";
import { registerSceneObjectHandlers } from "./scene-object-handlers";
import {
  registerSessionHandlers,
  type SessionHandlerContext,
} from "./session-handlers";
import { registerSettingsSnapshotHandlers } from "./settings-snapshot-handlers";
import { registerTimelineHandlers } from "./timeline-handlers";
import type { AnyWsMessage } from "./types";

/** Runtime-owned state lent to domain handlers that cannot own it themselves. */
export interface MainThreadMessageHandlerContext {
  session: SessionHandlerContext;
}

/** Creates the registry that routes every main-thread websocket message to its domain handler. */
export function createMainThreadMessageHandlerRegistry(
  context: MainThreadMessageHandlerContext,
): WsMessageHandlerRegistry<AnyWsMessage> {
  const registry = createWsMessageHandlerRegistry<AnyWsMessage>();
  registerSessionHandlers(registry, context.session);
  registerCommandResultHandlers(registry);
  registerDeskHandlers(registry);
  registerFixtureHandlers(registry);
  registerSceneObjectHandlers(registry);
  registerProgrammerHandlers(registry);
  registerOutputHandlers(registry);
  registerReferenceHandlers(registry);
  registerCueHandlers(registry);
  registerBoardHandlers(registry);
  registerFxHandlers(registry);
  registerFlowHandlers(registry);
  registerClipHandlers(registry);
  registerTimelineHandlers(registry);
  registerLibraryResponseHandlers(registry);
  registerRuntimeSnapshotHandlers(registry);
  registerSettingsSnapshotHandlers(registry);
  return registry;
}
