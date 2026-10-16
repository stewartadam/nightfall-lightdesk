// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { sceneObjects } from "../../state/appStores";
import type * as types from "../../types";
import { getLogger } from "../logger";
import { setStoreAction } from "../nanostore-action";
import { arrayToUidMap } from "./handler-utils";
import type { WsMessageHandlerRegistry } from "./message-registry";
import type { AnyWsMessage } from "./types";

const log = getLogger(import.meta.url);

/** Registers scene object snapshot, command echo, and object-library handlers. */
export function registerSceneObjectHandlers(
  registry: WsMessageHandlerRegistry<AnyWsMessage>,
): void {
  registry.register("SceneObjectDefinitions", (message) => {
    setStoreAction(
      sceneObjects,
      "Receive SceneObjectDefinitions",
      arrayToUidMap(message.data as types.SceneObject[]),
    );
  });

  registry.register("SceneObjectCommand", (message) => {
    handleSceneObjectCommand(
      message.data as unknown as types.SceneObjectCommand,
    );
  });

  registry.register("ObjectLibraryCommand", (message) => {
    handleObjectLibraryCommand(
      message.data as unknown as types.ObjectLibraryCommand,
    );
  });
}

/** Applies scene object store, delete, placement, and property updates to the local store. */
function handleSceneObjectCommand(command: types.SceneObjectCommand) {
  log.trace("Handling SceneObjectCommand:", command);

  switch (command.type) {
    case "StoreSceneObject": {
      log.trace(`Storing scene object ${command.data.identifiers.id}`);
      setStoreAction(sceneObjects, "Store Scene Object", {
        ...sceneObjects.get(),
        [command.data.identifiers.uid]: command.data,
      });
      break;
    }
    case "DeleteSceneObject": {
      const sceneObjectId = command.data as number;
      log.trace(`Deleting scene object ${sceneObjectId}`);
      // Find the scene object by ID and remove it from the map
      const sceneObjectMap = sceneObjects.get();
      for (const [uid, sceneObject] of Object.entries(sceneObjectMap)) {
        if (sceneObject.identifiers.id === sceneObjectId) {
          const updatedMap = { ...sceneObjectMap };
          delete updatedMap[uid];
          setStoreAction(sceneObjects, "Delete Scene Object", updatedMap);
          break;
        }
      }
      break;
    }
    case "UpdateSceneObjectPlacement": {
      const { id, position, rotation } = command.data;
      log.trace(`Updating placement for scene object ${id}`);

      // Find the scene object by ID
      const sceneObjectMap = sceneObjects.get();
      const sceneObjectEntry = Object.entries(sceneObjectMap).find(
        ([, obj]) => obj.identifiers.id === id,
      );
      if (!sceneObjectEntry) {
        log.warn(`Scene object ${id} not found for placement update`);
        return;
      }

      const [uid, sceneObject] = sceneObjectEntry;

      // Create deep copy with nested placement object
      const updatedSceneObject = {
        ...sceneObject,
        placement: {
          ...sceneObject.placement,
          position: { ...sceneObject.placement.position },
          rotation: { ...sceneObject.placement.rotation },
        },
      };

      // Apply position updates
      if (position) {
        switch (position.type) {
          case "All":
            updatedSceneObject.placement.position = position.data;
            break;
          case "X":
            updatedSceneObject.placement.position.x = position.data;
            break;
          case "Y":
            updatedSceneObject.placement.position.y = position.data;
            break;
          case "Z":
            updatedSceneObject.placement.position.z = position.data;
            break;
        }
      }

      // Apply rotation updates
      if (rotation) {
        switch (rotation.type) {
          case "All":
            updatedSceneObject.placement.rotation = rotation.data;
            break;
          case "X":
            updatedSceneObject.placement.rotation.x = rotation.data;
            break;
          case "Y":
            updatedSceneObject.placement.rotation.y = rotation.data;
            break;
          case "Z":
            updatedSceneObject.placement.rotation.z = rotation.data;
            break;
        }
      }

      setStoreAction(sceneObjects, "Update Scene Object Placement", {
        ...sceneObjectMap,
        [uid]: updatedSceneObject,
      });
      break;
    }
    case "UpdateSceneObjectProperties": {
      const { id, properties } = command.data;
      log.trace(`Updating properties for scene object ${id}`);

      // Find the scene object by ID
      const sceneObjectMap = sceneObjects.get();
      const sceneObjectEntry = Object.entries(sceneObjectMap).find(
        ([, obj]) => obj.identifiers.id === id,
      );
      if (!sceneObjectEntry) {
        log.warn(`Scene object ${id} not found for properties update`);
        return;
      }

      const [uid, sceneObject] = sceneObjectEntry;

      // Map properties.type (PascalCase) to objectType (camelCase)
      const typeMap: Record<string, string> = {
        Truss: "truss",
        Audience: "audience",
        StageElement: "stageElement",
        Custom: "custom",
      };

      const updatedSceneObject: types.SceneObject = {
        ...sceneObject,
        properties,
        objectType: typeMap[properties.type] as types.SceneObjectType,
      };

      setStoreAction(sceneObjects, "Update Scene Object Properties", {
        ...sceneObjectMap,
        [uid]: updatedSceneObject,
      });
      break;
    }
    default:
      log.warn(`Unhandled SceneObjectCommand: ${(command as any).type}`);
  }
}

/** Logs object-library command acknowledgements whose data arrives in later messages. */
function handleObjectLibraryCommand(command: types.ObjectLibraryCommand) {
  log.trace("Handling ObjectLibraryCommand:", command);

  switch (command.type) {
    case "CreateSceneObjectFromLibrary": {
      // Server echoes this back after processing - no action needed on client
      // The scene object will be sent via SceneObjectCommand/StoreSceneObject
      log.trace(
        `CreateSceneObjectFromLibrary acknowledged for ${command.data.object_name}`,
      );
      break;
    }

    case "GetObjectProfile": {
      // Server echoes this back - response comes via separate message
      log.trace("GetObjectProfile acknowledged");
      break;
    }

    case "UpdateSceneObjectsFromLibrary": {
      log.trace("UpdateSceneObjectsFromLibrary acknowledged");
      break;
    }

    default:
      log.warn(`Unhandled ObjectLibraryCommand: ${(command as any).type}`);
  }
}
