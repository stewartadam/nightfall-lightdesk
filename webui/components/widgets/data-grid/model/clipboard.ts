// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {
  GridCell,
  GridSelection,
  Item,
} from "../../../../lib/data-grid-types";
import { CompactSelection } from "../../../../lib/data-grid-types";
import {
  canEditTextCell,
  canEditTimeCell,
  cellDisplayValue,
  makeEditedCell,
  makePastedCell,
} from "./cell-utils";
import type {
  DataGridCellEdit,
  DataGridEditCommitMode,
  DataGridRichCellExtension,
} from "./types";

interface ClipboardBounds {
  minCol: number;
  maxCol: number;
  minRow: number;
  maxRow: number;
}

interface PasteEditOptions {
  selection: GridSelection;
  activeCell?: Item;
  rowCount: number;
  columnCount: number;
  text: string;
  getCellContent: (cell: Item) => GridCell;
  richCellExtensions?: readonly DataGridRichCellExtension[];
}

interface InlineEditCommitOptions {
  selection: GridSelection;
  editCell: Item;
  rowCount: number;
  columnCount: number;
  value: string;
  dirty: boolean;
  commitMode?: DataGridEditCommitMode;
  shouldCommitUnparsedTimeInput?: (value: string, cell: GridCell) => boolean;
  getCellContent: (cell: Item) => GridCell;
}

interface DiscreteEditCommitOptions {
  selection: GridSelection;
  editCell: Item;
  rowCount: number;
  columnCount: number;
  getCellContent: (cell: Item) => GridCell;
  makeEditedCell: (original: GridCell, cell: Item) => GridCell | undefined;
}

/** Creates a stable key for a cell coordinate. */
function cellKey(col: number, row: number): string {
  return `${col}:${row}`;
}

/** Clamps a selected range edge to the grid dimensions. */
function clampSelectionLimit(value: number, maxExclusive: number): number {
  return Math.max(0, Math.min(value, maxExclusive));
}

/** Adds a cell to a list only once while preserving row-major insertion order. */
function pushUniqueCell(
  cells: Item[],
  seen: Set<string>,
  col: number,
  row: number,
) {
  const key = cellKey(col, row);
  if (seen.has(key)) return;
  seen.add(key);
  cells.push([col, row]);
}

/** Expands the public grid selection into concrete selected cell coordinates. */
export function selectedClipboardCells(
  selection: GridSelection,
  rowCount: number,
  columnCount: number,
): Item[] {
  const cells: Item[] = [];
  const seen = new Set<string>();
  const ranges = selection.current
    ? [selection.current.range, ...selection.current.rangeStack]
    : [];

  for (const range of ranges) {
    const startCol = clampSelectionLimit(range.x, columnCount);
    const endCol = clampSelectionLimit(range.x + range.width, columnCount);
    const startRow = clampSelectionLimit(range.y, rowCount);
    const endRow = clampSelectionLimit(range.y + range.height, rowCount);
    for (let row = startRow; row < endRow; row += 1) {
      for (let col = startCol; col < endCol; col += 1) {
        pushUniqueCell(cells, seen, col, row);
      }
    }
  }

  const selectedRows = selection.rows.toArray();
  for (const row of selectedRows) {
    if (row < 0 || row >= rowCount) continue;
    for (let col = 0; col < columnCount; col += 1) {
      pushUniqueCell(cells, seen, col, row);
    }
  }

  const selectedColumns = selection.columns.toArray();
  for (const col of selectedColumns) {
    if (col < 0 || col >= columnCount) continue;
    for (let row = 0; row < rowCount; row += 1) {
      pushUniqueCell(cells, seen, col, row);
    }
  }

  return cells.sort((left, right) => left[1] - right[1] || left[0] - right[0]);
}

/** Returns the bounding rectangle for concrete cell coordinates. */
function boundsForCells(cells: readonly Item[]): ClipboardBounds | undefined {
  const first = cells[0];
  if (!first) return undefined;
  let minCol = first[0];
  let maxCol = first[0];
  let minRow = first[1];
  let maxRow = first[1];

  for (const [col, row] of cells) {
    minCol = Math.min(minCol, col);
    maxCol = Math.max(maxCol, col);
    minRow = Math.min(minRow, row);
    maxRow = Math.max(maxRow, row);
  }

  return { minCol, maxCol, minRow, maxRow };
}

/** Normalizes cell text so clipboard tabs and newlines preserve table structure. */
function normalizeClipboardCellText(value: string): string {
  return value.replace(/[\t\r\n]+/gu, " ");
}

/** Serializes selected grid cells as tab-separated clipboard text. */
export function clipboardTextForSelection(
  selection: GridSelection,
  rowCount: number,
  columnCount: number,
  getCellContent: (cell: Item) => GridCell,
): string | undefined {
  const cells = selectedClipboardCells(selection, rowCount, columnCount);
  const bounds = boundsForCells(cells);
  if (!bounds) return undefined;

  const selected = new Set(cells.map(([col, row]) => cellKey(col, row)));
  const rows: string[] = [];
  for (let row = bounds.minRow; row <= bounds.maxRow; row += 1) {
    const values: string[] = [];
    for (let col = bounds.minCol; col <= bounds.maxCol; col += 1) {
      if (!selected.has(cellKey(col, row))) {
        values.push("");
        continue;
      }

      const cell = getCellContent([col, row]);
      values.push(
        normalizeClipboardCellText(cell.copyData ?? cellDisplayValue(cell)),
      );
    }
    rows.push(values.join("\t"));
  }

  return rows.join("\n");
}

/** Parses plain text clipboard data as tabular rows and columns. */
export function parseClipboardText(text: string): string[][] {
  let normalized = text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
  if (normalized.endsWith("\n")) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized === "") return [[""]];
  return normalized.split("\n").map((row) => row.split("\t"));
}

/** Returns the top-left cell where a pasted clipboard matrix should land. */
function pasteAnchorFromCells(
  cells: readonly Item[],
  activeCell: Item | undefined,
): Item {
  const bounds = boundsForCells(cells);
  if (bounds) return [bounds.minCol, bounds.minRow];
  return activeCell ?? [0, 0];
}

/** Builds concrete cell edit operations for a clipboard paste. */
export function clipboardEditsForPaste(
  options: PasteEditOptions,
): DataGridCellEdit[] {
  const matrix = parseClipboardText(options.text);
  const selectedCells = selectedClipboardCells(
    options.selection,
    options.rowCount,
    options.columnCount,
  );
  const isSingleValue = matrix.length === 1 && matrix[0]?.length === 1;
  const anchor = pasteAnchorFromCells(selectedCells, options.activeCell);
  const targets =
    isSingleValue && selectedCells.length > 1
      ? selectedCells.map((cell) => ({ cell, value: matrix[0]?.[0] ?? "" }))
      : matrix.flatMap((rowValues, rowOffset) =>
          rowValues.map((value, colOffset) => {
            const [anchorCol, anchorRow] = anchor;
            return {
              cell: [anchorCol + colOffset, anchorRow + rowOffset] as Item,
              value,
            };
          }),
        );

  const edits: DataGridCellEdit[] = [];
  for (const { cell, value } of targets) {
    const [col, row] = cell;
    if (
      col < 0 ||
      col >= options.columnCount ||
      row < 0 ||
      row >= options.rowCount
    ) {
      continue;
    }

    const original = options.getCellContent(cell);
    const newValue = makePastedCell(
      original,
      value,
      options.richCellExtensions,
    );
    if (!newValue || newValue === original) continue;
    edits.push({ cell, newValue });
  }

  return edits;
}

/** Returns true when two grid coordinates point at the same cell. */
function sameCell(left: Item, right: Item): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

/** Returns whether a concrete cell list contains a target cell. */
function cellsIncludeCell(cells: readonly Item[], target: Item): boolean {
  return cells.some((cell) => sameCell(cell, target));
}

/** Expands only active range selections so row-marker selections stay panel-defined. */
function inlineEditRangeCells(
  selection: GridSelection,
  rowCount: number,
  columnCount: number,
): Item[] {
  return selectedClipboardCells(
    {
      rows: CompactSelection.empty(),
      columns: CompactSelection.empty(),
      current: selection.current,
    },
    rowCount,
    columnCount,
  );
}

/** Expands only selected columns for typed edits that originate from header selection. */
function inlineEditColumnCells(
  selection: GridSelection,
  rowCount: number,
  columnCount: number,
): Item[] {
  return selectedClipboardCells(
    {
      rows: CompactSelection.empty(),
      columns: selection.columns,
    },
    rowCount,
    columnCount,
  );
}

/** Builds inline text-edit commits, fanning typed values across multi-column cell selections. */
export function inlineEditEditsForSelection(
  options: InlineEditCommitOptions,
): DataGridCellEdit[] {
  const rangeCells = options.dirty
    ? inlineEditRangeCells(
        options.selection,
        options.rowCount,
        options.columnCount,
      )
    : [];
  const columnCells = options.dirty
    ? inlineEditColumnCells(
        options.selection,
        options.rowCount,
        options.columnCount,
      )
    : [];
  const selectedCells =
    rangeCells.length > 1 && cellsIncludeCell(rangeCells, options.editCell)
      ? rangeCells
      : columnCells.length > 1 &&
          cellsIncludeCell(columnCells, options.editCell)
        ? columnCells
        : [];
  const targets = selectedCells.length > 1 ? selectedCells : [options.editCell];

  return targets.flatMap((cell) => {
    const original = options.getCellContent(cell);
    if (!canEditTextCell(original) && !canEditTimeCell(original)) return [];
    if (options.value === cellDisplayValue(original)) return [];
    const newValue = makeEditedCell(original, options.value);
    if (
      newValue === original &&
      (!canEditTimeCell(original) ||
        !options.shouldCommitUnparsedTimeInput?.(options.value, original))
    ) {
      return [];
    }
    return [
      {
        cell,
        newValue,
        inputValue: options.value,
        commitMode: options.commitMode,
      },
    ];
  });
}

/** Builds discrete editor commits, fanning chosen values across selected cells. */
export function discreteEditEditsForSelection(
  options: DiscreteEditCommitOptions,
): DataGridCellEdit[] {
  const rangeCells = inlineEditRangeCells(
    options.selection,
    options.rowCount,
    options.columnCount,
  );
  const columnCells = inlineEditColumnCells(
    options.selection,
    options.rowCount,
    options.columnCount,
  );
  const selectedCells =
    rangeCells.length > 1 && cellsIncludeCell(rangeCells, options.editCell)
      ? rangeCells
      : columnCells.length > 1 &&
          cellsIncludeCell(columnCells, options.editCell)
        ? columnCells
        : [];
  const targets = selectedCells.length > 1 ? selectedCells : [options.editCell];

  return targets.flatMap((cell) => {
    const original = options.getCellContent(cell);
    const newValue = options.makeEditedCell(original, cell);
    if (!newValue || newValue === original) return [];
    return [{ cell, newValue }];
  });
}
