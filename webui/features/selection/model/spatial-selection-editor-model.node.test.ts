// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type * as types from "../../../types";
import { spatialSelectionForEditing } from "./spatial-selection-editor-model";

/** Creates the minimal group shape needed by editor reference resolution tests. */
function group(id: number, uid: string): types.Group {
  return {
    identifiers: { id, uid, label: `Group ${id}` },
    selection: {
      source: {
        type: "Fixture",
        data: { fixture_id: id, element_index: undefined },
      },
      clauses: [],
    },
    description: "",
  };
}

/** Creates the minimal fixture shape needed by resolved-source conversion tests. */
function fixture(id: number, uid: string): types.Fixture {
  return {
    identifiers: { id, uid, label: `Fixture ${id}` },
    make: "Generic",
    model: "Test",
    mode: "Default",
    elements: [],
  };
}

/** Builds a left-associated persisted group expression like the showfile stabilizer emits. */
function persistedGroupExpression(uids: readonly string[]): types.GroupRefExpr {
  const [first, ...remaining] = uids;
  return remaining.reduce<types.GroupRefExpr>(
    (lhs, uid) => ({
      type: "Add",
      data: { lhs, rhs: { type: "ByUid", data: { uid } } },
    }),
    { type: "ByUid", data: { uid: first } },
  );
}

/** Flattens additive group aliases so tests can assert their displayed ID order. */
function additiveGroupIds(reference: types.GroupRefExpr): number[] {
  if (reference.type === "ById") return [reference.data];
  if (reference.type === "Add")
    return [
      ...additiveGroupIds(reference.data.lhs),
      ...additiveGroupIds(reference.data.rhs),
    ];
  return [];
}

test("converts persisted group UUID additions to current user-facing IDs", () => {
  const groupValues = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => {
      const id = index + 3;
      const uid = `000000000000000000000000000000${id.toString().padStart(2, "0")}`;
      return [uid, group(id, uid)];
    }),
  );
  const selection: types.SpatialSelection = {
    source: {
      type: "Group",
      data: persistedGroupExpression(Object.keys(groupValues)),
    },
    clauses: [],
  };

  const editable = spatialSelectionForEditing(selection, {}, groupValues);

  assert.equal(editable.source.type, "Group");
  if (editable.source.type !== "Group") return;
  assert.deepEqual(
    additiveGroupIds(editable.source.data),
    [3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.doesNotMatch(JSON.stringify(editable), /ByUid/);
});

test("converts resolved fixture UUIDs to parser-compatible fixture aliases", () => {
  const fixtureOne = fixture(1, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const fixtureTwo = fixture(2, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  const selection: types.SpatialSelection = {
    source: {
      type: "Resolved",
      data: [
        { fixture_uid: fixtureOne.identifiers.uid },
        { fixture_uid: fixtureTwo.identifiers.uid, index: 2 },
      ],
    },
    clauses: [],
  };

  const editable = spatialSelectionForEditing(
    selection,
    {
      [fixtureOne.identifiers.uid]: fixtureOne,
      [fixtureTwo.identifiers.uid]: fixtureTwo,
    },
    {},
  );

  assert.deepEqual(editable.source, {
    type: "Add",
    data: {
      lhs: {
        type: "Fixture",
        data: { fixture_id: 1, element_index: undefined },
      },
      rhs: {
        type: "Fixture",
        data: { fixture_id: 2, element_index: 2 },
      },
    },
  });
});
