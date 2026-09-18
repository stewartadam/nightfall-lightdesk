// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { CellClickedEventArgs, Item } from "../../../lib/data-grid-types";
import type { createDataGridEditingController } from "./editing-controller";
import type { DataGridProps } from "./model/types";
import type { createDataGridSelectionController } from "./selection-controller";

type DataGridEditingController = ReturnType<
  typeof createDataGridEditingController
>;
type DataGridSelectionController = ReturnType<
  typeof createDataGridSelectionController
>;

interface DataGridPointerEventControllerOptions {
  props: DataGridProps;
  editingController: DataGridEditingController;
  selectionController: DataGridSelectionController;
  focusRoot: () => void;
}

/** Owns DataGrid resize and body-cell pointer event adaptation. */
export function createDataGridPointerEventController(
  options: DataGridPointerEventControllerOptions,
) {
  const { beginEdit } = options.editingController;
  const {
    activateCell,
    consumeSuppressedCellClick,
    isExpandablePrimaryCell,
    shouldPreserveExistingSelection,
  } = options.selectionController;

  /** Handles body-cell click activation and edit entry. */
  const handleCellClick = (
    col: number,
    rowIndex: number,
    event: MouseEvent,
  ) => {
    if (consumeSuppressedCellClick()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const cell: Item = [col, rowIndex];
    const activatesExpandablePrimaryCell = isExpandablePrimaryCell(cell);
    const preserveExistingSelection = shouldPreserveExistingSelection(
      cell,
      event,
    );
    if (event.detail >= 2) {
      if (!preserveExistingSelection) {
        activateCell(col, rowIndex, event);
        options.props.onCellClicked?.(
          cell,
          event as unknown as CellClickedEventArgs,
        );
      }
      beginEdit(col, rowIndex);
      return;
    }

    if (!preserveExistingSelection) activateCell(col, rowIndex, event);
    options.props.onCellClicked?.(
      cell,
      event as unknown as CellClickedEventArgs,
    );
    if (activatesExpandablePrimaryCell) {
      options.focusRoot();
      return;
    }
    options.focusRoot();
  };

  /** Activates and edits a body cell from keyboard Enter. */
  const handleCellEnterKey = (
    col: number,
    rowIndex: number,
    event: KeyboardEvent,
  ) => {
    activateCell(col, rowIndex, event as unknown as MouseEvent);
    beginEdit(col, rowIndex);
  };

  return {
    handleCellClick,
    handleCellEnterKey,
  };
}
