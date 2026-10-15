// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { referenceHealth, referenceList } from "../../state/appStores";
import type * as types from "../../types";
import { setStoreAction } from "../nanostore-action";
import type { WsMessageHandlerRegistry } from "./message-registry";
import type { AnyWsMessage } from "./types";

/** Registers the reference health and reference list handlers. */
export function registerReferenceHandlers(
  registry: WsMessageHandlerRegistry<AnyWsMessage>,
): void {
  registry.register("ReferenceHealth", (message) => {
    setStoreAction(
      referenceHealth,
      "Receive ReferenceHealth",
      message.data as types.ReferenceHealth,
    );
  });

  registry.register("ReferenceList", (message) => {
    setStoreAction(
      referenceList,
      "Receive ReferenceList",
      message.data as types.ReferenceEntry[],
    );
  });
}
