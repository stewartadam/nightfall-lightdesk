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
import { getLogger } from "../logger";
import { setStoreAction } from "../nanostore-action";
import { arrayToUidMap } from "./handler-utils";
import type { WsMessageHandlerRegistry } from "./message-registry";
import type { AnyWsMessage } from "./types";

const log = getLogger(import.meta.url);

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

  registry.register("FxCommand", (message) => {
    handleFxCommand(message.data as unknown as types.FxCommand);
  });

  registry.register("FxModuleCommand", (message) => {
    handleFxModuleCommand(message.data as unknown as types.FxModuleCommand);
  });
}

/** Ignores optimistic FX mutations in favor of backend provider snapshots. */
function handleFxCommand(command: types.FxCommand) {
  log.trace("Handling FxCommand:", command);

  // CRUD commands (StoreFx, RenameFx, DeleteFx) are not processed here.
  // Instead, we receive full FxDefinitions when the backend DataProvider changes.
  // This prevents optimistic updates that show stale data when commands fail.
  log.trace("Ignoring FxCommand (handled via FxDefinitions):", command.type);
}

/** Ignores stored FX module mutations in favor of backend provider snapshots. */
function handleFxModuleCommand(command: types.FxModuleCommand) {
  log.trace("Handling FxModuleCommand:", command);

  // Stored fx module updates are reflected through full FxModuleDefinitions
  // snapshots rather than optimistic local mutation.
  log.trace(
    "Ignoring FxModuleCommand (handled via FxModuleDefinitions):",
    command.type,
  );
}
