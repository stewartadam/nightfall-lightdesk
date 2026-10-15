// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  dmxUniverseWatch,
  runtimeCapabilities,
  serverVersion,
} from "../../state/appStores";
import { beginShowfileTransition } from "../../state/showfile-transition";
import type * as types from "../../types";
import { getLogger } from "../logger";
import { setStoreAction } from "../nanostore-action";
import { currentShowfileRevision } from "../showfile-loading";
import type { WsMessageHandlerRegistry } from "./message-registry";
import type { AnyWsMessage } from "./types";

const log = getLogger(import.meta.url);

/**
 * Engine runtime session state the session handlers drive. The runtime owns
 * these HMR-preserved signals and its transport, so it lends them here rather
 * than having this module import the runtime back.
 */
export interface SessionHandlerContext {
  /** Returns how many backend resyncs this page has completed. */
  resyncGeneration(): number;
  /** Marks the backend resync complete and advances the resync generation. */
  markResyncComplete(): void;
  /** Publishes the backend's reported application state. */
  setBackendAppState(state: types.AppState): void;
  /** Discards session-scoped state and requests a full snapshot from the backend. */
  requestBackendSessionState(): void;
  /** Replaces the set of universes whose channel values this client watches. */
  sendDmxUniverseWatch(universes: readonly types.DmxUniverseKey[]): void;
}

/** Registers backend session lifecycle, version, and capability handlers. */
export function registerSessionHandlers(
  registry: WsMessageHandlerRegistry<AnyWsMessage>,
  context: SessionHandlerContext,
): void {
  registry.register("ServerVersion", (message) => {
    log.info(`Server version: ${message.data}`);
    setStoreAction(
      serverVersion,
      "Receive ServerVersion",
      message.data as string,
    );
  });

  registry.register("AppState", (message) => {
    log.debug("Backend app state:", message.data);
    context.setBackendAppState(message.data as types.AppState);
  });

  registry.register("RuntimeCapabilities", (message) => {
    setStoreAction(
      runtimeCapabilities,
      "Receive RuntimeCapabilities",
      message.data as types.RuntimeCapabilities,
    );
  });

  registry.register("ResyncComplete", () => {
    context.markResyncComplete();
    // Watches belong to one connection and one backend world, so a resync after a reconnect
    // or world swap starts without ours; re-sending also gets fresh values at once.
    context.sendDmxUniverseWatch(dmxUniverseWatch.get());
  });

  registry.register("WorldReplaced", () => {
    log.debug("Backend replaced its world, requesting resync");
    beginShowfileTransition({
      resyncGeneration: context.resyncGeneration(),
      showfileRevision: currentShowfileRevision.get(),
    });
    context.requestBackendSessionState();
  });
}
