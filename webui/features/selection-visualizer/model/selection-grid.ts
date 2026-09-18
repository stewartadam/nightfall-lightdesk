// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { SelectionTarget } from "../../../lib/selection-targets";
import type * as types from "../../../types";

/** Inclusive bounds for projected spatial-selection coordinates. */
export interface SelectionGridBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/** Display-ready fixture member in a projected selection grid cell. */
interface SelectionGridMember {
  fixture: types.FixtureRef;
  index: number;
  invert: boolean;
  projectedCoord: types.ProjectedCoord;
}

/** Display-ready cell for one projected X/Y coordinate at the active Z layer. */
interface SelectionGridCell {
  x: number;
  y: number;
  z: number;
  members: SelectionGridMember[];
  occupied: boolean;
  inverted: boolean;
  active: boolean;
  fixtureElement: boolean;
}

/** Display-ready row for the active Z layer. */
interface SelectionGridRow {
  y: number;
  cells: SelectionGridCell[];
}

/** Display-ready grid for one projected Z layer. */
export interface SelectionGridLayer {
  z: number;
  xValues: number[];
  yValues: number[];
  rows: SelectionGridRow[];
}

/** Convert generated projection bounds into panel-friendly camel-case bounds. */
function normalizeProjectionBounds(
  bounds: types.ProjectionBounds,
): SelectionGridBounds {
  return {
    minX: bounds.min_x,
    maxX: bounds.max_x,
    minY: bounds.min_y,
    maxY: bounds.max_y,
    minZ: bounds.min_z,
    maxZ: bounds.max_z,
  };
}

/** Return every integer value in an inclusive range, preserving descending bounds. */
function inclusiveRange(min: number, max: number): number[] {
  const values: number[] = [];
  if (max < min) return values;
  for (let value = min; value <= max; value += 1) {
    values.push(value);
  }
  return values;
}

/** Derive inclusive projection bounds from resolved selection indexes. */
export function deriveSelectionGridBounds(
  resolved: types.ResolvedSelection | null | undefined,
): SelectionGridBounds | null {
  if (!resolved) return null;
  if (resolved.projection_bounds) {
    return normalizeProjectionBounds(resolved.projection_bounds);
  }

  let bounds: SelectionGridBounds | null = null;
  for (const index of resolved.indexes) {
    for (const member of index.members) {
      const coord = member.projected_coord;
      bounds = bounds
        ? {
            minX: Math.min(bounds.minX, coord.x),
            maxX: Math.max(bounds.maxX, coord.x),
            minY: Math.min(bounds.minY, coord.y),
            maxY: Math.max(bounds.maxY, coord.y),
            minZ: Math.min(bounds.minZ, coord.z),
            maxZ: Math.max(bounds.maxZ, coord.z),
          }
        : {
            minX: coord.x,
            maxX: coord.x,
            minY: coord.y,
            maxY: coord.y,
            minZ: coord.z,
            maxZ: coord.z,
          };
    }
  }
  return bounds;
}

/** List selectable Z layers for a resolved selection. */
export function listSelectionZLayers(
  resolved: types.ResolvedSelection | null | undefined,
): number[] {
  const bounds = deriveSelectionGridBounds(resolved);
  if (!bounds) return [];
  return inclusiveRange(bounds.minZ, bounds.maxZ);
}

/** Build a 2D X/Y grid for a single projected Z layer. */
export function buildSelectionGridLayer(
  resolved: types.ResolvedSelection | null | undefined,
  z: number,
  activeIndex: number | null | undefined,
): SelectionGridLayer | null {
  const bounds = deriveSelectionGridBounds(resolved);
  if (!resolved || !bounds) return null;

  const xValues = inclusiveRange(bounds.minX, bounds.maxX);
  const yValues = inclusiveRange(bounds.minY, bounds.maxY);
  const membersByCell = new Map<string, SelectionGridMember[]>();

  for (const index of resolved.indexes) {
    for (const member of index.members) {
      if (member.projected_coord.z !== z) continue;
      const key = `${member.projected_coord.x}:${member.projected_coord.y}`;
      const entries = membersByCell.get(key) ?? [];
      entries.push({
        fixture: member.fixture,
        index: index.index,
        invert: index.invert,
        projectedCoord: member.projected_coord,
      });
      membersByCell.set(key, entries);
    }
  }

  return {
    z,
    xValues,
    yValues,
    rows: yValues.map((y) => ({
      y,
      cells: xValues.map((x) => {
        const members = membersByCell.get(`${x}:${y}`) ?? [];
        return {
          x,
          y,
          z,
          members,
          occupied: members.length > 0,
          inverted: members.some((member) => member.invert),
          active: members.some((member) => member.index === activeIndex),
          fixtureElement: members.some(
            (member) => member.fixture.index != null,
          ),
        };
      }),
    })),
  };
}

/** Clamp a step index to a valid resolved-selection index array position. */
export function clampSelectionStep(
  requestedStep: number,
  resolved: types.ResolvedSelection | null | undefined,
): number {
  const count = resolved?.indexes.length ?? 0;
  if (count === 0) return 0;
  return Math.max(0, Math.min(count - 1, requestedStep));
}

/** Return the resolved SelectionIndex object for a panel step position. */
export function getSelectionIndexAtStep(
  resolved: types.ResolvedSelection | null | undefined,
  step: number,
): types.SelectionIndex | null {
  if (!resolved || resolved.indexes.length === 0) return null;
  return resolved.indexes[clampSelectionStep(step, resolved)] ?? null;
}

/** Convert an active resolved selection span into visualizer selection targets. */
export function selectionTargetsForStep(
  resolved: types.ResolvedSelection | null | undefined,
  step: number,
): SelectionTarget[] {
  const index = getSelectionIndexAtStep(resolved, step);
  if (!index) return [];
  return index.members.map((member) => {
    const target: SelectionTarget = {
      fixtureUid: member.fixture.fixture_uid,
    };
    if (member.fixture.index != null) {
      target.elementIndex = member.fixture.index;
    }
    return target;
  });
}

/** Format a fixture reference for compact grid labels. */
export function formatFixtureRefLabel(
  fixtureMap: Record<string, types.Fixture>,
  fixtureRef: types.FixtureRef,
): string {
  const fixture = fixtureMap[fixtureRef.fixture_uid];
  const base = fixture
    ? String(fixture.identifiers.id)
    : fixtureRef.fixture_uid.slice(0, 8);
  return fixtureRef.index != null ? `${base}.${fixtureRef.index}` : base;
}
