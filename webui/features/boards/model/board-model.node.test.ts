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
  BOARD_CELL_PX,
  boardExtent,
  boardTargetFromDrag,
  canPlaceElement,
  cellAtPoint,
  cellBetween,
  createDecorationElement,
  createEmptyBoard,
  createTargetElement,
  describeQuery,
  findFreeCell,
  MAX_BOARD_DIMENSION,
  MAX_OBJECT_ID,
  nextAvailableBoardId,
  pasteElement,
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

/** Placement follows the engine: buttons cannot overlap each other, frames overlap freely. */
test("placement rejects overlapping buttons but allows frames", () => {
  const board = boardWithButton();
  const occupied = { x: 0, y: 0, width: 1, height: 1 };
  assert.equal(canPlaceElement(board, occupied, "Target"), false);
  assert.equal(canPlaceElement(board, occupied, "Frame"), true);
  assert.equal(
    canPlaceElement(board, occupied, "Target", board.elements?.[1]?.uid),
    true,
  );
  assert.equal(
    canPlaceElement(
      board,
      { x: MAX_BOARD_DIMENSION - 1, y: 0, width: 2, height: 1 },
      "Target",
    ),
    false,
  );
});

/**
 * Free-cell search skips occupied cells within the searched columns and continues on the next
 * rows once they are full; the board extent covers every element.
 */
test("free cells skip occupied space and continue below", () => {
  const board = boardWithButton();
  assert.deepEqual(findFreeCell(board, 1, 1), {
    x: 1,
    y: 0,
    width: 1,
    height: 1,
  });
  assert.deepEqual(findFreeCell(board, 2, 1, "Target", 1), {
    x: 0,
    y: 1,
    width: 2,
    height: 1,
  });
  assert.equal(findFreeCell(board, MAX_BOARD_DIMENSION + 1, 1), undefined);
  assert.deepEqual(boardExtent(board), { columns: 3, rows: 2 });
});

/** Board IDs fill the first gap. */
test("next board ID fills gaps", () => {
  const boards = [createEmptyBoard(1, "a"), createEmptyBoard(3, "b")];
  assert.equal(
    nextAvailableBoardId(boards.map((board) => board.identifiers.id)),
    2,
  );
});

/** Pointer positions map to fixed-size cells from the grid origin and clamp to the board. */
test("pointer positions map to cells", () => {
  const origin = { left: 10, top: 20 };
  assert.deepEqual(
    cellAtPoint(origin, 10 + BOARD_CELL_PX * 2 + 1, 20 + BOARD_CELL_PX - 1),
    { x: 2, y: 0 },
  );
  assert.deepEqual(cellAtPoint(origin, 1e6, -10), {
    x: MAX_BOARD_DIMENSION - 1,
    y: 0,
  });
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

/** Pasted elements get a new UID and land at the anchor, the original cell, or a free cell. */
test("pasted elements find room on the board", () => {
  const board = boardWithButton();
  const button = board.elements?.[1];
  assert.ok(button);
  const atAnchor = pasteElement(board, button, { x: 4, y: 1 });
  assert.notEqual(atAnchor?.uid, button.uid);
  assert.deepEqual(atAnchor?.cell, { x: 4, y: 1, width: 1, height: 1 });
  const fallback = pasteElement(board, button);
  assert.deepEqual(fallback?.cell, { x: 1, y: 0, width: 1, height: 1 });
  assert.equal(
    pasteElement(board, {
      ...button,
      cell: { ...button.cell, width: MAX_BOARD_DIMENSION + 1 },
    }),
    undefined,
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
