// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as types from "../types";
import { setAttributeMetadata } from "./attribute-metadata";
import { GridCellKind } from "./data-grid-types";
import {
  applyParkedIndicator,
  buildParkedParameterLookup,
  isAttributeParked,
  isRowParked,
  parkCommandForRefs,
  parkedEntriesForCell,
  parkedParameterKeys,
} from "./parked-parameters";

/** Builds one parked entry for a fixture element and attribute. */
function parked(
  fixtureUid: string,
  index: number,
  attribute: types.Attribute,
  value = 0.5,
): types.ParkedParameter {
  return { element: { fixture_uid: fixtureUid, index }, attribute, value };
}

const entries = [
  parked("a", 1, { type: "Pan" }),
  parked("a", 2, { type: "Pan" }),
  parked("b", 1, { type: "VirtualIntensity" }),
  parked("b", 1, {
    type: "Custom",
    data: { label: "Macro Speed" },
  } as types.Attribute),
];

/** Verifies an element row matches only the parked entry of that exact element and attribute. */
test("element rows find only their own parked entry", () => {
  const lookup = buildParkedParameterLookup(entries);
  assert.deepEqual(parkedEntriesForCell(lookup, "a", 2, "Pan"), [entries[1]]);
  assert.deepEqual(parkedEntriesForCell(lookup, "a", 3, "Pan"), []);
  assert.deepEqual(parkedEntriesForCell(lookup, "a", 1, "Tilt"), []);
});

/** Verifies a fixture row gathers the parked entries of every element for its attribute. */
test("fixture rows collect every parked element of the attribute", () => {
  const lookup = buildParkedParameterLookup(entries);
  assert.deepEqual(parkedEntriesForCell(lookup, "a", undefined, "Pan"), [
    entries[0],
    entries[1],
  ]);
});

/** Verifies virtual intensity and custom attributes are found under the names grid columns use. */
test("virtual intensity and custom attributes match the grid's column names", () => {
  const lookup = buildParkedParameterLookup(entries);
  assert.deepEqual(parkedEntriesForCell(lookup, "b", 1, "Intensity"), [
    entries[2],
  ]);
  assert.deepEqual(parkedEntriesForCell(lookup, "b", 1, "Macro Speed"), [
    entries[3],
  ]);
});

/** Verifies the parked-only view keeps exactly the parked rows and parked attribute columns. */
test("the parked-only filter keeps parked rows and attribute columns", () => {
  const lookup = buildParkedParameterLookup(entries);
  assert.equal(isRowParked(lookup, "a", undefined), true);
  assert.equal(isRowParked(lookup, "a", 2), true);
  assert.equal(isRowParked(lookup, "a", 3), false);
  assert.equal(isRowParked(lookup, "c", undefined), false);
  assert.equal(isAttributeParked(lookup, "Pan"), true);
  assert.equal(isAttributeParked(lookup, "Intensity"), true);
  assert.equal(isAttributeParked(lookup, "Macro Speed"), true);
  assert.equal(isAttributeParked(lookup, "Tilt"), false);
});

/** Verifies a park command names each fixture ref once, types attributes, and skips empty input. */
test("park commands target each ref once with typed attributes", () => {
  setAttributeMetadata([
    {
      key: "Pan",
      attribute: { type: "Pan" },
      label: "Pan",
      category: types.AttributeCategory.Position,
      sort_order: 0,
    },
  ]);
  assert.deepEqual(
    parkCommandForRefs(
      [
        { fixture_uid: "a", index: 2 },
        { fixture_uid: "a", index: 2 },
        { fixture_uid: "b" },
      ],
      ["Pan", "Macro Speed"],
    ),
    {
      type: "Park",
      data: {
        selection: {
          source: {
            type: "Resolved",
            data: [{ fixture_uid: "a", index: 2 }, { fixture_uid: "b" }],
          },
          clauses: [],
        },
        attributes: [
          { type: "Pan" },
          { type: "Custom", data: { label: "Macro Speed" } },
        ],
      },
    },
  );
  assert.equal(parkCommandForRefs([{ fixture_uid: "a" }], []), undefined);
  assert.equal(parkCommandForRefs([], ["Pan"]), undefined);
});

/** Verifies unpark keys carry the element and attribute but not the parked value. */
test("unpark keys drop the parked value", () => {
  assert.deepEqual(parkedParameterKeys([entries[0]]), [
    { element: { fixture_uid: "a", index: 1 }, attribute: { type: "Pan" } },
  ]);
});

/** Verifies the P tag is added only when a cell has parked entries. */
test("the parked tag is added only to cells with parked entries", () => {
  const cell = {
    kind: GridCellKind.Text,
    data: "50",
    displayData: "50",
  } as const;
  assert.equal(applyParkedIndicator(cell, []), cell);
  assert.deepEqual(
    applyParkedIndicator(cell, [entries[0]]).stateIndicators?.map(
      (indicator) => indicator.tone,
    ),
    ["parked"],
  );
});
