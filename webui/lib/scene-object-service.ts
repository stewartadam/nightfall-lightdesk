// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Service for scene object operations (create, update, delete).
 */

import { v4 as uuidv4 } from "uuid";
import {
  type AudienceProperties,
  type CommandResult,
  type CustomProperties,
  type ObjectLibraryCommand,
  type SceneObject,
  type SceneObjectCommand,
  type SceneObjectPlacementPositionUpdate,
  type SceneObjectPlacementRotationUpdate,
  type SceneObjectProperties,
  SceneObjectType,
  type StageElementProperties,
  type TrussProperties,
  TrussType,
} from "../types";
import { commandEnvelope } from "./command-envelope";
import { commandFailureMessage, commandSucceeded } from "./command-result";
import { engineRuntime } from "./engine-runtime";
import { getLogger } from "./logger";

const log = getLogger(import.meta.url);

/**
 * Get default properties for a scene object type.
 */
function getDefaultProperties(
  objectType: SceneObjectType,
): SceneObjectProperties {
  switch (objectType) {
    case SceneObjectType.Truss:
      return {
        type: "Truss",
        data: {
          length: 2.0,
          trussType: TrussType.Box,
          diameter: 0.3,
        } satisfies TrussProperties,
      };
    case SceneObjectType.Audience:
      return {
        type: "Audience",
        data: {
          width: 10.0,
          depth: 10.0,
          density: 1.0,
          heightVariation: 0.1,
        } satisfies AudienceProperties,
      };
    case SceneObjectType.StageElement:
      return {
        type: "StageElement",
        data: {
          modelPath: "",
          scale: 1.0,
        } satisfies StageElementProperties,
      };
    case SceneObjectType.Custom:
      return {
        type: "Custom",
        data: {
          modelPath: "",
          scale: 1.0,
        } satisfies CustomProperties,
      };
    default: {
      // Exhaustiveness check
      const _exhaustive: never = objectType;
      throw new Error(`Unknown scene object type: ${_exhaustive}`);
    }
  }
}

/**
 * Create a new scene object and send it to the backend.
 */
export function createSceneObject(
  id: number,
  label: string,
  objectType: SceneObjectType,
  properties?: SceneObjectProperties,
): void {
  const sceneObject: SceneObject = {
    identifiers: {
      id,
      uid: uuidv4(),
      label,
    },
    objectType,
    placement: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    },
    properties: properties ?? getDefaultProperties(objectType),
  };

  const command: SceneObjectCommand = {
    type: "StoreSceneObject",
    data: sceneObject,
  };

  engineRuntime.sendCommand({
    module: "SceneObjectCommand",
    command,
  });

  log.info(`Created scene object: ${label} (${objectType}) with ID ${id}`);
}

/**
 * Delete a scene object by ID.
 */
export function deleteSceneObject(id: number, batchId?: string): void {
  const command: SceneObjectCommand = {
    type: "DeleteSceneObject",
    data: id,
  };

  engineRuntime.sendCommand(
    commandEnvelope("SceneObjectCommand", command, batchId),
  );

  log.info(`Deleted scene object with ID ${id}`);
}

/**
 * Update scene object placement (position and/or rotation).
 */
export function updateSceneObjectPlacement(
  id: number,
  position?: SceneObjectPlacementPositionUpdate,
  rotation?: SceneObjectPlacementRotationUpdate,
  batchId?: string,
): void {
  const command: SceneObjectCommand = {
    type: "UpdateSceneObjectPlacement",
    data: {
      id,
      position,
      rotation,
    },
  };

  engineRuntime.sendCommand({
    ...(batchId ? { undo_id: batchId } : {}),
    module: "SceneObjectCommand",
    command,
  });

  log.info(`Updated placement for scene object ${id}`);
}

/**
 * Update scene object properties.
 */
export function updateSceneObjectProperties(
  id: number,
  properties: SceneObjectProperties,
): void {
  const command: SceneObjectCommand = {
    type: "UpdateSceneObjectProperties",
    data: {
      id,
      properties,
    },
  };

  engineRuntime.sendCommand({
    module: "SceneObjectCommand",
    command,
  });

  log.info(`Updated properties for scene object ${id}`);
}

/**
 * Update existing scene objects from their linked object-library copies.
 */
export async function updateSceneObjectsFromLibrary(
  sceneObjectIds: number[],
): Promise<CommandResult> {
  const command: ObjectLibraryCommand = {
    type: "UpdateSceneObjectsFromLibrary",
    data: {
      scene_object_ids: sceneObjectIds,
    },
  };

  const result = await engineRuntime.sendCommandAndAwait({
    module: "ObjectLibraryCommand",
    command,
  });

  if (commandSucceeded(result)) {
    log.info(
      `Updated ${sceneObjectIds.length} scene object(s) from object library`,
    );
  } else {
    log.warn(
      `Failed updating scene objects from library: ${commandFailureMessage(result)}`,
    );
  }

  return result;
}
