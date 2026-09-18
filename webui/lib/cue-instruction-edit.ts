// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";
import { fixtureRefKey } from "./selection-resolution";
import { normalizeAttributeName } from "./utils";
import { parameterValueForValueSource } from "./value-source";

/** Creates an empty cue instruction that can receive values for one fixture ref. */
export function createCueInstructionForFixtureRef(
  ref: types.FixtureRef,
): types.BoundCueInstruction {
  return {
    selection: {
      source: {
        type: "Resolved",
        data:
          ref.index == null
            ? [{ fixture_uid: ref.fixture_uid }]
            : [{ fixture_uid: ref.fixture_uid, index: ref.index }],
      },
      clauses: [],
    },
    cue_instruction: {
      values: {},
      transitions: {},
      transitions_by_attribute: {},
      transitions_by_fixture_attribute: [],
    },
  };
}

/** Returns the single fixture ref for a simple resolved instruction row. */
export function singleResolvedInstructionFixtureRef(
  instruction: types.BoundCueInstruction,
): types.FixtureRef | undefined {
  if (instruction.selection.clauses.length > 0) return undefined;
  if (instruction.selection.source.type !== "Resolved") return undefined;
  const refs = instruction.selection.source.data;
  return refs.length === 1 ? refs[0] : undefined;
}

/**
 * Updates one scalar value in a resolved element group while retaining its selection and timing positions.
 * Existing values become one fan waypoint per target so other fixtures keep their values.
 */
export function editGroupedInstructionValue(
  instruction: types.BoundCueInstruction | undefined,
  fixtureRef: types.FixtureRef,
  attribute: string,
  source: types.ValueSource,
): boolean {
  if (!instruction || source.type !== "Inline") return false;
  const { selection, cue_instruction } = instruction;
  if (
    selection.source.type !== "Resolved" ||
    selection.source.data.length <= 1 ||
    selection.clauses.length > 0 ||
    (selection.union?.length ?? 0) > 0
  )
    return false;
  const refs = selection.source.data;
  if (
    refs.some((ref) => ref.index == null) ||
    new Set(refs.map(fixtureRefKey)).size !== refs.length
  )
    return false;
  const key = fixtureRefKey(fixtureRef);
  const position = refs.findIndex((ref) => fixtureRefKey(ref) === key);
  if (position < 0) return false;
  const valueKey = Object.keys(cue_instruction.values).find(
    (key) => normalizeAttributeName(key) === normalizeAttributeName(attribute),
  );
  if (!valueKey) return false;
  const previous = cue_instruction.values[valueKey];
  const values: types.ParameterValue[] = [];
  for (let index = 0; index < refs.length; index++) {
    const value = parameterValueForValueSource(previous, index, refs.length);
    if (!value) return false;
    values.push(fixtureRefKey(refs[index]) === key ? source.data : value);
  }
  cue_instruction.values[valueKey] = { type: "Fanned", data: { values } };
  return true;
}

/** Finds an existing cue instruction that targets exactly one fixture ref. */
export function findInstructionForFixtureRef(
  instructions: readonly types.BoundCueInstruction[],
  fixtureRef: types.FixtureRef,
): types.BoundCueInstruction | undefined {
  const targetKey = fixtureRefKey(fixtureRef);
  return instructions.find((instruction) => {
    const instructionRef = singleResolvedInstructionFixtureRef(instruction);
    return instructionRef ? fixtureRefKey(instructionRef) === targetKey : false;
  });
}

/** Returns an existing fixture instruction or appends a new empty one. */
export function ensureInstructionForFixtureRef(
  instructions: types.BoundCueInstruction[],
  fixtureRef: types.FixtureRef,
): types.BoundCueInstruction {
  const existing = findInstructionForFixtureRef(instructions, fixtureRef);
  if (existing) return existing;
  const instruction = createCueInstructionForFixtureRef(fixtureRef);
  instructions.push(instruction);
  return instruction;
}
