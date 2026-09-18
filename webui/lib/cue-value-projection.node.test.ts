// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type * as types from "../types";
import {
  projectCueInstructionValuesForFixtureRef,
  valueSourcePositionForFixtureRef,
} from "./cue-value-projection";

const fixtureRef = (fixtureUid: string, index?: number): types.FixtureRef => ({
  fixture_uid: fixtureUid,
  index,
});

const absoluteValue = (value: number): types.ValueSource => ({
  type: "Inline",
  data: { type: "Absolute", data: { value } },
});

/** Verifies fixture-wide values project to parent and element rows. */
test("projectCueInstructionValuesForFixtureRef applies fixture-wide values to elements", () => {
  const selectionRefs = [fixtureRef("fixture-a")];
  const values = { Intensity: absoluteValue(77) };

  assert.deepEqual(
    projectCueInstructionValuesForFixtureRef(
      values,
      selectionRefs,
      fixtureRef("fixture-a"),
    ).abs.Intensity,
    { value: 77, isPercentage: false, isRelative: false },
  );
  assert.deepEqual(
    projectCueInstructionValuesForFixtureRef(
      values,
      selectionRefs,
      fixtureRef("fixture-a", 2),
    ).abs.Intensity,
    { value: 77, isPercentage: false, isRelative: false },
  );
});

/** Verifies element-only values do not leak to parent or sibling rows. */
test("projectCueInstructionValuesForFixtureRef keeps element-only values scoped", () => {
  const selectionRefs = [fixtureRef("fixture-a", 2)];
  const values = { Intensity: absoluteValue(88) };

  assert.equal(
    projectCueInstructionValuesForFixtureRef(
      values,
      selectionRefs,
      fixtureRef("fixture-a"),
    ).abs.Intensity,
    undefined,
  );
  assert.deepEqual(
    projectCueInstructionValuesForFixtureRef(
      values,
      selectionRefs,
      fixtureRef("fixture-a", 2),
    ).abs.Intensity,
    { value: 88, isPercentage: false, isRelative: false },
  );
  assert.equal(
    projectCueInstructionValuesForFixtureRef(
      values,
      selectionRefs,
      fixtureRef("fixture-a", 1),
    ).abs.Intensity,
    undefined,
  );
});

/** Verifies fanned values use element selection positions. */
test("projectCueInstructionValuesForFixtureRef resolves fanned element values", () => {
  const selectionRefs = [
    fixtureRef("fixture-a", 1),
    fixtureRef("fixture-a", 2),
  ];
  const values: Record<string, types.ValueSource> = {
    Intensity: {
      type: "Fanned",
      data: {
        values: [
          { type: "Absolute", data: { value: 0 } },
          { type: "Absolute", data: { value: 100 } },
        ],
      },
    },
  };

  assert.equal(
    projectCueInstructionValuesForFixtureRef(
      values,
      selectionRefs,
      fixtureRef("fixture-a", 1),
    ).abs.Intensity?.value,
    0,
  );
  assert.equal(
    projectCueInstructionValuesForFixtureRef(
      values,
      selectionRefs,
      fixtureRef("fixture-a", 2),
    ).abs.Intensity?.value,
    100,
  );
});

/** Verifies exact element refs take precedence over whole-fixture selection refs. */
test("valueSourcePositionForFixtureRef prefers exact element positions", () => {
  const selectionRefs = [
    fixtureRef("fixture-a"),
    fixtureRef("fixture-a", 2),
    fixtureRef("fixture-a", 3),
  ];

  assert.equal(
    valueSourcePositionForFixtureRef(selectionRefs, fixtureRef("fixture-a", 2)),
    1,
  );
  assert.equal(
    valueSourcePositionForFixtureRef(selectionRefs, fixtureRef("fixture-a", 1)),
    0,
  );
});
