// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  applyFixtureDraftClosed,
  applyFixtureDraftUpdated,
} from "../../state/fixture-drafts";
import type { WsMessageHandlerRegistry } from "./message-registry";
import type { AnyWsMessage } from "./types";

/** Registers handlers that keep the shared fixture-editor draft store current. */
export function registerFixtureEditorHandlers(
  registry: WsMessageHandlerRegistry<AnyWsMessage>,
): void {
  registry.register("FixtureDraftUpdated", (message) => {
    applyFixtureDraftUpdated(message.data);
  });

  registry.register("FixtureDraftClosed", (message) => {
    applyFixtureDraftClosed(message.data);
  });
}
