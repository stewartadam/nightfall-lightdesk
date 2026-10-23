// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  availableFxModules,
  colorPathDefaults,
  colorPaths,
  fx,
  fxModules,
  stepFx,
} from "../../state/appStores";
import type * as types from "../../types";
import { setStoreAction } from "../nanostore-action";
import { arrayToUidMap } from "./handler-utils";
import type { WsMessageHandlerRegistry } from "./message-registry";
import type { AnyWsMessage } from "./types";

/** Registers FX, step FX, FX module, and color path handlers. */
export function registerFxHandlers(
  registry: WsMessageHandlerRegistry<AnyWsMessage>,
): void {
  registry.register("ColorPathDefinitions", (message) => {
    setStoreAction(
      colorPaths,
      "Receive ColorPathDefinitions",
      arrayToUidMap(message.data as types.ColorPath[]),
    );
  });

  registry.register("ColorPathDefaults", (message) => {
    setStoreAction(
      colorPathDefaults,
      "Receive ColorPathDefaults",
      message.data as types.ColorPathDefault[],
    );
  });

  registry.register("FxDefinitions", (message) => {
    setStoreAction(fx, "Receive FxDefinitions", arrayToUidMap(message.data));
  });

  registry.register("StepFxDefinitions", (message) => {
    setStoreAction(
      stepFx,
      "Receive StepFxDefinitions",
      arrayToUidMap(message.data),
    );
  });

  registry.register("FxModuleDefinitions", (message) => {
    setStoreAction(
      fxModules,
      "Receive FxModuleDefinitions",
      arrayToUidMap(message.data),
    );
  });

  registry.register("ListAvailableFxModulesResponse", (message) => {
    setStoreAction(
      availableFxModules,
      "Receive ListAvailableFxModulesResponse",
      message.data.modules,
    );
  });
}
