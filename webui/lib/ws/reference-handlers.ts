// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  referenceHealth,
  referenceList,
  referenceListWatch,
} from "../../state/appStores";
import type * as types from "../../types";
import { setStoreAction } from "../nanostore-action";
import {
  applyReferenceListUpdate,
  referenceListFromOwners,
} from "../reference-list";
import type { WsMessageHandlerRegistry } from "./message-registry";
import type { AnyWsMessage } from "./types";

/** Registers the reference health, reference list and reference list update handlers. */
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
      referenceListFromOwners(message.data as types.OwnerReferenceList[]),
    );
  });

  registry.register("ReferenceListUpdate", (message) => {
    // An update already in flight when the watch stopped would leave partial rows behind.
    if (!referenceListWatch.get()) return;
    setStoreAction(
      referenceList,
      "Receive ReferenceListUpdate",
      applyReferenceListUpdate(
        referenceList.get(),
        message.data as types.OwnerReferenceList[],
      ),
    );
  });
}
