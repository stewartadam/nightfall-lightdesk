// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test, { before } from "node:test";
import { type Board, ObjectType } from "../../../types";
import {
  BOARD_CELL_PX,
  createCollectionElement,
  createDecorationElement,
  createEmptyBoard,
  createTargetElement,
} from "./board-model";
import {
  boardMaxDimension,
  canPlaceElement,
  cellAtPoint,
  findFreeCell,
  loadBoardPlacement,
  pasteElement,
} from "./board-placement";

before(() => loadBoardPlacement());

/** Builds a board holding one pinned button at the top-left cell and one frame. */
function boardWithButton(): Board {
  const board = createEmptyBoard(1);
  board.elements = [
    createDecorationElement("Frame", { x: 0, y: 0, width: 3, height: 2 }),
    createTargetElement(
      { object_type: ObjectType.Clip, uid: "0000000000000000000000000000c1c1" },
      { x: 0, y: 0, width: 1, height: 1 },
    ),
  ];
  return board;
}

/** The bridge applies the engine's rules: buttons cannot overlap each other, frames overlap freely. */
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
      { x: boardMaxDimension() - 1, y: 0, width: 2, height: 1 },
      "Target",
    ),
    false,
  );
  for (const cell of [
    { x: -1, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: -1, height: 1 },
    { x: 0.5, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: Number.NaN, height: 1 },
  ]) {
    assert.equal(canPlaceElement(board, cell, "Frame"), false);
  }
});

/**
 * Boards reach the UI through reconciled Solid stores that update the same object in place, so
 * placement must follow the board's current elements rather than an earlier reading.
 */
test("placement follows boards updated in place", () => {
  const board = boardWithButton();
  const cell = { x: 5, y: 5, width: 1, height: 1 };
  assert.equal(canPlaceElement(board, cell, "Target"), true);
  board.elements = [
    ...(board.elements ?? []),
    createTargetElement(
      { object_type: ObjectType.Clip, uid: "0000000000000000000000000000c1c2" },
      cell,
    ),
  ];
  assert.equal(canPlaceElement(board, cell, "Target"), false);
});

/** Collections block buttons like any other element, with or without query filters. */
test("collections block the cells they cover", () => {
  const board = boardWithButton();
  const collection = createCollectionElement(ObjectType.Group, {
    x: 0,
    y: 4,
    width: 4,
    height: 3,
  });
  board.elements = [...(board.elements ?? []), collection];
  const below = { x: 0, y: 7, width: 4, height: 3 };
  assert.equal(canPlaceElement(board, below, "Target"), true);
  assert.equal(canPlaceElement(board, { ...below, y: 6 }, "Target"), false);
});

/**
 * Free-cell search skips occupied cells within the searched columns and continues on the next
 * rows once they are full.
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
  assert.equal(findFreeCell(board, boardMaxDimension() + 1, 1), undefined);
});

/** Pointer positions map to fixed-size cells from the grid origin and clamp to the board. */
test("pointer positions map to cells", () => {
  const origin = { left: 10, top: 20 };
  assert.deepEqual(
    cellAtPoint(origin, 10 + BOARD_CELL_PX * 2 + 1, 20 + BOARD_CELL_PX - 1),
    { x: 2, y: 0 },
  );
  assert.deepEqual(cellAtPoint(origin, 1e6, -10), {
    x: boardMaxDimension() - 1,
    y: 0,
  });
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
      cell: { ...button.cell, width: boardMaxDimension() + 1 },
    }),
    undefined,
  );
});
