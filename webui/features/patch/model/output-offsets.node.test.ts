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
  fixtureOutputOffsetRows,
  offsetPercent,
  outputOffsetCommand,
} from "./output-offsets";

/** Builds a parameter fixture with only the fields offset rows read. */
function parameter(
  attribute: types.Attribute,
  offset: types.ParameterValue,
  max = 255,
): types.ParameterMetadata {
  return {
    attribute,
    offset,
    min: 0,
    max,
  } as types.ParameterMetadata;
}

const zero: types.ParameterValue = { type: "Absolute", data: { value: 0 } };

test("raw offsets convert to a percentage of the parameter's range", () => {
  assert.equal(
    offsetPercent(
      parameter({ type: "Red" }, { type: "Absolute", data: { value: 51 } }),
    ),
    20,
  );
  assert.equal(
    offsetPercent(
      parameter(
        { type: "Pan" },
        { type: "AbsolutePercent", data: { value: -0.125 } },
      ),
    ),
    -12.5,
  );
});

test("offset rows list each DMX attribute once and skip virtual parameters", () => {
  const fixture = {
    elements: [
      {
        parameters: [
          parameter(
            { type: "Red" },
            { type: "AbsolutePercent", data: { value: 0.1 } },
          ),
          parameter({ type: "VirtualIntensity" }, zero),
        ],
      },
      { parameters: [parameter({ type: "Red" }, zero)] },
    ],
  } as unknown as types.Fixture;
  assert.deepEqual(fixtureOutputOffsetRows(fixture), [
    { label: "Red", attribute: { type: "Red" }, percent: 10 },
  ]);
});

test("a zero offset is stored as no offset rather than zero percent", () => {
  assert.deepEqual(outputOffsetCommand(5, { type: "Red" }, 0).data, {
    id: 5,
    attribute: { type: "Red" },
    offset: zero,
  });
  assert.deepEqual(outputOffsetCommand(5, { type: "Red" }, 25).data, {
    id: 5,
    attribute: { type: "Red" },
    offset: { type: "AbsolutePercent", data: { value: 0.25 } },
  });
});
