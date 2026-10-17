// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type BoardStatusMap,
  boardStates,
  boards,
} from "../../state/appStores";
import type * as types from "../../types";
import { setStoreAction } from "../nanostore-action";
import { arrayToUidMap } from "./handler-utils";
import type { WsMessageHandlerRegistry } from "./message-registry";
import type { AnyWsMessage } from "./types";

/** Registers board definition and live button state handlers. */
export function registerBoardHandlers(
  registry: WsMessageHandlerRegistry<AnyWsMessage>,
): void {
  registry.register("BoardDefinitions", (message) => {
    setStoreAction(
      boards,
      "Receive BoardDefinitions",
      arrayToUidMap(message.data as types.Board[]),
    );
  });

  registry.register("BoardStates", (message) => {
    setStoreAction(
      boardStates,
      "Receive BoardStates",
      boardStatusArrayToMap(message.data as types.BoardStatus[]),
    );
  });
}

/** Indexes resolved board buttons by board UID and element UID for constant-time lookup. */
export function boardStatusArrayToMap(
  statuses: types.BoardStatus[],
): BoardStatusMap {
  const map: BoardStatusMap = {};
  for (const status of statuses) {
    const elements: BoardStatusMap[string] = {};
    for (const element of status.elements) {
      elements[element.element_uid] = element.items;
    }
    map[status.board_uid] = elements;
  }
  return map;
}
