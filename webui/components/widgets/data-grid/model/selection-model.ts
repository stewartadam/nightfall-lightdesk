// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {
  GridSelection,
  Item,
  Rectangle,
} from "../../../../lib/data-grid-types";
import { CompactSelection } from "../../../../lib/data-grid-types";

type SelectionRange = NonNullable<GridSelection["current"]>["range"];
type SelectionCurrent = GridSelection["current"];

interface DragSelection {
  anchor: Item;
  append: boolean;
  baseSelection?: NonNullable<SelectionCurrent>;
  rangeStack: NonNullable<SelectionCurrent>["rangeStack"];
  moved: boolean;
  subtract: boolean;
}

export interface DataGridSelectionState {
  activeCell?: Item;
  selectionAnchor?: Item;
  selectedRows: number[];
  selectedColumns: CompactSelection;
  current?: SelectionCurrent;
  rowSelectionAnchor?: number;
  rowSelectionExtent?: number;
  columnSelectionAnchor?: number;
  columnSelectionExtent?: number;
  drag?: DragSelection;
  externalSelection?: GridSelection;
}

export type DataGridSelectionAction =
  | { type: "syncExternalSelection"; selection: GridSelection | undefined }
  | {
      type: "selectCell";
      target: Item;
      append?: boolean;
      extend: boolean;
      preserveSelectedRows?: boolean;
    }
  | {
      type: "selectRows";
      rows: number[];
      anchor?: number;
      extent?: number;
      preserveActiveCell?: boolean;
    }
  | {
      type: "selectColumnRange";
      start: number;
      endExclusive: number;
      activeRow?: number;
    }
  | { type: "selectActiveRow" }
  | { type: "extendRowSelection"; direction: -1 | 1; rowCount: number }
  | { type: "extendColumnSelection"; direction: -1 | 1; columnCount: number }
  | { type: "toggleRow"; row: number; extend: boolean }
  | { type: "beginDrag"; target: Item; append: boolean }
  | { type: "dragTo"; target: Item }
  | { type: "endDrag" }
  | { type: "setActiveCell"; cell: Item | undefined }
  | { type: "deleteSelection"; selection: GridSelection };

export const initialDataGridSelectionState: DataGridSelectionState = {
  selectedRows: [],
  selectedColumns: CompactSelection.empty(),
};

/** Builds a rectangular selection range spanning two grid cells. */
function rangeFromCells(anchor: Item, target: Item): Rectangle {
  const x = Math.min(anchor[0], target[0]);
  const y = Math.min(anchor[1], target[1]);
  return {
    x,
    y,
    width: Math.abs(anchor[0] - target[0]) + 1,
    height: Math.abs(anchor[1] - target[1]) + 1,
  };
}

/** Returns whether two cell coordinates point at the same grid cell. */
function sameCell(lhs: Item, rhs: Item): boolean {
  return lhs[0] === rhs[0] && lhs[1] === rhs[1];
}

/** Builds a one-cell selection range. */
function singleCellRange(cell: Item): Rectangle {
  return {
    x: cell[0],
    y: cell[1],
    width: 1,
    height: 1,
  };
}

/** Returns whether a cell coordinate falls inside a selection range. */
function cellInRange(range: SelectionRange, cell: Item): boolean {
  return (
    cell[0] >= range.x &&
    cell[0] < range.x + range.width &&
    cell[1] >= range.y &&
    cell[1] < range.y + range.height
  );
}

/** Returns whether two rectangular selection ranges overlap. */
function rangesIntersect(lhs: SelectionRange, rhs: SelectionRange): boolean {
  return (
    lhs.x < rhs.x + rhs.width &&
    lhs.x + lhs.width > rhs.x &&
    lhs.y < rhs.y + rhs.height &&
    lhs.y + lhs.height > rhs.y
  );
}

/** Subtracts one rectangular range from another, returning remaining pieces. */
function removeRangeFromRange(
  range: SelectionRange,
  removed: SelectionRange,
): SelectionRange[] {
  if (!rangesIntersect(range, removed)) return [range];

  const ranges: SelectionRange[] = [];
  const right = range.x + range.width;
  const bottom = range.y + range.height;
  const removedLeft = Math.max(range.x, removed.x);
  const removedRight = Math.min(right, removed.x + removed.width);
  const removedTop = Math.max(range.y, removed.y);
  const removedBottom = Math.min(bottom, removed.y + removed.height);

  if (removedTop > range.y) {
    ranges.push({
      x: range.x,
      y: range.y,
      width: range.width,
      height: removedTop - range.y,
    });
  }

  if (removedBottom < bottom) {
    ranges.push({
      x: range.x,
      y: removedBottom,
      width: range.width,
      height: bottom - removedBottom,
    });
  }

  if (removedLeft > range.x) {
    ranges.push({
      x: range.x,
      y: removedTop,
      width: removedLeft - range.x,
      height: removedBottom - removedTop,
    });
  }

  if (removedRight < right) {
    ranges.push({
      x: removedRight,
      y: removedTop,
      width: right - removedRight,
      height: removedBottom - removedTop,
    });
  }

  return ranges;
}

/** Returns whether the current selection includes a specific cell. */
export function selectionIncludesCell(
  current: NonNullable<GridSelection["current"]>,
  cell: Item,
): boolean {
  return [current.range, ...current.rangeStack].some((range) =>
    cellInRange(range, cell),
  );
}

/** Reconstructs grid selection state from one or more rectangular ranges. */
function selectionFromRanges(
  ranges: readonly SelectionRange[],
): GridSelection["current"] | undefined {
  const range = ranges[0];
  if (!range) return undefined;

  return {
    cell: [range.x, range.y],
    range,
    rangeStack: ranges.slice(1),
  };
}

/** Removes a rectangular range from the current selection. */
function removeRangeFromSelection(
  current: NonNullable<GridSelection["current"]>,
  removed: SelectionRange,
): GridSelection["current"] | undefined {
  const ranges = [current.range, ...current.rangeStack];
  if (!ranges.some((range) => rangesIntersect(range, removed))) {
    return current;
  }

  const remainingRanges = ranges.flatMap((range) =>
    removeRangeFromRange(range, removed),
  );
  return selectionFromRanges(remainingRanges);
}

/** Returns whether any current selection range intersects a row. */
function selectionIncludesRow(
  current: NonNullable<GridSelection["current"]>,
  row: number,
): boolean {
  return [current.range, ...current.rangeStack].some(
    (range) => row >= range.y && row < range.y + range.height,
  );
}

/** Removes all selected cells in one row from the current selection. */
function removeRowFromSelection(
  current: NonNullable<GridSelection["current"]>,
  row: number,
): GridSelection["current"] | undefined {
  if (!selectionIncludesRow(current, row)) return current;

  const remainingRanges = [current.range, ...current.rangeStack].flatMap(
    (range) => {
      if (row < range.y || row >= range.y + range.height) return [range];
      return removeRangeFromRange(range, {
        x: range.x,
        y: row,
        width: range.width,
        height: 1,
      });
    },
  );
  return selectionFromRanges(remainingRanges);
}

/** Removes one cell from the current selection. */
function removeCellFromSelection(
  current: NonNullable<GridSelection["current"]>,
  cell: Item,
): GridSelection["current"] | undefined {
  return removeRangeFromSelection(current, singleCellRange(cell));
}

/** Builds the public grid selection object from row, column, and cell state. */
function buildSelection(
  current: GridSelection["current"] | undefined,
  rows: number[],
  columns: CompactSelection = CompactSelection.empty(),
): GridSelection {
  return {
    columns,
    rows: CompactSelection.fromArray(rows),
    ...(current ? { current } : {}),
  };
}

/** Expands a compact selection into sorted numeric indexes. */
function compactSelectionIndices(selection: CompactSelection): number[] {
  const indices: number[] = [];
  for (const index of selection) {
    indices.push(index);
  }
  return indices;
}

/** Extracts selected row indexes from optional grid selection state. */
function selectedRowsFrom(selection: GridSelection | undefined): number[] {
  if (!selection) return [];
  return compactSelectionIndices(selection.rows);
}

/** Extracts selected column indexes from optional grid selection state. */
function selectedColumnsFrom(selection: GridSelection | undefined): number[] {
  if (!selection) return [];
  return compactSelectionIndices(selection.columns);
}

/** Returns whether a cell is covered by the active selection range stack. */
export function isSelectedCell(
  current: GridSelection["current"] | undefined,
  col: number,
  row: number,
): boolean {
  if (!current) return false;
  const inRange =
    col >= current.range.x &&
    col < current.range.x + current.range.width &&
    row >= current.range.y &&
    row < current.range.y + current.range.height;
  if (inRange) return true;

  return current.rangeStack.some(
    (range) =>
      col >= range.x &&
      col < range.x + range.width &&
      row >= range.y &&
      row < range.y + range.height,
  );
}

/** Builds the inclusive row index list between two row endpoints. */
function rowsBetween(anchor: number, extent: number): number[] {
  const start = Math.min(anchor, extent);
  const end = Math.max(anchor, extent);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

/** Returns the current cell/range selection after controlled props are applied. */
export function effectiveCurrentSelection(
  state: DataGridSelectionState,
): SelectionCurrent {
  return state.externalSelection?.current ?? state.current;
}

/** Returns selected row indexes after controlled props are merged in. */
export function effectiveSelectedRows(state: DataGridSelectionState): number[] {
  return [
    ...new Set([
      ...state.selectedRows,
      ...selectedRowsFrom(state.externalSelection),
    ]),
  ].sort((left, right) => left - right);
}

/** Returns selected column indexes after controlled props are merged in. */
export function effectiveSelectedColumns(
  state: DataGridSelectionState,
): number[] {
  return [
    ...new Set([
      ...compactSelectionIndices(state.selectedColumns),
      ...selectedColumnsFrom(state.externalSelection),
    ]),
  ].sort((left, right) => left - right);
}

/** Builds the public selection represented by the reducer-owned state. */
export function selectionFromState(
  state: DataGridSelectionState,
): GridSelection {
  return buildSelection(
    state.current,
    state.selectedRows,
    state.selectedColumns,
  );
}

/** Builds the selection passed to edit commits, preserving legacy controlled-current behavior. */
export function editCommitSelectionFromState(
  state: DataGridSelectionState,
): GridSelection {
  return buildSelection(
    effectiveCurrentSelection(state),
    effectiveSelectedRows(state),
    CompactSelection.fromArray(effectiveSelectedColumns(state)),
  );
}

/** Builds the selection passed to delete handlers, including controlled rows. */
export function deleteSelectionFromState(
  state: DataGridSelectionState,
): GridSelection {
  return buildSelection(
    effectiveCurrentSelection(state),
    effectiveSelectedRows(state),
    CompactSelection.fromArray(effectiveSelectedColumns(state)),
  );
}

/** Applies a grid selection action to the single reducer-owned selection state. */
export function reduceDataGridSelection(
  state: DataGridSelectionState,
  action: DataGridSelectionAction,
): DataGridSelectionState {
  switch (action.type) {
    case "syncExternalSelection":
      return syncExternalSelection(state, action.selection);
    case "selectCell":
      return selectCellState(state, action.target, {
        append: action.append,
        extend: action.extend,
        preserveSelectedRows: action.preserveSelectedRows,
      });
    case "selectRows":
      return selectRowsState(state, action.rows, action);
    case "selectColumnRange":
      return selectColumnRangeState(
        state,
        action.start,
        action.endExclusive,
        action.activeRow,
      );
    case "selectActiveRow":
      return selectActiveRowState(state);
    case "extendRowSelection":
      return extendRowSelectionState(state, action.direction, action.rowCount);
    case "extendColumnSelection":
      return extendColumnSelectionState(
        state,
        action.direction,
        action.columnCount,
      );
    case "toggleRow":
      return toggleRowSelectionState(state, action.row, action.extend);
    case "beginDrag":
      return beginDragSelectionState(state, action.target, action.append);
    case "dragTo":
      return dragSelectionToState(state, action.target);
    case "endDrag":
      return { ...state, drag: undefined };
    case "setActiveCell":
      return { ...state, activeCell: action.cell };
    case "deleteSelection":
      return {
        ...state,
        current: action.selection.current,
        selectedRows: selectedRowsFrom(action.selection),
        selectedColumns: action.selection.columns,
      };
  }
}

/** Returns whether a reduced action should notify onGridSelectionChange. */
export function selectionActionPublishes(
  action: DataGridSelectionAction,
): boolean {
  return (
    action.type === "selectCell" ||
    action.type === "selectRows" ||
    action.type === "selectColumnRange" ||
    action.type === "selectActiveRow" ||
    action.type === "extendRowSelection" ||
    action.type === "extendColumnSelection" ||
    action.type === "toggleRow" ||
    action.type === "dragTo" ||
    action.type === "deleteSelection"
  );
}

/** Mirrors controlled selection into reducer state without publishing. */
function syncExternalSelection(
  state: DataGridSelectionState,
  selection: GridSelection | undefined,
): DataGridSelectionState {
  if (!selection) return { ...state, externalSelection: undefined };

  const next: DataGridSelectionState = {
    ...state,
    externalSelection: selection,
    selectedRows: selectedRowsFrom(selection),
    current: selection.current,
  };

  if (selection.current?.cell) {
    next.activeCell = selection.current.cell;
    next.selectionAnchor ??= selection.current.cell;
  }

  return next;
}

/** Clears row range anchors after cell or column selection changes. */
function withoutRowRange(
  state: DataGridSelectionState,
): DataGridSelectionState {
  return {
    ...state,
    rowSelectionAnchor: undefined,
    rowSelectionExtent: undefined,
  };
}

/** Reduces a cell selection action. */
function selectCellState(
  state: DataGridSelectionState,
  target: Item,
  options: {
    append?: boolean;
    extend: boolean;
    preserveSelectedRows?: boolean;
  },
): DataGridSelectionState {
  const previous = effectiveCurrentSelection(state);
  const existingRows = effectiveSelectedRows(state);
  const preserveSelectedRows =
    options.preserveSelectedRows !== false &&
    !options.append &&
    !options.extend &&
    existingRows.includes(target[1]);
  if (options.append && previous) {
    const current = removeCellFromSelection(previous, target);
    if (current !== previous) {
      return withoutRowRange({
        ...state,
        activeCell: current?.cell,
        selectionAnchor: current?.cell,
        current,
        selectedRows: [],
        selectedColumns: CompactSelection.empty(),
      });
    }
  }

  const anchor = options.extend
    ? (state.selectionAnchor ?? state.activeCell ?? target)
    : target;
  const range = options.extend
    ? rangeFromCells(anchor, target)
    : singleCellRange(target);
  const rangeStack = options.append
    ? previous
      ? [...previous.rangeStack, previous.range]
      : []
    : options.extend
      ? (previous?.rangeStack ?? [])
      : [];
  const current: SelectionCurrent = {
    cell: target,
    range,
    rangeStack,
  };

  return withoutRowRange({
    ...state,
    activeCell: target,
    selectionAnchor:
      options.extend || options.append ? state.selectionAnchor : target,
    current,
    selectedRows: preserveSelectedRows ? existingRows : [],
    selectedColumns: CompactSelection.empty(),
    columnSelectionAnchor: undefined,
    columnSelectionExtent: undefined,
  });
}

/** Reduces row selection actions. */
function selectRowsState(
  state: DataGridSelectionState,
  rows: number[],
  options: {
    anchor?: number;
    extent?: number;
    preserveActiveCell?: boolean;
  },
): DataGridSelectionState {
  return {
    ...state,
    activeCell: options.preserveActiveCell ? state.activeCell : undefined,
    selectionAnchor: options.preserveActiveCell
      ? state.selectionAnchor
      : undefined,
    rowSelectionAnchor: options.anchor,
    rowSelectionExtent: options.extent,
    current: undefined,
    selectedRows: rows,
    selectedColumns: CompactSelection.empty(),
    columnSelectionAnchor: undefined,
    columnSelectionExtent: undefined,
  };
}

/** Reduces column header selection actions. */
function selectColumnRangeState(
  state: DataGridSelectionState,
  start: number,
  endExclusive: number,
  activeRow = 0,
): DataGridSelectionState {
  const selectedColumns =
    endExclusive > start
      ? CompactSelection.fromSingleSelection([start, endExclusive])
      : CompactSelection.empty();
  const hasColumns = endExclusive > start;
  const activeColumn = hasColumns ? start : undefined;
  const activeCell: Item | undefined =
    activeColumn === undefined ? undefined : [activeColumn, activeRow];
  return withoutRowRange({
    ...state,
    activeCell,
    selectionAnchor: activeCell,
    current: undefined,
    selectedRows: [],
    selectedColumns,
    columnSelectionAnchor: activeColumn,
    columnSelectionExtent: hasColumns ? endExclusive - 1 : undefined,
  });
}

/** Reduces keyboard column-range extension for header-selected columns. */
function extendColumnSelectionState(
  state: DataGridSelectionState,
  direction: -1 | 1,
  columnCount: number,
): DataGridSelectionState {
  const selectedColumns = effectiveSelectedColumns(state);
  if (selectedColumns.length === 0) return state;

  const active = state.activeCell ?? effectiveCurrentSelection(state)?.cell;
  const anchor =
    state.columnSelectionAnchor ?? active?.[0] ?? selectedColumns[0] ?? 0;
  const extent =
    state.columnSelectionExtent ??
    selectedColumns[selectedColumns.length - 1] ??
    anchor;
  const nextExtent = clampSelectionIndex(extent + direction, columnCount);
  const start = Math.min(anchor, nextExtent);
  const endExclusive = Math.max(anchor, nextExtent) + 1;
  const activeCell: Item = [nextExtent, active?.[1] ?? 0];

  return withoutRowRange({
    ...state,
    activeCell,
    selectionAnchor: activeCell,
    current: undefined,
    selectedRows: [],
    selectedColumns: CompactSelection.fromSingleSelection([
      start,
      endExclusive,
    ]),
    columnSelectionAnchor: anchor,
    columnSelectionExtent: nextExtent,
  });
}

/** Reduces shift-space active row selection. */
function selectActiveRowState(
  state: DataGridSelectionState,
): DataGridSelectionState {
  const active = state.activeCell ?? effectiveCurrentSelection(state)?.cell;
  if (!active) return state;
  return selectRowsState(state, [active[1]], {
    anchor: active[1],
    extent: active[1],
    preserveActiveCell: true,
  });
}

/** Reduces keyboard row-range extension. */
function extendRowSelectionState(
  state: DataGridSelectionState,
  direction: -1 | 1,
  rowCount: number,
): DataGridSelectionState {
  if (state.selectedRows.length === 0) return state;

  const active = state.activeCell ?? effectiveCurrentSelection(state)?.cell;
  const anchor =
    state.rowSelectionAnchor ?? active?.[1] ?? state.selectedRows[0] ?? 0;
  const extent =
    state.rowSelectionExtent ??
    state.selectedRows[state.selectedRows.length - 1] ??
    anchor;
  const nextExtent = clampSelectionIndex(extent + direction, rowCount);
  return selectRowsState(state, rowsBetween(anchor, nextExtent), {
    anchor,
    extent: nextExtent,
    preserveActiveCell: true,
  });
}

/** Reduces row marker toggles and shift-range row marker selections. */
function toggleRowSelectionState(
  state: DataGridSelectionState,
  row: number,
  extend: boolean,
): DataGridSelectionState {
  const existing = new Set(effectiveSelectedRows(state));
  const current = effectiveCurrentSelection(state);
  const currentRows = state.selectedRows;
  let anchor = row;
  let extent = row;
  let nextCurrent: SelectionCurrent = state.current;
  let removedCells = false;

  if (extend && currentRows.length > 0) {
    anchor = state.rowSelectionAnchor ?? currentRows[currentRows.length - 1]!;
    extent = row;
    for (const index of rowsBetween(anchor, extent)) {
      existing.add(index);
    }
  } else if (
    existing.has(row) ||
    (current && selectionIncludesRow(current, row))
  ) {
    existing.delete(row);
    if (current && selectionIncludesRow(current, row)) {
      nextCurrent = removeRowFromSelection(current, row);
      removedCells = true;
    }
  } else {
    existing.add(row);
  }

  return {
    ...state,
    activeCell: removedCells ? nextCurrent?.cell : state.activeCell,
    selectionAnchor: removedCells ? nextCurrent?.cell : state.selectionAnchor,
    current: nextCurrent,
    rowSelectionAnchor: anchor,
    rowSelectionExtent: extent,
    selectedRows: Array.from(existing).sort((left, right) => left - right),
  };
}

/** Reduces drag-selection startup. */
function beginDragSelectionState(
  state: DataGridSelectionState,
  target: Item,
  append: boolean,
): DataGridSelectionState {
  const previous = effectiveCurrentSelection(state);
  const subtract =
    append && previous ? selectionIncludesCell(previous, target) : false;
  return {
    ...state,
    drag: {
      anchor: target,
      append,
      baseSelection: subtract && previous ? previous : undefined,
      rangeStack:
        append && previous && !subtract
          ? [...previous.rangeStack, previous.range]
          : [],
      moved: false,
      subtract,
    },
  };
}

/** Reduces drag movement across a target cell. */
function dragSelectionToState(
  state: DataGridSelectionState,
  target: Item,
): DataGridSelectionState {
  const drag = state.drag;
  if (!drag) return state;

  const moved = drag.moved || !sameCell(drag.anchor, target);
  if (!moved) return state;

  const nextDrag = { ...drag, moved };
  const range = rangeFromCells(nextDrag.anchor, target);
  const current = nextDrag.subtract
    ? nextDrag.baseSelection
      ? removeRangeFromSelection(nextDrag.baseSelection, range)
      : undefined
    : {
        cell: target,
        range,
        rangeStack: nextDrag.rangeStack,
      };

  return withoutRowRange({
    ...state,
    activeCell: current?.cell ?? target,
    selectionAnchor: nextDrag.append ? state.selectionAnchor : nextDrag.anchor,
    current,
    selectedRows: [],
    selectedColumns: CompactSelection.empty(),
    columnSelectionAnchor: undefined,
    columnSelectionExtent: undefined,
    drag: nextDrag,
  });
}

/** Clamps a row index for selection-only reducer logic. */
function clampSelectionIndex(value: number, maxExclusive: number): number {
  if (maxExclusive <= 0) return 0;
  return Math.max(0, Math.min(value, maxExclusive - 1));
}
