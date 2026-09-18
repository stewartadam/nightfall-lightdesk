// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { setAttributeMetadata } from "../../../lib/attribute-metadata";
import { AttributeCategory, type Blueprint, type Cue } from "../../../types";
import {
  blueprintAttributeGroups,
  blueprintAttributeNames,
  blueprintDependentCueCount,
  selectedBlueprintValues,
} from "./blueprint-values";

/** Builds a minimal attribute Blueprint for source-projection tests. */
function blueprint(): Blueprint {
  return {
    identifiers: { id: 5, uid: "blueprint-5", label: "Sunset" },
    values: {
      Red: { type: "Inline", data: { type: "Absolute", data: { value: 64 } } },
      Pan: { type: "Inline", data: { type: "Absolute", data: { value: 12 } } },
    },
  } as unknown as Blueprint;
}

/** Builds a cue with one complete live Blueprint application. */
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
            selector: { type: "All" },
          },
        },
      },
    ],
    parts: [],
  } as unknown as Cue;
}

/** Category selectors resolve current Blueprint membership and expose contained attributes. */
test("resolves Blueprint category values", () => {
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
  assert.deepEqual(blueprintAttributeNames(blueprint()), ["Pan", "Red"]);
  assert.deepEqual(blueprintAttributeGroups(blueprint()), [
    { category: AttributeCategory.Position, attributes: ["Pan"] },
    { category: AttributeCategory.Color, attributes: ["Red"] },
  ]);
  assert.deepEqual(
    Object.keys(
      selectedBlueprintValues(blueprint(), {
        type: "Category",
        data: AttributeCategory.Color,
      }),
    ),
    ["Red"],
  );
});

/** Dependency counts include stored cues that retain live Blueprint UUIDs. */
test("counts dependent cue definitions", () => {
  assert.equal(
    blueprintDependentCueCount("blueprint-5", { "cue-1": referencedCue() }, {}),
    1,
  );
});
