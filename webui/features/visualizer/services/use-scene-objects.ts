// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Reactive hook for accessing scene object data from stores.
 *
 * This hook converts the scene objects store to RenderableSceneObject[] format
 * suitable for Three.js rendering.
 */

import { useStore } from "@nanostores/solid";
import { type Accessor, createMemo } from "solid-js";
import { sceneObjects } from "../../../state/appStores";
import type { RenderableSceneObject } from "../model/types";

/**
 * Reactive accessor for scene objects.
 * Recomputes when scene objects store changes.
 */
export function useSceneObjects(): Accessor<readonly RenderableSceneObject[]> {
  const $sceneObjects = useStore(sceneObjects);

  return createMemo(() => {
    const sceneObjectMap = $sceneObjects();
    const result: RenderableSceneObject[] = [];

    for (const [uid, sceneObject] of Object.entries(sceneObjectMap)) {
      // Apply default placement if not set
      const placement = sceneObject.placement ?? {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
      };

      result.push({
        uid,
        sceneObjectId: sceneObject.identifiers.id,
        objectType: sceneObject.objectType,
        label: sceneObject.identifiers.label,
        position: {
          x: placement.position.x,
          y: placement.position.y,
          z: placement.position.z,
        },
        rotation: {
          x: placement.rotation.x,
          y: placement.rotation.y,
          z: placement.rotation.z,
        },
        properties: sceneObject.properties,
      });
    }

    return result;
  });
}
