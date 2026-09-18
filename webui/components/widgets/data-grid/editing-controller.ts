// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, createSignal, untrack } from "solid-js";
import type { GridCell, Item } from "../../../lib/data-grid-types";
import { GridCellKind } from "../../../lib/data-grid-types";
import {
  canEditDropdownCell,
  canEditTextCell,
  canEditTimeCell,
  cellDisplayValue,
} from "./model/cell-utils";
import {
  discreteEditEditsForSelection,
  inlineEditEditsForSelection,
} from "./model/clipboard";
import { editableRichCellExtension } from "./model/rich-cell-extension";
import {
  type DataGridSelectionAction,
  type DataGridSelectionState,
  editCommitSelectionFromState,
} from "./model/selection-model";
import type {
  DataGridCellEditFactory,
  DataGridEditCommitMode,
  DataGridProps,
  EditingCell,
} from "./model/types";

interface DataGridEditingControllerOptions {
  props: DataGridProps;
  selectionState: () => DataGridSelectionState;
  dispatchSelection: (
    action: DataGridSelectionAction,
  ) => DataGridSelectionState;
  getCellContent: () => (cell: Item) => GridCell;
  columnCount: () => number;
  focusRoot: () => void;
}

/** Owns DataGrid editor state and commit fan-out across the active selection. */
export function createDataGridEditingController(
  options: DataGridEditingControllerOptions,
) {
  const [editingCell, setEditingCell] = createSignal<EditingCell>();

  /** Starts editing for built-in cells or a registered rich-cell extension. */
  const beginEdit = (col: number, row: number, initialValue?: string) => {
    if (options.props.readOnly) return;
    const cell = options.getCellContent()([col, row]);
    if (canEditDropdownCell(cell)) {
      setEditingCell({ col, row, sourceCell: cell, kind: "dropdown" });
      return;
    }
    const richCellExtension = editableRichCellExtension(
      options.props.richCellExtensions,
      cell,
    );
    if (richCellExtension) {
      setEditingCell({
        col,
        row,
        sourceCell: cell,
        kind: "rich",
        extensionId: richCellExtension.id,
      });
      return;
    }
    if (!canEditTextCell(cell) && !canEditTimeCell(cell)) return;
    const kind =
      cell.kind === GridCellKind.Number
        ? GridCellKind.Number
        : GridCellKind.Text;
    setEditingCell({
      col,
      row,
      sourceCell: cell,
      kind,
      value: initialValue ?? cellDisplayValue(cell),
      selectOnFocus: initialValue === undefined,
      dirty: initialValue !== undefined,
    });
  };

  /** Commits the current inline edit and restores active-cell focus. */
  const commitEdit = (mode: DataGridEditCommitMode = "default") => {
    if (options.props.readOnly) {
      cancelEdit();
      return;
    }
    const editing = editingCell();
    if (!editing) return;
    if (editing.kind === "dropdown" || editing.kind === "rich") {
      setEditingCell(undefined);
      options.focusRoot();
      return;
    }
    if (
      editing.kind !== GridCellKind.Text &&
      editing.kind !== GridCellKind.Number
    ) {
      return;
    }

    const selection = editCommitSelectionFromState(options.selectionState());
    const context = { inputValue: editing.value, mode };
    options.props.onGridSelectionChange?.(selection);
    const edits = inlineEditEditsForSelection({
      selection,
      editCell: [editing.col, editing.row],
      rowCount: options.props.rows,
      columnCount: options.columnCount(),
      value: editing.value,
      dirty: editing.dirty,
      commitMode: mode,
      shouldCommitUnparsedTimeInput:
        options.props.shouldCommitUnparsedTimeInput,
      getCellContent: options.getCellContent(),
    });
    setEditingCell(undefined);
    options.dispatchSelection({
      type: "setActiveCell",
      cell: [editing.col, editing.row],
    });
    options.focusRoot();

    if (options.props.onCellsEdited && edits.length > 1) {
      options.props.onCellsEdited(edits, selection, context);
    } else {
      for (const edit of edits) {
        options.props.onCellEdited?.(
          edit.cell,
          edit.newValue,
          selection,
          context,
        );
      }
      if (
        !options.props.onCellEdited &&
        options.props.onCellsEdited &&
        edits.length > 0
      ) {
        options.props.onCellsEdited(edits, selection, context);
      }
    }
    options.focusRoot();
  };

  /** Commits a non-text editor value across the active selection. */
  const commitDiscreteEdit = (
    editCell: Item,
    makeEditedCell: DataGridCellEditFactory,
  ) => {
    if (options.props.readOnly) return;
    const selection = editCommitSelectionFromState(options.selectionState());
    const edits = discreteEditEditsForSelection({
      selection,
      editCell,
      rowCount: options.props.rows,
      columnCount: options.columnCount(),
      getCellContent: options.getCellContent(),
      makeEditedCell,
    });
    if (edits.length === 0) return;

    options.props.onGridSelectionChange?.(selection);
    options.dispatchSelection({ type: "setActiveCell", cell: editCell });

    if (options.props.onCellsEdited && edits.length > 1) {
      options.props.onCellsEdited(edits, selection);
      return;
    }
    for (const edit of edits) {
      options.props.onCellEdited?.(edit.cell, edit.newValue, selection);
    }
    if (
      !options.props.onCellEdited &&
      options.props.onCellsEdited &&
      edits.length > 0
    ) {
      options.props.onCellsEdited(edits, selection);
    }
  };

  /** Cancels the active editor and returns focus to the grid. */
  const cancelEdit = () => {
    setEditingCell(undefined);
    options.focusRoot();
  };

  /** Discards an open editor if its owner changes the grid to read-only presentation. */
  createEffect(() => {
    if (options.props.readOnly && untrack(editingCell)) cancelEdit();
  });

  return {
    beginEdit,
    cancelEdit,
    commitDiscreteEdit,
    commitEdit,
    editingCell,
    setEditingCell,
  };
}
