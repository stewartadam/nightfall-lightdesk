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
  instanceArrayToMap,
  undoStateMessageToStoreValue,
} from "./runtime-snapshots";

/** Creates a typed instance snapshot with only fields relevant to map conversion. */
function instance(instanceId: string): types.InstanceInfo {
  return { instance_id: instanceId } as types.InstanceInfo;
}

/** Creates a complete undo stack entry for undo snapshot conversion tests. */
function undoEntry(description: string): types.UndoStackEntryMessage {
  return {
    order: 0,
    description,
    entry_count: 1,
    age_ms: 10,
    is_gurq_preserved: false,
    undo_id: "undo-1",
    entry_descriptions: [description],
    correlation_ids: ["correlation-1"],
  };
}

test("instanceArrayToMap indexes active instances by instance id", () => {
  const first = instance("instance-a");
  const second = instance("instance-b");

  assert.deepEqual(instanceArrayToMap([first, second]), {
    "instance-a": first,
    "instance-b": second,
  });
});

test("undoStateMessageToStoreValue normalizes optional descriptions to null", () => {
  const undoStack = [undoEntry("Undo dimmer")];
  const redoStack = [undoEntry("Redo dimmer")];

  assert.deepEqual(
    undoStateMessageToStoreValue({
      can_undo: true,
      can_redo: false,
      undo_depth: 1,
      redo_depth: 1,
      undo_stack: undoStack,
      redo_stack: redoStack,
    }),
    {
      can_undo: true,
      can_redo: false,
      undo_description: null,
      redo_description: null,
      undo_depth: 1,
      redo_depth: 1,
      undo_stack: undoStack,
      redo_stack: redoStack,
    },
  );
});
