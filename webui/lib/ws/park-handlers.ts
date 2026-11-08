// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { parkedParameters } from "../../state/appStores";
import type * as types from "../../types";
import { setStoreAction } from "../nanostore-action";
import type { WsMessageHandlerRegistry } from "./message-registry";
import type { AnyWsMessage } from "./types";

/** Registers the handler that mirrors the engine's parked parameters into the park store. */
export function registerParkHandlers(
  registry: WsMessageHandlerRegistry<AnyWsMessage>,
): void {
  registry.register("ParkedParameters", (message) => {
    setStoreAction(
      parkedParameters,
      "Receive ParkedParameters",
      message.data as types.ParkedParameter[],
    );
  });
}
