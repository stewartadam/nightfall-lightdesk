// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { setAttributeMetadata } from "../../../lib/attribute-metadata";
import type { ProcessedParameterValue } from "../../../lib/datagrid";
import { AttributeCategory, type Blueprint, type Cue } from "../../../types";
import {
  aggregateParentElementAssertion,
  applyBlueprintValueSource,
  blueprintValueSourceForInstruction,
  makeBlueprintInstructionsAbsolute,
  parentElementAssertionsVaried,
} from "./cue-editor-blueprint-model";
import type { CueFixtureRow } from "./cue-editor-model";

/** Builds a Blueprint containing values from two attribute categories. */
function blueprint(uid = "blueprint-5", id = 5): Blueprint {
  return {
    identifiers: { id, uid, label: id === 5 ? "Sunset" : "Alternate" },
    values: {
      Red: {
        type: "Inline",
        data: { type: "AbsolutePercent", data: { value: 0.8 } },
      },
      Pan: {
        type: "Inline",
        data: { type: "AbsolutePercent", data: { value: 0.25 } },
      },
    },
  } as unknown as Blueprint;
}

/** Builds a cue with one Color-scoped live Blueprint instruction. */
function referencedCue(): Cue {
  return {
    identifiers: { id: 1, uid: "cue-1", label: "Look" },
    instructions: [
      {
        selection: {},
        cue_instruction: {
          values: {},
          blueprint_application: {
            blueprint_uid: "blueprint-5",
            selector: {
              type: "Category",
              data: AttributeCategory.Color,
            },
          },
        },
      },
    ],
    parts: [],
  } as unknown as Cue;
}

/** Builds a minimal element row carrying one Red assertion. */
function elementRow(
  value: ProcessedParameterValue,
): Extract<CueFixtureRow, { type: "element" }> {
  return {
    type: "element",
    attributes: { abs: { Red: value }, rel: {}, release: new Set<string>() },
  } as unknown as Extract<CueFixtureRow, { type: "element" }>;
}

/** Builds a minimal element row that supports Red without asserting it. */
function emptyElementRow(): Extract<CueFixtureRow, { type: "element" }> {
  return {
    type: "element",
    applicableAttributes: new Set(["Red"]),
    attributes: { abs: {}, rel: {}, release: new Set<string>() },
  } as unknown as Extract<CueFixtureRow, { type: "element" }>;
}

/** Builds a minimal parent row over supplied element assertions. */
function parentRow(
  children: Extract<CueFixtureRow, { type: "element" }>[],
): Extract<CueFixtureRow, { type: "parent" }> {
  return {
    type: "parent",
    selectedElementRows: children,
    attributes: { abs: {}, rel: {}, release: new Set<string>() },
  } as unknown as Extract<CueFixtureRow, { type: "parent" }>;
}

setAttributeMetadata([
  {
    key: "Red",
    attribute: { type: "Red" },
    label: "Red",
    category: AttributeCategory.Color,
    sort_order: 1,
  },
  {
    key: "Pan",
    attribute: { type: "Pan" },
    label: "Pan",
    category: AttributeCategory.Position,
    sort_order: 2,
  },
]);

/** Blueprint projection decorates each resolved value instead of row-level Source text. */
test("projects Blueprint provenance onto cue values", () => {
  const storedBlueprint = blueprint();
  const instruction = referencedCue().instructions[0]!.cue_instruction;
  const source = blueprintValueSourceForInstruction(instruction, {
    "blueprint-5": storedBlueprint,
  });
  const projected = applyBlueprintValueSource(
    {
      abs: {
        Red: { value: 0.8, isPercentage: true, isRelative: false },
      },
      rel: {},
      release: new Set<string>(),
    },
    source,
  );

  assert.equal(projected.abs.Red?.blueprintSource?.blueprint_id, 5);
  assert.equal(projected.abs.Red?.blueprintSource?.blueprint_label, "Sunset");
});

/** Uniform element assertions aggregate while distinct Blueprint sources stay varied. */
test("aggregates parent Blueprint values without conflating sources", () => {
  const source = blueprintValueSourceForInstruction(
    referencedCue().instructions[0]!.cue_instruction,
    { "blueprint-5": blueprint() },
  );
  const value = {
    value: 0.8,
    isPercentage: true,
    isRelative: false,
    blueprintSource: source,
  } satisfies ProcessedParameterValue;
  const uniform = parentRow([elementRow(value), elementRow({ ...value })]);

  assert.equal(aggregateParentElementAssertion(uniform, "Red")?.value, 0.8);
  assert.equal(parentElementAssertionsVaried(uniform, "Red"), false);

  const mixedBlockMarkers = parentRow([
    elementRow({ ...value, marker: "block" }),
    elementRow({ ...value }),
  ]);
  assert.deepEqual(aggregateParentElementAssertion(mixedBlockMarkers, "Red"), {
    ...value,
    marker: undefined,
  });
  assert.equal(parentElementAssertionsVaried(mixedBlockMarkers, "Red"), false);

  const uniformlyBlocked = parentRow([
    elementRow({ ...value, marker: "block" }),
    elementRow({ ...value, marker: "block" }),
  ]);
  assert.equal(
    aggregateParentElementAssertion(uniformlyBlocked, "Red")?.marker,
    "block",
  );
  assert.equal(parentElementAssertionsVaried(uniformlyBlocked, "Red"), false);

  const alternateSource = {
    ...source!,
    blueprint_uid: "blueprint-6",
    blueprint_id: 6,
    blueprint_label: "Alternate",
  };
  const mixed = parentRow([
    elementRow(value),
    elementRow({ ...value, blueprintSource: alternateSource }),
  ]);
  assert.equal(aggregateParentElementAssertion(mixed, "Red"), undefined);
  assert.equal(parentElementAssertionsVaried(mixed, "Red"), true);

  const partiallyAsserted = parentRow([elementRow(value), emptyElementRow()]);
  assert.equal(
    aggregateParentElementAssertion(partiallyAsserted, "Red"),
    undefined,
  );
  assert.equal(parentElementAssertionsVaried(partiallyAsserted, "Red"), true);
});

/** Making a reference absolute copies current selected values and removes its UUID link. */
test("makes selected Blueprint instructions absolute", () => {
  const cue = referencedCue();
  const changed = makeBlueprintInstructionsAbsolute(
    cue,
    [
      {
        selectionIndex: 0,
        blueprintUid: "blueprint-5",
      },
    ],
    { "blueprint-5": blueprint() },
  );

  assert.equal(changed, true);
  assert.equal(
    cue.instructions[0]?.cue_instruction.blueprint_application,
    undefined,
  );
  assert.deepEqual(Object.keys(cue.instructions[0]!.cue_instruction.values), [
    "Red",
  ]);
});
