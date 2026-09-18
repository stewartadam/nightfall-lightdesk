// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { SortingState } from "@tanstack/solid-table";
import type { JSX } from "solid-js";
import type {
  CellClickedEventArgs,
  CustomRenderer,
  GridCell,
  GridCellKind,
  GridColumn,
  GridSelection,
  GroupHeaderClickedEventArgs,
  Item,
} from "../../../../lib/data-grid-types";
import type { KeyedDataGridCellProvider } from "./cell-provider";

interface DataGridEditRequest {
  cell: Item;
  requestId: number;
}

export interface DataGridScrollRequest {
  cell: Item;
  requestId: number;
}

export type DataGridEditCommitMode = "default" | "alternate";

export interface DataGridEditCommitContext {
  inputValue?: string;
  mode: DataGridEditCommitMode;
}

interface DataGridBaseProps {
  columns: readonly GridColumn[];
  rows: number;
  /** Disables all editing and deletion while preserving navigation, selection and copying. */
  readOnly?: boolean;
  density?: "comfortable" | "compact";
  columnGuides?: boolean;
  ariaLabel?: string;
  /** Shows a message below the headers when the current row projection is empty. */
  emptyState?: JSX.Element;
  /** Column IDs whose headers sort the read-only view; source coordinates remain unchanged in callbacks. */
  sortableColumns?: readonly string[];
  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
  editRequest?: DataGridEditRequest;
  scrollRequest?: DataGridScrollRequest;
  onCellEdited?: (
    cell: Item,
    newValue: GridCell,
    selection?: GridSelection,
    context?: DataGridEditCommitContext,
  ) => void;
  onCellsEdited?: (
    edits: readonly DataGridCellEdit[],
    selection?: GridSelection,
    context?: DataGridEditCommitContext,
  ) => void;
  shouldCommitUnparsedTimeInput?: (value: string, cell: GridCell) => boolean;
  inlineEditTooltip?: (
    context: DataGridInlineEditTooltipContext,
  ) => string | undefined;
  onCellClicked?: (cell: Item, event: CellClickedEventArgs) => void;
  onCellHovered?: (cell: Item | undefined, element?: HTMLElement) => void;
  onCellContextMenu?: (cell: Item, event: CellClickedEventArgs) => void;
  onColumnHeaderContextMenu?: (
    colIndex: number,
    event: GroupHeaderClickedEventArgs,
    header: HeaderCellView,
  ) => void;
  onGridSelectionChange?: (selection: GridSelection) => void;
  onDelete?: (
    selection: GridSelection,
    context?: { shiftKey: boolean },
  ) => boolean | GridSelection | undefined;
  onGroupHeaderClicked?: (
    colIndex: number,
    event: GroupHeaderClickedEventArgs,
  ) => void;
  onColumnResize?: (column: GridColumn, newSize: number) => void;
  customRenderers?: readonly CustomRenderer<any>[];
  richCellExtensions?: readonly DataGridRichCellExtension[];
  cellDecorations?: DataGridCellDecorationCallback;
  gridSelection?: GridSelection;
  rowMarkers?: "none" | "checkbox";
  freezeColumns?: number;
  width?: number | string;
  height?: number | string;
  rowHeight?: number;
  primaryColumnIndex?: number;
  decorationInvalidateKey?: unknown;
  nestedColumnGroups?: boolean;
  performanceScope?: string;
  performanceProbes?: Record<string, unknown>;
  class?: string;
}

export interface DataGridProps extends DataGridBaseProps {
  cellProvider: () => KeyedDataGridCellProvider<any, any, any, any>;
}

export interface DataGridCellEdit {
  cell: Item;
  newValue: GridCell;
  inputValue?: string;
  commitMode?: DataGridEditCommitMode;
}

export interface DataGridInlineEditTooltipContext {
  cell: GridCell;
  value: string;
}

export type DataGridCellEditFactory = (
  original: GridCell,
  cell: Item,
) => GridCell | undefined;

export interface DataGridRichCellRenderContext {
  cell: GridCell;
  editable: boolean;
}

export interface DataGridRichCellMeasureContext {
  cell: GridCell;
  editable: boolean;
  measureText: (text: string) => number;
}

export interface DataGridRichCellEditorContext {
  cell: GridCell;
  coordinate: Item;
  commit: (makeEditedCell: DataGridCellEditFactory) => void;
  onFocus: () => void;
  close: () => void;
}

export interface DataGridRichCellExtension {
  id: string;
  matches: (cell: GridCell) => boolean;
  isEditable: (cell: GridCell) => boolean;
  measure?: (context: DataGridRichCellMeasureContext) => number;
  render: (context: DataGridRichCellRenderContext) => JSX.Element;
  renderEditor: (context: DataGridRichCellEditorContext) => JSX.Element;
  makeDeletedCell?: (cell: GridCell) => GridCell | undefined;
  makePastedCell?: (cell: GridCell, value: string) => GridCell | undefined;
  startsEditing?: (event: KeyboardEvent) => boolean;
}

interface DataGridCellDecorationArgs {
  ctx: CanvasRenderingContext2D;
  cell: GridCell;
  col: number;
  row: number;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export type DataGridCellDecorationCallback = (
  args: DataGridCellDecorationArgs,
) => void;

export interface TableRow {
  rowIndex: number;
}

export interface TextEditingCell {
  col: number;
  row: number;
  sourceCell: GridCell;
  value: string;
  kind: GridCellKind.Text | GridCellKind.Number;
  selectOnFocus: boolean;
  dirty: boolean;
}

export interface DiscreteEditingCell {
  col: number;
  row: number;
  sourceCell: GridCell;
  kind: "dropdown" | "rich";
  extensionId?: string;
}

export type EditingCell = TextEditingCell | DiscreteEditingCell;

export interface HeaderCellView {
  id: string;
  label: JSX.Element;
  firstLeafIndex: number;
  endLeafIndex: number;
}
