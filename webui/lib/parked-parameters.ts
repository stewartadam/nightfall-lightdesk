// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";
import { commandAttributeForName } from "./attribute-metadata";
import type { GridCell, GridCellStateIndicator } from "./data-grid-types";
import { resolvedSpatialSelection } from "./resolved-selection";
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
  /** Keys of the fixtures and fixture elements that have at least one parked parameter. */
  rows: ReadonlySet<string>;
  /** Displayed attribute names that are parked on at least one element. */
  attributes: ReadonlySet<string>;
}

/** The empty lookup, for grids rendered before the first park update arrives. */
export const EMPTY_PARKED_PARAMETER_LOOKUP: ParkedParameterLookup = {
  byElement: new Map(),
  byFixture: new Map(),
  rows: new Set(),
  attributes: new Set(),
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

/** Builds the key of a fixture row, or of one of its element rows, in a parked lookup. */
function rowKey(fixtureUid: string, elementIndex: number | undefined): string {
  return elementIndex === undefined
    ? fixtureUid
    : `${fixtureUid}|${elementIndex}`;
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
  const rows = new Set<string>();
  const attributes = new Set<string>();
  for (const entry of entries) {
    // The engine only holds entries that name an element, so skip any that don't.
    if (entry.element.index === undefined) continue;
    const attribute = parkedAttributeName(entry.attribute);
    const fixtureUid = entry.element.fixture_uid;
    rows.add(rowKey(fixtureUid, undefined));
    rows.add(rowKey(fixtureUid, entry.element.index));
    attributes.add(attribute);
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
  return { byElement, byFixture, rows, attributes };
}

/**
 * Returns whether a grid row has anything parked: any element of the fixture on a fixture row, or
 * the element itself on an element row.
 */
export function isRowParked(
  lookup: ParkedParameterLookup,
  fixtureUid: string,
  elementIndex: number | undefined,
): boolean {
  return lookup.rows.has(rowKey(fixtureUid, elementIndex));
}

/** Returns whether any element has the attribute behind a fixture grid column parked. */
export function isAttributeParked(
  lookup: ParkedParameterLookup,
  attribute: string,
): boolean {
  return lookup.attributes.has(normalizeAttributeName(attribute));
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

/**
 * Builds the command that parks the named attributes of these fixtures or fixture elements at the
 * value each one outputs right now. A fixture ref parks every element, and `Intensity` parks a
 * virtual intensity where the element has no dimmer. Returns `undefined` when there is nothing to
 * park.
 */
export function parkCommandForRefs(
  refs: readonly types.FixtureRef[],
  attributes: readonly string[],
): types.ParkCommand | undefined {
  const selection = resolvedSpatialSelection(refs);
  if (attributes.length === 0 || !selection) return undefined;
  return {
    type: "Park",
    data: { selection, attributes: attributes.map(commandAttributeForName) },
  };
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
