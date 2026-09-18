// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  applyAvailableFixturesResponse,
  applyAvailableObjectsResponse,
  applyFixtureProfileResponse,
  applyObjectProfileResponse,
} from "../../state/library-responses";
import type { WsMessageHandlerRegistry } from "./message-registry";
import type { AnyWsMessage } from "./types";

/** Registers library response handlers that only hydrate library stores. */
export function registerLibraryResponseHandlers(
  registry: WsMessageHandlerRegistry<AnyWsMessage>,
): void {
  registry.register("ListAvailableFixturesResponse", (message) => {
    applyAvailableFixturesResponse(message.data.fixtures);
  });

  registry.register("GetFixtureProfileResponse", (message) => {
    applyFixtureProfileResponse(message.data);
  });

  registry.register("ListAvailableObjectsResponse", (message) => {
    applyAvailableObjectsResponse(message.data.objects);
  });

  registry.register("GetObjectProfileResponse", (message) => {
    applyObjectProfileResponse(message.data);
  });
}
