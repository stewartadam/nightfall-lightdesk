// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type * as types from "../../../types";
import {
  buildSelectionGridLayer,
  deriveSelectionGridBounds,
  listSelectionZLayers,
  selectionTargetsForStep,
} from "./selection-grid";

/** Build a fixture reference for selection-grid tests. */
function fixtureRef(fixture_uid: string, index?: number): types.FixtureRef {
  return { fixture_uid, index: index ?? null } as types.FixtureRef;
}

/** Build a minimal resolved selection fixture member for tests. */
function member(
  fixture: types.FixtureRef,
  x: number,
  y: number,
  z: number,
): types.IndexedFixture {
  return { fixture, projected_coord: { x, y, z } } as types.IndexedFixture;
}

/** Build a resolved selection with optional explicit projection bounds. */
function resolvedSelection(
  indexes: types.SelectionIndex[],
  projection_bounds?: types.ProjectionBounds | null,
): types.ResolvedSelection {
  return {
    canonical: indexes.flatMap((index) =>
      index.members.map((entry) => entry.fixture),
    ),
    indexes,
    projection_bounds: projection_bounds ?? null,
    invert_attrs: undefined,
  } as types.ResolvedSelection;
}

test("deriveSelectionGridBounds uses explicit projection bounds", () => {
  const resolved = resolvedSelection(
    [
      {
        index: 0,
        invert: false,
        members: [member(fixtureRef("fixture-a"), 3, 4, 5)],
      } as types.SelectionIndex,
    ],
    { min_x: 0, max_x: 4, min_y: 1, max_y: 6, min_z: 2, max_z: 7 },
  );

  assert.deepEqual(deriveSelectionGridBounds(resolved), {
    minX: 0,
    maxX: 4,
    minY: 1,
    maxY: 6,
    minZ: 2,
    maxZ: 7,
  });
});

test("buildSelectionGridLayer marks empty, occupied, active, inverted, and element cells", () => {
  const resolved = resolvedSelection([
    {
      index: 0,
      invert: false,
      members: [member(fixtureRef("fixture-a"), 0, 0, 0)],
    } as types.SelectionIndex,
    {
      index: 1,
      invert: true,
      members: [member(fixtureRef("fixture-b", 2), 1, 0, 0)],
    } as types.SelectionIndex,
  ]);

  const layer = buildSelectionGridLayer(resolved, 0, 1);

  assert.deepEqual(listSelectionZLayers(resolved), [0]);
  assert.equal(layer?.rows[0]?.cells[0]?.occupied, true);
  assert.equal(layer?.rows[0]?.cells[0]?.active, false);
  assert.equal(layer?.rows[0]?.cells[1]?.active, true);
  assert.equal(layer?.rows[0]?.cells[1]?.inverted, true);
  assert.equal(layer?.rows[0]?.cells[1]?.fixtureElement, true);
});

test("selectionTargetsForStep preserves fixture element indexes", () => {
  const resolved = resolvedSelection([
    {
      index: 0,
      invert: false,
      members: [member(fixtureRef("fixture-a", 3), 0, 0, 0)],
    } as types.SelectionIndex,
  ]);

  assert.deepEqual(selectionTargetsForStep(resolved, 0), [
    { fixtureUid: "fixture-a", elementIndex: 3 },
  ]);
});
