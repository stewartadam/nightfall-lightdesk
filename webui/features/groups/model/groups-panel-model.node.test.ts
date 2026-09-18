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
  buildGroupProgrammerCommand,
  createEmptyGroup,
  groupSearchValues,
  nextAvailableGroupId,
  sortGroupsById,
} from "./groups-panel-model";

/** Creates a compact group fixture for projection tests. */
function group(id: number, label = `Group ${id}`): types.Group {
  return createEmptyGroup({ id, label }, `group-${id}`);
}

/** Verifies group sorting and gap-filling preserve stable numeric semantics. */
test("group rows sort by ID and allocate the first available ID", () => {
  const groupMap = {
    three: group(3),
    one: group(1),
  };

  const rows = sortGroupsById(groupMap);
  assert.deepEqual(
    rows.map((entry) => entry.identifiers.id),
    [1, 3],
  );
  assert.equal(nextAvailableGroupId(rows), 2);
});

/** Verifies new groups expose the expected empty-selection projection. */
test("empty group creation preserves payload and searchable fields", () => {
  const entry = createEmptyGroup({ id: 7, label: "Front Wash" }, "group-7");

  assert.deepEqual(entry.identifiers, {
    id: 7,
    uid: "group-7",
    label: "Front Wash",
  });
  assert.deepEqual(entry.selection, {
    source: { type: "Resolved", data: [] },
    clauses: [],
  });
  assert.deepEqual(groupSearchValues(entry), [7, "Front Wash", ""]);
});

/** Verifies programmer selection modifiers map to set, add, and remove commands. */
test("group programmer commands honor selection modifiers", () => {
  const plain = buildGroupProgrammerCommand(4, {
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
  });
  const additive = buildGroupProgrammerCommand(4, {
    shiftKey: true,
    ctrlKey: false,
    metaKey: false,
  });
  const subtractive = buildGroupProgrammerCommand(4, {
    shiftKey: false,
    ctrlKey: true,
    metaKey: false,
  });

  assert.equal(plain.type, "SetProgrammerSelection");
  assert.equal(additive.type, "AddProgrammerSelection");
  assert.equal(subtractive.type, "RemoveProgrammerSelection");
});
