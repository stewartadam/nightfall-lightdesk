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
  instruction.cue_instruction.values = {
    VirtualIntensity: { type: "Inline", data: oldValue },
    Blue: { type: "Inline", data: oldValue },
  };
  instruction.cue_instruction.transitions.fade_in = {
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
    instruction.cue_instruction.transitions,
    before.cue_instruction.transitions,
  );
  assert.deepEqual(
    instruction.cue_instruction.values.Blue,
    before.cue_instruction.values.Blue,
  );
  assert.deepEqual(instruction.cue_instruction.values.VirtualIntensity, {
    type: "Fanned",
    data: { values: [newValue, oldValue] },
  });
  assert.equal(instruction.cue_instruction.values.Intensity, undefined);
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
  instruction.cue_instruction.values.Red = {
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
  assert.deepEqual(instruction.cue_instruction.values.Red, {
    type: "Fanned",
    data: {
      values: [edited, { type: "Absolute", data: { value: 100 } }, edited],
    },
  });
});

/** Verifies repeated tracked-row edits for one fixture reuse one instruction. */
test("ensureInstructionForFixtureRef reuses a tracked-row instruction", () => {
  const fixture = fixtureRef("fixture-a");
  const instructions: types.BoundCueInstruction[] = [];

  const firstEditInstruction = ensureInstructionForFixtureRef(
    instructions,
    fixture,
  );
  firstEditInstruction.cue_instruction.values.Intensity = {
    type: "Inline",
    data: { type: "Absolute", data: { value: 66 } },
  };

  const secondEditInstruction = ensureInstructionForFixtureRef(
    instructions,
    fixture,
  );
  secondEditInstruction.cue_instruction.values.White = {
    type: "Inline",
    data: { type: "Absolute", data: { value: 66 } },
  };

  assert.equal(instructions.length, 1);
  assert.equal(firstEditInstruction, secondEditInstruction);
  assert.deepEqual(Object.keys(instructions[0].cue_instruction.values), [
    "Intensity",
    "White",
  ]);
});

/** Verifies fixture-element tracked rows do not collide with fixture-wide rows. */
test("findInstructionForFixtureRef distinguishes element references", () => {
  const wholeFixture = fixtureRef("fixture-a");
  const elementFixture = fixtureRef("fixture-a", 1);
  const instructions: types.BoundCueInstruction[] = [
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
