// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { readObjectDragData } from "../../../lib/object-drag";
import {
  ActionSurface,
  type Board,
  type BoardCell,
  type BoardCommand,
  type BoardElement,
  type BoardElementKind,
  BoardItemState,
  type Identifiers,
  type ObjectIdentity,
  type ObjectQuery,
  ObjectType,
} from "../../../types";

/** Action ID the engine registers for board button presses. */
export const BOARD_PRESS_ACTION_ID = "board.press";
/** Side of one square grid cell in CSS pixels; elements snap to and span whole cells. */
export const BOARD_CELL_PX = 24;
/** Columns searched for free space when the visible width is unknown. */
export const FALLBACK_SEARCH_COLUMNS = 32;
/** Cells one button takes, alone or inside a collection. */
export const BUTTON_SPAN = { width: 4, height: 3 } as const;
/** Largest object ID the engine stores; a range ending here has no upper bound. */
export const MAX_OBJECT_ID = 4_294_967_295;
/** Object types a board button can press, in menu order. */
export const BOARD_TARGET_TYPES = [
  ObjectType.Clip,
  ObjectType.Group,
  ObjectType.Blueprint,
  ObjectType.Master,
  ObjectType.Macro,
] as const;

export type BoardTargetType = (typeof BOARD_TARGET_TYPES)[number];
export type BoardElementKindName = BoardElementKind["type"];

/** Singular and plural user-facing names for each board target type. */
export const BOARD_TARGET_TYPE_LABELS: Record<
  BoardTargetType,
  { one: string; many: string }
> = {
  [ObjectType.Clip]: { one: "Clip", many: "Clips" },
  [ObjectType.Group]: { one: "Group", many: "Groups" },
  [ObjectType.Blueprint]: { one: "Blueprint", many: "Blueprints" },
  [ObjectType.Master]: { one: "Master", many: "Masters" },
  [ObjectType.Macro]: { one: "Macro", many: "Macros" },
};

/** Objects of every board target type, as the identifiers the board UI needs. */
export type BoardObjectCatalog = Record<BoardTargetType, Identifiers[]>;

/** Sorts boards by numeric showfile ID without mutating the store map. */
export function sortBoardsById(
  boards: Readonly<Record<string, Board>>,
): Board[] {
  return Object.values(boards).sort(
    (left, right) => left.identifiers.id - right.identifiers.id,
  );
}

/** Returns the name a board is shown under: its label, or its number when it has none. */
export function boardDisplayName(board: Board): string {
  return board.identifiers.label.trim() || `Board ${board.identifiers.id}`;
}

/** Finds the first positive board ID not among `taken`. */
export function nextAvailableBoardId(taken: Iterable<number>): number {
  const used = new Set(taken);
  let id = 1;
  while (used.has(id)) id += 1;
  return id;
}

/** Returns a new compact UUID in the simple (dashless) form the engine stores. */
export function newBoardUid(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** Builds an empty board. */
export function createEmptyBoard(id: number, uid = newBoardUid()): Board {
  return {
    identifiers: { id, uid, label: `Board ${id}` },
    elements: [],
    shown_in_switcher: true,
  };
}

/** Returns the smallest cell rectangle covering two corner cells, in either order. */
export function cellBetween(
  start: Pick<BoardCell, "x" | "y">,
  end: Pick<BoardCell, "x" | "y">,
): BoardCell {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x,
    y,
    width: Math.abs(end.x - start.x) + 1,
    height: Math.abs(end.y - start.y) + 1,
  };
}

/** Builds a pinned button element for one object. */
export function createTargetElement(
  target: ObjectIdentity,
  cell: BoardCell,
): BoardElement {
  return {
    uid: newBoardUid(),
    cell,
    show_title: true,
    kind: { type: "Target", data: { target } },
  };
}

/** Builds a collection element showing every object of `objectType`. */
export function createCollectionElement(
  objectType: BoardTargetType,
  cell: BoardCell,
): BoardElement {
  return {
    uid: newBoardUid(),
    cell,
    show_title: true,
    kind: {
      type: "Collection",
      data: { query: { object_type: objectType }, exclusive: false },
    },
  };
}

/**
 * Builds an element that presses no object: a frame or label with a starting caption, or a
 * tempo pad, which shows the show tempo instead of a caption.
 */
export function createDecorationElement(
  type: "Frame" | "Label" | "Tempo",
  cell: BoardCell,
): BoardElement {
  const element = { uid: newBoardUid(), cell, show_title: true };
  switch (type) {
    case "Frame":
      return {
        ...element,
        label: "Frame",
        kind: { type: "Frame", data: { exclusive: false } },
      };
    case "Label":
      return { ...element, label: "Label", kind: { type: "Label" } };
    case "Tempo":
      return { ...element, kind: { type: "Tempo" } };
  }
}

/** Returns the default size, in cells, a newly added element of `type` takes. */
export function defaultElementSize(
  type: BoardElementKindName,
): Pick<BoardCell, "width" | "height"> {
  switch (type) {
    case "Collection":
      return {
        width: BUTTON_SPAN.width * 4,
        height: BUTTON_SPAN.height * 2 + 1,
      };
    case "Frame":
      return {
        width: BUTTON_SPAN.width * 3,
        height: BUTTON_SPAN.height * 2 + 1,
      };
    case "Label":
      return { width: BUTTON_SPAN.width * 2, height: 2 };
    case "Tempo":
      return { width: BUTTON_SPAN.width * 2, height: BUTTON_SPAN.height };
    case "Target":
      return { ...BUTTON_SPAN };
  }
}

/** Returns how many buttons fit side by side across a collection `width` cells wide. */
export function collectionColumns(width: number): number {
  return Math.max(1, Math.floor(width / BUTTON_SPAN.width));
}

/** Returns whether a dropped or pressed object type is one boards support. */
export function isBoardTargetType(type: ObjectType): type is BoardTargetType {
  return (BOARD_TARGET_TYPES as readonly ObjectType[]).includes(type);
}

/**
 * Reads the object a drag from another panel carries, if it is one a board can pin.
 */
export function boardTargetFromDrag(
  data: Pick<DataTransfer, "getData" | "types">,
): ObjectIdentity | undefined {
  const target = readObjectDragData(data);
  return target && isBoardTargetType(target.object_type) ? target : undefined;
}

/** Returns the columns and rows a board's elements reach, so the grid can always show them. */
export function boardExtent(board: Board): { columns: number; rows: number } {
  let columns = 0;
  let rows = 0;
  for (const element of board.elements ?? []) {
    columns = Math.max(columns, element.cell.x + element.cell.width);
    rows = Math.max(rows, element.cell.y + element.cell.height);
  }
  return { columns, rows };
}

/** Returns the lowest-ID object of `type`, so a new pinned button starts bound to a real object. */
export function firstObjectOfType(
  catalog: BoardObjectCatalog,
  type: BoardTargetType,
): ObjectIdentity | undefined {
  const [first] = [...catalog[type]].sort((left, right) => left.id - right.id);
  return first ? { object_type: type, uid: first.uid } : undefined;
}

/** Returns the user-facing summary of a collection query, such as "Blueprints 1-10 'wash'". */
export function describeQuery(query: ObjectQuery): string {
  const type = isBoardTargetType(query.object_type)
    ? BOARD_TARGET_TYPE_LABELS[query.object_type].many
    : query.object_type;
  const range = !query.id_range
    ? ""
    : query.id_range.last >= MAX_OBJECT_ID
      ? ` ${query.id_range.first}+`
      : ` ${query.id_range.first}-${query.id_range.last}`;
  const label = query.label_contains?.trim()
    ? ` "${query.label_contains.trim()}"`
    : "";
  return `${type}${range}${label}`;
}

/** Returns whether an element kind has a solo (exclusive) setting. */
export function hasSoloSetting(kind: BoardElementKind): boolean {
  return kind.type === "Collection" || kind.type === "Frame";
}

/** Returns the element with its solo flag set, for kinds that have one. */
export function withSolo(
  element: BoardElement,
  exclusive: boolean,
): BoardElement {
  const { kind } = element;
  if (kind.type === "Collection") {
    return { ...element, kind: { ...kind, data: { ...kind.data, exclusive } } };
  }
  if (kind.type === "Frame") {
    return { ...element, kind: { type: "Frame", data: { exclusive } } };
  }
  return element;
}

/** Returns whether an element's solo flag is on. */
export function isSolo(element: BoardElement): boolean {
  const { kind } = element;
  return (
    (kind.type === "Collection" || kind.type === "Frame") &&
    (kind.data.exclusive ?? false)
  );
}

/** Returns whether an element kind draws a title that can be hidden. */
export function hasTitleSetting(kind: BoardElementKind): boolean {
  return kind.type === "Collection" || kind.type === "Frame";
}

/** Returns whether a board button state reads as engaged in the UI. */
export function isEngaged(state: BoardItemState): boolean {
  return state === BoardItemState.On || state === BoardItemState.Partial;
}

/** Builds the command that creates or replaces a whole board. */
export function buildStoreBoardCommand(board: Board): BoardCommand {
  return { type: "StoreBoard", data: board };
}

/** Builds the command that adds or replaces one element. */
export function buildStoreElementCommand(
  boardId: number,
  element: BoardElement,
): BoardCommand {
  return { type: "StoreBoardElement", data: { board_id: boardId, element } };
}

/** Builds the command that removes one element. */
export function buildDeleteElementCommand(
  boardId: number,
  elementUid: string,
): BoardCommand {
  return {
    type: "DeleteBoardElement",
    data: { board_id: boardId, element_uid: elementUid },
  };
}

/** Builds the command that changes a board's label. */
export function buildSetBoardLabelCommand(
  boardId: number,
  label: string,
): BoardCommand {
  return { type: "SetBoardLabel", data: { board_id: boardId, label } };
}

/** Builds the command that lists a board in the layout switcher or hides it from there. */
export function buildSetBoardShownInSwitcherCommand(
  boardId: number,
  shown: boolean,
): BoardCommand {
  return {
    type: "SetBoardShownInSwitcher",
    data: { board_id: boardId, shown },
  };
}

/** Builds the command that changes a board's numeric ID. */
export function buildRenameBoardCommand(
  id: number,
  newId: number,
): BoardCommand {
  return { type: "RenameBoard", data: { id, new_id: newId } };
}

/** Builds the command that deletes a board. */
export function buildDeleteBoardCommand(boardId: number): BoardCommand {
  return { type: "DeleteBoard", data: boardId };
}

/** Builds the action invocation for pressing one button on a board. */
export function buildBoardPressInvocation(
  board: string,
  element: string,
  target: ObjectIdentity,
) {
  return {
    type: "Invoke" as const,
    data: {
      action: {
        id: BOARD_PRESS_ACTION_ID,
        arguments: { board, element, target },
      },
      surface: ActionSurface.Board,
    },
  };
}
