// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";
import type { GridCell, GridCellStateIndicator } from "./data-grid-types";
import { normalizeAttributeName } from "./utils";

/**
 * Parked parameters indexed for fixture grid cells. Element rows look up the exact element, and
 * fixture rows match when any of the fixture's elements has that attribute parked.
 */
export interface ParkedParameterLookup {
  /** Parked entries by fixture, element and displayed attribute name. */
  byElement: ReadonlyMap<string, types.ParkedParameter>;
  /** Parked entries of each fixture by displayed attribute name, across its elements. */
  byFixture: ReadonlyMap<string, types.ParkedParameter[]>;
}

/** The empty lookup, for grids rendered before the first park update arrives. */
export const EMPTY_PARKED_PARAMETER_LOOKUP: ParkedParameterLookup = {
  byElement: new Map(),
  byFixture: new Map(),
};

/** Returns the attribute name a fixture grid column uses for a typed attribute. */
export function parkedAttributeName(attribute: types.Attribute): string {
  return normalizeAttributeName(
    attribute.type === "Custom" ? attribute.data.label : attribute.type,
  );
}

/** Builds the key of one fixture element's attribute in a parked lookup. */
function elementKey(
  fixtureUid: string,
  elementIndex: number,
  attribute: string,
): string {
  return `${fixtureUid}|${elementIndex}|${normalizeAttributeName(attribute)}`;
}

/** Builds the key of one fixture's attribute across its elements in a parked lookup. */
function fixtureKey(fixtureUid: string, attribute: string): string {
  return `${fixtureUid}|${normalizeAttributeName(attribute)}`;
}

/**
 * Indexes the parked parameters the engine publishes so each grid cell can find its entries
 * without scanning the whole list.
 */
export function buildParkedParameterLookup(
  entries: readonly types.ParkedParameter[],
): ParkedParameterLookup {
  if (entries.length === 0) return EMPTY_PARKED_PARAMETER_LOOKUP;
  const byElement = new Map<string, types.ParkedParameter>();
  const byFixture = new Map<string, types.ParkedParameter[]>();
  for (const entry of entries) {
    // The engine only holds entries that name an element, so skip any that don't.
    if (entry.element.index === undefined) continue;
    const attribute = parkedAttributeName(entry.attribute);
    const fixtureUid = entry.element.fixture_uid;
    byElement.set(
      elementKey(fixtureUid, entry.element.index, attribute),
      entry,
    );
    const key = fixtureKey(fixtureUid, attribute);
    const fixtureEntries = byFixture.get(key);
    if (fixtureEntries) {
      fixtureEntries.push(entry);
    } else {
      byFixture.set(key, [entry]);
    }
  }
  return { byElement, byFixture };
}

/**
 * Returns the parked entries a grid cell shows: the element's own entry on an element row, or
 * every parked element of the fixture on a fixture row.
 */
export function parkedEntriesForCell(
  lookup: ParkedParameterLookup,
  fixtureUid: string,
  elementIndex: number | undefined,
  attribute: string,
): types.ParkedParameter[] {
  if (elementIndex === undefined) {
    return lookup.byFixture.get(fixtureKey(fixtureUid, attribute)) ?? [];
  }
  const entry = lookup.byElement.get(
    elementKey(fixtureUid, elementIndex, attribute),
  );
  return entry ? [entry] : [];
}

/** Returns the keys that unpark exactly the given parked entries. */
export function parkedParameterKeys(
  entries: readonly types.ParkedParameter[],
): types.ParameterKey[] {
  return entries.map(({ element, attribute }) => ({ element, attribute }));
}

/** The tag that marks a parked value in fixture value grids. */
const PARKED_INDICATOR: GridCellStateIndicator = {
  label: "Parked: holds this value over all playback until unparked",
  tone: "parked",
  variant: "tag",
  text: "P",
};

/** Adds the parked tag to a fixture value cell when any of its parameters is parked. */
export function applyParkedIndicator(
  cell: GridCell,
  parkedEntries: readonly types.ParkedParameter[],
): GridCell {
  if (parkedEntries.length === 0) return cell;
  return {
    ...cell,
    stateIndicators: [...(cell.stateIndicators ?? []), PARKED_INDICATOR],
  };
}
