// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ProgrammerParentRow } from "./programmer-grid-model";
import {
  buildProgrammerValueEditCommand,
  buildProgrammerValueEditCommands,
} from "./programmer-grid-model";

/** Creates a parent programmer row suitable for edit-command tests. */
function programmerRow(
  uid = "11111111111111111111111111111111",
): ProgrammerParentRow {
  return {
    type: "parent",
    uid,
    id: 311,
    name: "Programmer edit fixture",
    color: "rgb(0, 0, 0)",
    attributes: {
      absolute: {
        Red: {
          value: 42,
          isPercentage: false,
          isRelative: false,
        },
      },
      relative: {},
    },
    applicableAttributes: new Set(["Red"]),
    hasElements: false,
    isExpanded: false,
  };
}

/** Verifies percentage edits become resolved programmer instructions. */
test("buildProgrammerValueEditCommand parses a percentage cell edit", () => {
  assert.deepEqual(
    buildProgrammerValueEditCommand(programmerRow(), "Red_Value", "100%"),
    {
      type: "AddProgrammerInstruction",
      data: {
        selection: {
          source: {
            type: "Resolved",
            data: [{ fixture_uid: "11111111111111111111111111111111" }],
          },
          clauses: [],
        },
        instruction: {
          values: {
            Red: {
              type: "Inline",
              data: { type: "AbsolutePercent", data: { value: 1 } },
            },
          },
          transitions_by_attribute: {},
          transitions: {},
        },
      },
    },
  );
});

/** Verifies invalid and non-value edits do not emit programmer commands. */
test("buildProgrammerValueEditCommand rejects invalid edit targets", () => {
  const row = programmerRow();
  assert.equal(
    buildProgrammerValueEditCommand(row, "Red_Value", "not a value"),
    undefined,
  );
  assert.equal(
    buildProgrammerValueEditCommand(row, "Green_Value", "100%"),
    undefined,
  );
  assert.equal(buildProgrammerValueEditCommand(row, "name", "100%"), undefined);
});

/** Verifies compatible range edits share one instruction and resolved selection. */
test("buildProgrammerValueEditCommands batches compatible row edits", () => {
  const commands = buildProgrammerValueEditCommands([
    {
      row: programmerRow(),
      columnId: "Red_Value",
      input: "100%",
    },
    {
      row: programmerRow("22222222222222222222222222222222"),
      columnId: "Red_Value",
      input: "100%",
    },
  ]);

  assert.equal(commands.length, 1);
  const command = commands[0];
  assert.equal(command?.type, "AddProgrammerInstruction");
  if (command?.type !== "AddProgrammerInstruction") {
    assert.fail("expected one add-programmer-instruction command");
  }
  assert.deepEqual(command.data.selection.source, {
    type: "Resolved",
    data: [
      { fixture_uid: "11111111111111111111111111111111" },
      { fixture_uid: "22222222222222222222222222222222" },
    ],
  });
});
