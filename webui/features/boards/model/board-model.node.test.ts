// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { OBJECT_DRAG_MIME } from "../../../lib/object-drag";
import { type Board, ObjectType } from "../../../types";
import {
  boardExtent,
  boardTargetFromDrag,
  cellBetween,
  createDecorationElement,
  createEmptyBoard,
  createTargetElement,
  describeQuery,
  MAX_OBJECT_ID,
  nextAvailableBoardId,
} from "./board-model";

/** Builds a board holding one pinned button at the top-left cell and one frame. */
function boardWithButton(): Board {
  const board = createEmptyBoard(1, "board-1");
  board.elements = [
    createDecorationElement("Frame", { x: 0, y: 0, width: 3, height: 2 }),
    createTargetElement(
      { object_type: ObjectType.Clip, uid: "clip-1" },
      { x: 0, y: 0, width: 1, height: 1 },
    ),
  ];
  return board;
}

/** The board extent covers every element, frames included. */
test("board extent covers every element", () => {
  assert.deepEqual(boardExtent(boardWithButton()), { columns: 3, rows: 2 });
});

/** Board IDs fill the first gap. */
test("next board ID fills gaps", () => {
  const boards = [createEmptyBoard(1, "a"), createEmptyBoard(3, "b")];
  assert.equal(
    nextAvailableBoardId(boards.map((board) => board.identifiers.id)),
    2,
  );
});

/** Object drags of pinnable types become board targets; other types and payloads do not. */
test("object drags become board targets", () => {
  const drag = (mime: string, payload: unknown) => ({
    types: [mime],
    getData: (type: string) => (type === mime ? JSON.stringify(payload) : ""),
  });
  assert.deepEqual(
    boardTargetFromDrag(
      drag(OBJECT_DRAG_MIME, { object_type: ObjectType.Master, uid: "m1" }),
    ),
    { object_type: ObjectType.Master, uid: "m1" },
  );
  assert.equal(
    boardTargetFromDrag(
      drag(OBJECT_DRAG_MIME, { object_type: ObjectType.Fixture, uid: "f1" }),
    ),
    undefined,
  );
  assert.equal(boardTargetFromDrag(drag("text/plain", "hello")), undefined);
});

/** Collection headings summarize the type, ID range and label filter. */
test("queries describe their filters", () => {
  assert.equal(
    describeQuery({
      object_type: ObjectType.Blueprint,
      id_range: { first: 1, last: 10 },
      label_contains: " wash ",
    }),
    'Blueprints 1-10 "wash"',
  );
  assert.equal(describeQuery({ object_type: ObjectType.Clip }), "Clips");
  assert.equal(
    describeQuery({
      object_type: ObjectType.Group,
      id_range: { first: 5, last: MAX_OBJECT_ID },
    }),
    "Groups 5+",
  );
});

/** A dragged rectangle covers both corners whichever way it was dragged. */
test("cell rectangles span two corners", () => {
  assert.deepEqual(cellBetween({ x: 3, y: 2 }, { x: 1, y: 0 }), {
    x: 1,
    y: 0,
    width: 3,
    height: 3,
  });
});
