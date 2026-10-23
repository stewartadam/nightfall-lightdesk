// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Where board elements may go, decided by the engine's own placement rules through the
 * WebAssembly bridge, so the editor never offers a placement the engine would reject.
 *
 * The rules run synchronously during drags; {@link loadBoardPlacement} must have resolved
 * before any other function here is called.
 */

import { getLogger } from "../../../lib/logger";
import {
  loadedWasmBridge,
  loadWasmBridge,
  type WasmBridgeModule,
} from "../../../lib/wasm-module";
import type { Board, BoardCell, BoardElement } from "../../../types";
import {
  BOARD_CELL_PX,
  type BoardElementKindName,
  FALLBACK_SEARCH_COLUMNS,
  newBoardUid,
} from "./board-model";

const log = getLogger(import.meta.url);

type BridgePlacement = InstanceType<WasmBridgeModule["BoardPlacement"]>;

/** Furthest grid line an element may reach, read from the engine when the bridge loads. */
let maxDimension: number | undefined;

/** Resolves once the placement rules can be evaluated; rejects when the bridge fails to load. */
export async function loadBoardPlacement(): Promise<void> {
  const wasm = await loadWasmBridge();
  maxDimension = wasm.board_max_dimension();
}

/** Returns the loaded bridge, failing loudly when a caller skipped {@link loadBoardPlacement}. */
function bridge(): WasmBridgeModule {
  const wasm = loadedWasmBridge();
  if (!wasm) {
    throw new Error("Board placement used before the WASM bridge loaded");
  }
  return wasm;
}

/**
 * Reads `board` into the bridge, answers `query` with its placement rules and frees them. The
 * board is read on every call rather than cached: boards reach the UI through reconciled Solid
 * stores, which update the same object in place. A board the bridge cannot read is logged and
 * answered with `fallback`.
 */
function withPlacement<Result>(
  board: Board,
  fallback: Result,
  query: (placement: BridgePlacement) => Result,
): Result {
  let placement: BridgePlacement;
  try {
    placement = new (bridge().BoardPlacement)(board);
  } catch (error) {
    log.error("Board placement rejected the board:", error);
    return fallback;
  }
  try {
    return query(placement);
  } finally {
    placement.free();
  }
}

/** Returns whether `cell` fits under already-read placement rules. */
function fitsWith(
  placement: BridgePlacement,
  cell: BoardCell,
  kind: BoardElementKindName,
  ignoreUid?: string,
): boolean {
  return placement.canPlace(
    cell.x,
    cell.y,
    cell.width,
    cell.height,
    kind === "Frame",
    ignoreUid,
  );
}

/** Returns the first free cell of a size under already-read placement rules. */
function freeCellWith(
  placement: BridgePlacement,
  width: number,
  height: number,
  kind: BoardElementKindName,
  columns: number,
): BoardCell | undefined {
  return (
    placement.findFreeCell(width, height, kind === "Frame", columns) ??
    undefined
  );
}

/** Returns the furthest grid line, in cells, that a board element may reach. */
export function boardMaxDimension(): number {
  if (maxDimension === undefined) {
    throw new Error("Board placement used before the WASM bridge loaded");
  }
  return maxDimension;
}

/** Returns the grid cell under a pointer position, given the grid origin in client pixels. */
export function cellAtPoint(
  origin: Pick<DOMRect, "left" | "top">,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const lastCell = boardMaxDimension() - 1;
  const clamp = (value: number) =>
    Math.min(Math.max(Math.floor(value / BOARD_CELL_PX), 0), lastCell);
  return {
    x: clamp(clientX - origin.left),
    y: clamp(clientY - origin.top),
  };
}

/**
 * Returns whether an element of `kind` fits at `cell` on `board`: the cell must sit inside the
 * grid's bounds, and buttons, collections and labels must not overlap each other. Frames may
 * overlap anything. `ignoreUid` skips the element being moved.
 */
export function canPlaceElement(
  board: Board,
  cell: BoardCell,
  kind: BoardElementKindName,
  ignoreUid?: string,
): boolean {
  return withPlacement(board, false, (placement) =>
    fitsWith(placement, cell, kind, ignoreUid),
  );
}

/**
 * Returns the first of `candidates` where an element of `kind` fits on `board`, reading the
 * board once for all of them. `ignoreUid` skips the element being moved.
 */
export function firstFittingCell(
  board: Board,
  candidates: readonly BoardCell[],
  kind: BoardElementKindName,
  ignoreUid?: string,
): BoardCell | undefined {
  return withPlacement(board, undefined, (placement) =>
    candidates.find((cell) => fitsWith(placement, cell, kind, ignoreUid)),
  );
}

/**
 * Finds the first free cell of the given size scanning rows top to bottom within the first
 * `columns` columns (the visible width), continuing downwards when they are full. A size wider
 * than `columns` is searched at the left edge. Returns `undefined` when nothing fits.
 */
export function findFreeCell(
  board: Board,
  width: number,
  height: number,
  kind: BoardElementKindName = "Target",
  columns = FALLBACK_SEARCH_COLUMNS,
): BoardCell | undefined {
  return withPlacement(board, undefined, (placement) =>
    freeCellWith(placement, width, height, kind, columns),
  );
}

/**
 * Copies an element for pasting onto `board` under a new UID. It lands at `anchor` when one is
 * given and the element fits there, else at its original cell, else at the first free cell of
 * its size. Returns `undefined` when the board has no room for it.
 */
export function pasteElement(
  board: Board,
  element: BoardElement,
  anchor?: Pick<BoardCell, "x" | "y">,
  columns = FALLBACK_SEARCH_COLUMNS,
): BoardElement | undefined {
  const { width, height } = element.cell;
  const kind = element.kind.type;
  const candidates = anchor
    ? [{ ...anchor, width, height }, element.cell]
    : [element.cell];
  const cell = withPlacement(
    board,
    undefined,
    (placement) =>
      candidates.find((candidate) => fitsWith(placement, candidate, kind)) ??
      freeCellWith(placement, width, height, kind, columns),
  );
  return cell ? { ...element, uid: newBoardUid(), cell } : undefined;
}
