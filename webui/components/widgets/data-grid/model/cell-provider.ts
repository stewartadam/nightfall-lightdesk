// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { GridCell, Item } from "../../../../lib/data-grid-types";

export type DataGridCellKey = number | string;

interface KeyedDataGridCellAddress<
  RowKey extends DataGridCellKey,
  ColumnKey extends DataGridCellKey,
  Row = unknown,
  Column = unknown,
> {
  cell: Item;
  rowIndex: number;
  columnIndex: number;
  rowKey: RowKey;
  columnKey: ColumnKey;
  row: Row;
  column: Column;
}

export interface KeyedDataGridCellProvider<
  Row = unknown,
  Column = unknown,
  RowKey extends DataGridCellKey = DataGridCellKey,
  ColumnKey extends DataGridCellKey = DataGridCellKey,
> {
  rows: readonly Row[];
  columns: readonly Column[];
  /** Identifies the cell content revision that can affect intrinsic column widths. */
  contentSizingKey: unknown;
  rowKeys: readonly RowKey[];
  columnKeys: readonly ColumnKey[];
  getCellContent: (
    address: KeyedDataGridCellAddress<RowKey, ColumnKey, Row, Column>,
  ) => GridCell;
}

export interface KeyedDataGridCellProviderOptions<
  Row,
  Column,
  RowKey extends DataGridCellKey,
  ColumnKey extends DataGridCellKey,
> {
  rows: readonly Row[];
  columns: readonly Column[];
  /** Identifies the cell content revision that can affect intrinsic column widths. */
  contentSizingKey?: unknown;
  rowKey: (row: Row, rowIndex: number) => RowKey;
  columnKey: (column: Column, columnIndex: number) => ColumnKey;
  getCellContent: (
    address: KeyedDataGridCellAddress<RowKey, ColumnKey, Row, Column>,
  ) => GridCell;
}

/** Builds a keyed cell provider from row and column models. */
export function createKeyedDataGridCellProvider<
  Row,
  Column,
  RowKey extends DataGridCellKey,
  ColumnKey extends DataGridCellKey,
>(
  options: KeyedDataGridCellProviderOptions<Row, Column, RowKey, ColumnKey>,
): KeyedDataGridCellProvider<Row, Column, RowKey, ColumnKey> {
  return {
    rows: options.rows,
    columns: options.columns,
    contentSizingKey: options.contentSizingKey,
    rowKeys: options.rows.map(options.rowKey),
    columnKeys: options.columns.map(options.columnKey),
    getCellContent: options.getCellContent,
  };
}

/** Resolves viewport cell indices through stable row and column keys. */
export function keyedDataGridCellContent<
  Row,
  Column,
  RowKey extends DataGridCellKey,
  ColumnKey extends DataGridCellKey,
>(
  provider: KeyedDataGridCellProvider<Row, Column, RowKey, ColumnKey>,
  cell: Item,
): GridCell | undefined {
  const [columnIndex, rowIndex] = cell;
  const row = provider.rows[rowIndex];
  const column = provider.columns[columnIndex];
  const rowKey = provider.rowKeys[rowIndex];
  const columnKey = provider.columnKeys[columnIndex];
  if (
    row === undefined ||
    column === undefined ||
    rowKey === undefined ||
    columnKey === undefined
  ) {
    return undefined;
  }
  return provider.getCellContent({
    cell,
    rowIndex,
    columnIndex,
    rowKey,
    columnKey,
    row,
    column,
  });
}

/** Creates the index-based lookup function consumed by the data grid. */
export function keyedDataGridCellContentFn<
  Row,
  Column,
  RowKey extends DataGridCellKey,
  ColumnKey extends DataGridCellKey,
>(
  provider: KeyedDataGridCellProvider<Row, Column, RowKey, ColumnKey>,
  fallback: (cell: Item) => GridCell,
): (cell: Item) => GridCell {
  return (cell) => keyedDataGridCellContent(provider, cell) ?? fallback(cell);
}
