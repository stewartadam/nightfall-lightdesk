// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { macroRuns, macros } from "../../state/appStores";
import type * as types from "../../types";
import { setStoreAction } from "../nanostore-action";
import { arrayToUidMap } from "./handler-utils";
import type { WsMessageHandlerRegistry } from "./message-registry";
import type { AnyWsMessage } from "./types";

/** Registers handlers for macro definitions and the progress of running macros. */
export function registerMacroHandlers(
  registry: WsMessageHandlerRegistry<AnyWsMessage>,
): void {
  registry.register("MacroDefinitions", (message) => {
    setStoreAction(
      macros,
      "Receive MacroDefinitions",
      arrayToUidMap(message.data as types.Macro[]),
    );
  });

  registry.register("MacroRunStates", (message) => {
    setStoreAction(
      macroRuns,
      "Receive MacroRunStates",
      message.data as types.MacroRunStatus[],
    );
  });
}
