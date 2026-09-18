// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Reactive hook for accessing fixture data from stores.
 *
 * This hook joins two separate stores:
 * - `fixtures`: Static fixture metadata (make, model, elements, placement)
 * - `fixtureGeometries`: GDTF geometry trees for each fixture
 *
 * The join is necessary because geometry is loaded asynchronously and stored
 * separately from fixture metadata. The hook produces `RenderableFixture[]`
 * which contains all data needed for Three.js rendering.
 *
 * Why this exists instead of accessing stores directly:
 * 1. Joins two stores into a single reactive signal
 * 2. Applies default placement (0,0,0) if not set on fixture
 * 3. Flattens to array format expected by FixtureManager.syncFixtures()
 */

import { useStore } from "@nanostores/solid";
import { type Accessor, createMemo } from "solid-js";
import { fixtureGeometries, fixtures } from "../../../state/appStores";
import type { RenderableFixture } from "../model/types";

/**
 * Reactive accessor for fixtures with geometry data.
 * Recomputes when fixtures or geometries change.
 */
export function useFixtures(): Accessor<readonly RenderableFixture[]> {
  const $fixtures = useStore(fixtures);
  const $geometries = useStore(fixtureGeometries);

  return createMemo(() => {
    const fixtureMap = $fixtures();
    const geometryMap = $geometries();
    const result: RenderableFixture[] = [];

    for (const [uid, fixture] of Object.entries(fixtureMap)) {
      // Apply default placement if not set
      const placement = fixture.placement ?? {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
      };

      result.push({
        uid,
        fixtureId: fixture.identifiers.id,
        make: fixture.make,
        model: fixture.model,
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
        geometry: geometryMap[uid],
        elements: fixture.elements,
        beamType: fixture.physical?.beamType,
        layout: fixture.layout,
      });
    }

    return result;
  });
}
