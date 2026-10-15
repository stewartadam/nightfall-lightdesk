// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  bindings,
  bindingValidationSettings,
  fixtureGeometries,
  fixtures,
  groups,
} from "../../state/appStores";
import type * as types from "../../types";
import { setAttributeMetadata } from "../attribute-metadata";
import { getLogger } from "../logger";
import { setStoreAction } from "../nanostore-action";
import { arrayToUidMap } from "./handler-utils";
import type { WsMessageHandlerRegistry } from "./message-registry";
import type { AnyWsMessage } from "./types";

const log = getLogger(import.meta.url);

/** Registers fixture, patch binding, group, and fixture-library handlers. */
export function registerFixtureHandlers(
  registry: WsMessageHandlerRegistry<AnyWsMessage>,
): void {
  registry.register("FixtureDefinitions", (message) => {
    setStoreAction(
      fixtures,
      "Receive FixtureDefinitions",
      arrayToUidMap(message.data),
    );
  });

  registry.register("AttributeMetadata", (message) => {
    setAttributeMetadata(message.data);
  });

  registry.register("FixtureGeometries", (message) => {
    setStoreAction(
      fixtureGeometries,
      "Receive FixtureGeometries",
      message.data,
    );
  });

  registry.register("GroupDefinitions", (message) => {
    setStoreAction(
      groups,
      "Receive GroupDefinitions",
      arrayToUidMap(message.data),
    );
  });

  registry.register("Bindings", (message) => {
    setStoreAction(
      bindings,
      "Receive Bindings",
      message.data as types.BindingsSnapshot,
    );
  });

  registry.register("BindingValidationSettings", (message) => {
    setStoreAction(
      bindingValidationSettings,
      "Receive BindingValidationSettings",
      message.data as types.BindingValidationSettings,
    );
  });

  registry.register("FixtureCommand", (message) => {
    handleFixtureCommand(message.data as unknown as types.FixtureCommand);
  });

  registry.register("FixtureLibraryCommand", (message) => {
    handleFixtureLibraryCommand(
      message.data as unknown as types.FixtureLibraryCommand,
    );
  });

  registry.register("GroupCommand", (message) => {
    handleGroupCommand(message.data as unknown as types.GroupCommand);
  });
}

/** Placement vector update that sets either every component or a single axis. */
type AxisUpdate<V> =
  | { type: "All"; data: V }
  | { type: "X" | "Y" | "Z"; data: number };

/**
 * Applies one placement vector update and returns the resulting vector, or
 * `null` when it changes nothing so unchanged fixtures keep store identity.
 * Single-axis updates mutate `current`, which must be a private copy.
 */
function applyAxisUpdate<V extends { x: number; y: number; z: number }>(
  current: V,
  update: AxisUpdate<V>,
): V | null {
  if (update.type === "All") {
    const next = update.data;
    return current.x !== next.x || current.y !== next.y || current.z !== next.z
      ? next
      : null;
  }
  const axis = update.type === "X" ? "x" : update.type === "Y" ? "y" : "z";
  if (current[axis] === update.data) return null;
  current[axis] = update.data as V[typeof axis];
  return current;
}

/** Applies fixture placement deltas while leaving fixture CRUD to provider snapshots. */
function handleFixtureCommand(command: types.FixtureCommand) {
  log.trace("Handling FixtureCommand:", command);

  // Most fixture commands are handled via FixtureDefinitions/Bindings snapshots.
  // Placement updates are handled directly as deltas to avoid full fixture re-sync churn.
  switch (command.type) {
    case "UpdateFixturePlacements": {
      const startMs = performance.now();
      const requestedUpdates = command.data.updates.length;
      const fixtureMap = fixtures.get();
      const fixtureUidById = new Map<number, string>();
      for (const [uid, fixture] of Object.entries(fixtureMap)) {
        fixtureUidById.set(fixture.identifiers.id, uid);
      }

      let nextFixtureMap: typeof fixtureMap | null = null;
      let changedFixtureCount = 0;

      for (const update of command.data.updates) {
        const { id, position, rotation } = update;
        const uid = fixtureUidById.get(id);
        if (!uid) {
          log.warn(`Fixture ${id} not found for placement update`);
          continue;
        }

        const sourceFixtureMap = nextFixtureMap ?? fixtureMap;
        const fixture = sourceFixtureMap[uid];
        if (!fixture) {
          log.warn(`Fixture ${id} (${uid}) not found for placement update`);
          continue;
        }

        const currentPlacement: types.FixturePlacement = fixture.placement ?? {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
        };
        const updatedPlacement: types.FixturePlacement = {
          ...currentPlacement,
          position: { ...currentPlacement.position },
          rotation: { ...currentPlacement.rotation },
        };
        let hasChanges = false;
        const nextPosition = position
          ? applyAxisUpdate(updatedPlacement.position, position)
          : null;
        if (nextPosition) {
          updatedPlacement.position = nextPosition;
          hasChanges = true;
        }
        const nextRotation = rotation
          ? applyAxisUpdate(updatedPlacement.rotation, rotation)
          : null;
        if (nextRotation) {
          updatedPlacement.rotation = nextRotation;
          hasChanges = true;
        }

        if (hasChanges) {
          if (!nextFixtureMap) {
            nextFixtureMap = { ...fixtureMap };
          }
          nextFixtureMap[uid] = {
            ...fixture,
            placement: updatedPlacement,
          };
          changedFixtureCount += 1;
        }
      }

      if (nextFixtureMap) {
        const storeMutationStartMs = performance.now();
        setStoreAction(fixtures, "Update Fixture Placements", nextFixtureMap);
        const storeMutationMs = performance.now() - storeMutationStartMs;
        const totalMs = performance.now() - startMs;
        log.trace(
          `UpdateFixturePlacements requested=${requestedUpdates} changed=${changedFixtureCount} storeMutationMs=${storeMutationMs.toFixed(2)} totalMs=${totalMs.toFixed(2)}`,
        );
      } else {
        const totalMs = performance.now() - startMs;
        log.trace(
          `UpdateFixturePlacements requested=${requestedUpdates} changed=0 totalMs=${totalMs.toFixed(2)}`,
        );
      }
      break;
    }

    case "UpdateFixturePatch": {
      const { id } = command.data;
      log.trace(
        `Patch update for fixture ${id} - waiting for Bindings message`,
      );
      // Patch updates are handled via the "Bindings" message sent by send_bindings_on_change
      // Don't try to manually update here - the backend will send the complete binding state
      break;
    }

    case "SetDmxChannels": {
      // DMX channel commands don't affect fixture state directly
      // They update parameter outputs which are handled via ParameterState messages
      log.trace("SetDmxChannels command received (handled via ParameterState)");
      break;
    }

    default:
      log.trace(
        "Ignoring FixtureCommand (handled via FixtureDefinitions):",
        command.type,
      );
  }
}

/** Logs fixture-library command acknowledgements whose data arrives in later messages. */
function handleFixtureLibraryCommand(command: types.FixtureLibraryCommand) {
  log.trace("Handling FixtureLibraryCommand:", command);

  switch (command.type) {
    case "CreateFixtureFromLibrary": {
      // Server echoes this back after processing - no action needed on client
      // The fixture will be sent via FixtureCommand/StoreFixture
      log.trace(
        `CreateFixtureFromLibrary acknowledged for ${command.data.make} ${command.data.model}`,
      );
      break;
    }

    case "CreateFixturesFromLibrary": {
      log.trace(
        `CreateFixturesFromLibrary acknowledged for ${command.data.fixtures.length} ${command.data.make} ${command.data.model}`,
      );
      break;
    }

    case "GetFixtureProfile": {
      // Server echoes this back - response comes via separate message
      log.trace("GetFixtureProfile acknowledged");
      break;
    }

    default:
      log.warn(`Unhandled FixtureLibraryCommand: ${command.type}`);
  }
}

/** Ignores optimistic group mutations in favor of backend provider snapshots. */
function handleGroupCommand(command: types.GroupCommand) {
  log.trace("Handling GroupCommand:", command);

  // CRUD commands (StoreGroup, RenameGroup, DeleteGroup) are not processed here.
  // Instead, we receive full GroupDefinitions when the backend DataProvider changes.
  // This prevents optimistic updates that show stale data when commands fail.
  log.trace(
    "Ignoring GroupCommand (handled via GroupDefinitions):",
    command.type,
  );
}
