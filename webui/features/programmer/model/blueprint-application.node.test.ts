// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  AttributeCategory,
  BlueprintResolution,
  type BlueprintSelector,
  type SpatialSelection,
} from "../../../types";
import {
  blueprintApplicationCommand,
  blueprintApplicationCommands,
} from "./blueprint-application";

/** Verifies programmer controls generate the same source model for category recall modes. */
test("blueprintApplicationCommand generates referenced and absolute category operations", () => {
  const target: BlueprintSelector = {
    type: "Category",
    data: AttributeCategory.Color,
  };
  const selection: SpatialSelection = {
    source: {
      type: "Resolved",
      data: [{ fixture_uid: "fixture-311" }],
    },
    clauses: [],
  };

  const referenced = blueprintApplicationCommand(
    5,
    [target],
    BlueprintResolution.Reference,
  );
  const absolute = blueprintApplicationCommand(
    5,
    [target],
    BlueprintResolution.Absolute,
    selection,
  );

  if (referenced?.type !== "ApplyAttributeOperations") {
    assert.fail("referenced command should apply attribute operations");
  }
  if (absolute?.type !== "ApplyAttributeOperations") {
    assert.fail("absolute command should apply attribute operations");
  }

  assert.equal(referenced.data.selection, undefined);
  assert.deepEqual(referenced.data.operations[0], {
    target,
    source: {
      type: "Blueprint",
      data: {
        address: { type: "Id", data: 5 },
        resolution: BlueprintResolution.Reference,
      },
    },
  });
  assert.deepEqual(absolute.data.selection, selection);
  assert.equal(
    absolute.data.operations[0]?.source.type === "Blueprint"
      ? absolute.data.operations[0].source.data.resolution
      : undefined,
    BlueprintResolution.Absolute,
  );
});

/** Verifies an empty target list does not emit a no-op programmer command. */
test("blueprintApplicationCommand rejects empty operation lists", () => {
  assert.equal(
    blueprintApplicationCommand(5, [], BlueprintResolution.Reference),
    undefined,
  );
});

/** Verifies disjoint fixture/attribute scopes remain separate commands. */
test("blueprintApplicationCommands preserves per-selection targets", () => {
  const red: BlueprintSelector = {
    type: "Attribute",
    data: { type: "Red" },
  };
  const blue: BlueprintSelector = {
    type: "Attribute",
    data: { type: "Blue" },
  };
  /** Builds the resolved spatial selection used by one fixture scope. */
  const selection = (fixtureUid: string): SpatialSelection => ({
    source: {
      type: "Resolved",
      data: [{ fixture_uid: fixtureUid }],
    },
    clauses: [],
  });

  const commands = blueprintApplicationCommands(
    5,
    [
      { targets: [red], selection: selection("fixture-1") },
      { targets: [blue], selection: selection("fixture-2") },
    ],
    BlueprintResolution.Reference,
  );

  assert.equal(commands.length, 2);
  assert.deepEqual(
    commands.map((command) => {
      if (command.type !== "ApplyAttributeOperations") {
        assert.fail(
          "every Blueprint command should apply attribute operations",
        );
      }
      return {
        selection: command.data.selection,
        targets: command.data.operations.map((operation) => operation.target),
      };
    }),
    [
      { selection: selection("fixture-1"), targets: [red] },
      { selection: selection("fixture-2"), targets: [blue] },
    ],
  );
});
