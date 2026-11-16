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
  editGroupedInstructionValue,
  ensureInstructionForFixtureRef,
  findInstructionForFixtureRef,
} from "./cue-instruction-edit";

const fixtureRef = (fixtureUid: string, index?: number): types.FixtureRef => ({
  fixture_uid: fixtureUid,
  index,
});

/** Verifies a grouped value edit preserves selection, timing fans, and other attribute values. */
test("editGroupedInstructionValue updates one element without competing assertions", () => {
  const first = fixtureRef("fixture-a", 1);
  const second = fixtureRef("fixture-b", 1);
  const instruction = ensureInstructionForFixtureRef([], first);
  instruction.selection.source = { type: "Resolved", data: [first, second] };
  const oldValue: types.ParameterValue = {
    type: "Absolute",
    data: { value: 25 },
  };
  const newValue: types.ParameterValue = {
    type: "AbsolutePercent",
    data: { value: 0.5 },
  };
  instruction.assertions.values = {
    VirtualIntensity: { type: "Inline", data: oldValue },
    Blue: { type: "Inline", data: oldValue },
  };
  instruction.assertions.transitions.fade_in = {
    type: "Interpolated",
    data: { start: { secs: 0, nanos: 0 }, end: { secs: 2, nanos: 0 } },
  };
  const before = structuredClone(instruction);
  assert.equal(
    editGroupedInstructionValue(instruction, first, "Intensity", {
      type: "Inline",
      data: newValue,
    }),
    true,
  );
  assert.deepEqual(instruction.selection, before.selection);
  assert.deepEqual(
    instruction.assertions.transitions,
    before.assertions.transitions,
  );
  assert.deepEqual(
    instruction.assertions.values.Blue,
    before.assertions.values.Blue,
  );
  assert.deepEqual(instruction.assertions.values.VirtualIntensity, {
    type: "Fanned",
    data: { values: [newValue, oldValue] },
  });
  assert.equal(instruction.assertions.values.Intensity, undefined);
});

/** Verifies editing a fan retains the sampled values at every untouched selection position. */
test("editGroupedInstructionValue preserves other fan positions on repeated edits", () => {
  const refs = [
    fixtureRef("fixture-a", 1),
    fixtureRef("fixture-b", 1),
    fixtureRef("fixture-c", 1),
  ];
  const instruction = ensureInstructionForFixtureRef([], refs[0]);
  instruction.selection.source = { type: "Resolved", data: refs };
  instruction.assertions.values.Red = {
    type: "Fanned",
    data: {
      values: [
        { type: "Absolute", data: { value: 0 } },
        { type: "Absolute", data: { value: 200 } },
      ],
    },
  };
  const edited: types.ParameterValue = {
    type: "Absolute",
    data: { value: 50 },
  };
  assert.equal(
    editGroupedInstructionValue(instruction, refs[0], "Red", {
      type: "Inline",
      data: edited,
    }),
    true,
  );
  assert.equal(
    editGroupedInstructionValue(instruction, refs[2], "Red", {
      type: "Inline",
      data: edited,
    }),
    true,
  );
  assert.deepEqual(instruction.assertions.values.Red, {
    type: "Fanned",
    data: {
      values: [edited, { type: "Absolute", data: { value: 100 } }, edited],
    },
  });
});

/** Verifies repeated tracked-row edits for one fixture reuse one instruction. */
test("ensureInstructionForFixtureRef reuses a tracked-row instruction", () => {
  const fixture = fixtureRef("fixture-a");
  const instructions: types.BoundAssertionSet[] = [];

  const firstEditInstruction = ensureInstructionForFixtureRef(
    instructions,
    fixture,
  );
  firstEditInstruction.assertions.values.Intensity = {
    type: "Inline",
    data: { type: "Absolute", data: { value: 66 } },
  };

  const secondEditInstruction = ensureInstructionForFixtureRef(
    instructions,
    fixture,
  );
  secondEditInstruction.assertions.values.White = {
    type: "Inline",
    data: { type: "Absolute", data: { value: 66 } },
  };

  assert.equal(instructions.length, 1);
  assert.equal(firstEditInstruction, secondEditInstruction);
  assert.deepEqual(Object.keys(instructions[0].assertions.values), [
    "Intensity",
    "White",
  ]);
});

/** Verifies fixture-element tracked rows do not collide with fixture-wide rows. */
test("findInstructionForFixtureRef distinguishes element references", () => {
  const wholeFixture = fixtureRef("fixture-a");
  const elementFixture = fixtureRef("fixture-a", 1);
  const instructions: types.BoundAssertionSet[] = [
    ensureInstructionForFixtureRef([], wholeFixture),
  ];

  assert.equal(
    findInstructionForFixtureRef(instructions, wholeFixture),
    instructions[0],
  );
  assert.equal(
    findInstructionForFixtureRef(instructions, elementFixture),
    undefined,
  );
});
