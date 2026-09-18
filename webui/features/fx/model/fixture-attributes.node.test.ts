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
  getFixtureAttributes,
  getTargetFixtureAttributes,
} from "./fixture-attributes";

/** Creates the minimal fixture metadata needed to exercise attribute discovery. */
function fixture(
  id: number,
  uid: string,
  attributes: types.Attribute[],
): types.Fixture {
  return {
    identifiers: { id, uid, label: `Fixture ${id}` },
    make: "Test",
    model: "Attribute fixture",
    mode: "Default",
    elements: [
      {
        label: "Main",
        parameters: attributes.map(
          (attribute) => ({ attribute }) as types.ParameterMetadata,
        ),
      },
    ],
  };
}

/** Verifies fixture discovery preserves first-seen order and removes duplicates. */
test("getFixtureAttributes derives unique attributes across fixture elements", () => {
  const fixtures = [
    fixture(1, "11111111111111111111111111111111", [
      { type: "Intensity" },
      { type: "Pan" },
    ]),
    fixture(2, "22222222222222222222222222222222", [
      { type: "Pan" },
      { type: "Blue" },
    ]),
  ];

  assert.deepEqual(getFixtureAttributes(fixtures), [
    "Intensity",
    "Pan",
    "Blue",
  ]);
});

/** Verifies target filtering excludes attributes owned only by other fixtures. */
test("getTargetFixtureAttributes includes only concrete target fixtures", () => {
  const fixtures = [
    fixture(1, "11111111-1111-1111-1111-111111111111", [
      { type: "Intensity" },
      { type: "Pan" },
    ]),
    fixture(2, "22222222222222222222222222222222", [
      { type: "Blue" },
      { type: "Custom", data: { label: "Non-target custom" } },
    ]),
  ];

  assert.deepEqual(
    getTargetFixtureAttributes(fixtures, [
      { fixture_uid: "11111111111111111111111111111111", index: 0 },
    ]),
    ["Intensity", "Pan"],
  );
});
