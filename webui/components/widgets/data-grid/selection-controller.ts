// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createMemo, createSignal, untrack } from "solid-js";
import type {
  CellClickedEventArgs,
  GridCell,
  GridSelection,
  Item,
} from "../../../lib/data-grid-types";
import {
  cellFromPoint,
  isExpandablePrimaryCellText,
  isInteractivePointerTarget,
} from "./event-adapter";
import { cellDisplayValue } from "./model/cell-utils";
import {
  type DataGridSelectionAction,
  effectiveCurrentSelection,
  effectiveSelectedColumns,
  effectiveSelectedRows,
  initialDataGridSelectionState,
  reduceDataGridSelection,
  selectionActionPublishes,
  selectionFromState,
  selectionIncludesCell,
} from "./model/selection-model";
import type { EditingCell } from "./model/types";

const DRAG_SELECTION_START_THRESHOLD_PX = 5;

interface DataGridSelectionControllerOptions {
  editingCell: () => EditingCell | undefined;
  getCellContent: () => (cell: Item) => GridCell;
  primaryColumnIndex: () => number;
  focusRoot: () => void;
  scrollCellIntoView: (cell: Item) => void;
  onCellClicked?: (cell: Item, event: CellClickedEventArgs) => void;
  onGridSelectionChange?: (selection: GridSelection) => void;
}

/** Owns DataGrid selection state, publication, and pointer-drag lifecycle. */
export function createDataGridSelectionController(
  options: DataGridSelectionControllerOptions,
) {
  const [selectionState, setSelectionState] = createSignal(
    initialDataGridSelectionState,
  );
  let dragPointerStart: { x: number; y: number } | undefined;
  let suppressNextCellClick = false;

  const currentSelection = createMemo(() =>
    effectiveCurrentSelection(selectionState()),
  );
  const selectedRowSet = createMemo(
    () => new Set(effectiveSelectedRows(selectionState())),
  );
  const selectedColumnSet = createMemo(
    () => new Set(effectiveSelectedColumns(selectionState())),
  );
  const activeCell = createMemo(() => selectionState().activeCell);

  /** Applies a reducer action and publishes actions that change public selection. */
  const dispatchSelection = (action: DataGridSelectionAction) => {
    const previousState = untrack(selectionState);
    const nextState = reduceDataGridSelection(previousState, action);
    if (nextState !== previousState) {
      setSelectionState(nextState);
    }
    if (nextState !== previousState && selectionActionPublishes(action)) {
      options.onGridSelectionChange?.(selectionFromState(nextState));
    }
    return nextState;
  };

  /** Updates cell selection for single, extended, and additive modes. */
  const selectCell = (
    target: Item,
    selectionOptions: {
      append?: boolean;
      extend: boolean;
      preserveSelectedRows?: boolean;
      scroll?: boolean;
    },
  ) => {
    dispatchSelection({
      type: "selectCell",
      target,
      append: selectionOptions.append,
      extend: selectionOptions.extend,
      preserveSelectedRows: selectionOptions.preserveSelectedRows,
    });
    if (selectionOptions.scroll) {
      options.scrollCellIntoView(target);
    }
  };

  /** Activates a cell while honoring pointer modifier selection keys. */
  const activateCell = (col: number, row: number, event: MouseEvent) => {
    selectCell([col, row], {
      append: event.metaKey || event.ctrlKey,
      extend: event.shiftKey,
    });
  };

  /** Returns whether a simple click should preserve an existing multi-cell selection. */
  const shouldPreserveExistingSelection = (
    cell: Item,
    event: Pick<MouseEvent, "ctrlKey" | "metaKey" | "shiftKey">,
  ): boolean => {
    const current = currentSelection();
    const currentSelectsMultipleCells =
      current !== undefined &&
      (current.range.width > 1 ||
        current.range.height > 1 ||
        current.rangeStack.length > 0);
    return (
      currentSelectsMultipleCells &&
      current !== undefined &&
      selectionIncludesCell(current, cell) &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey
    );
  };

  /** Returns whether a cell activates the expandable primary-column action. */
  const isExpandablePrimaryCell = (cell: Item): boolean =>
    cell[0] === options.primaryColumnIndex() &&
    options.onCellClicked !== undefined &&
    isExpandablePrimaryCellText(
      cellDisplayValue(options.getCellContent()(cell)),
    );

  /** Schedules click suppression for the click following pointer release. */
  const suppressPointerReleaseClick = () => {
    suppressNextCellClick = true;
    window.setTimeout(() => {
      suppressNextCellClick = false;
    }, 0);
  };

  /** Consumes the pending pointer-release click suppression flag. */
  const consumeSuppressedCellClick = (): boolean => {
    if (!suppressNextCellClick) return false;
    suppressNextCellClick = false;
    return true;
  };

  /** Returns whether pointer movement remains within click tolerance. */
  const isWithinClickTolerance = (event: PointerEvent): boolean => {
    if (!dragPointerStart) return false;
    const distanceX = event.clientX - dragPointerStart.x;
    const distanceY = event.clientY - dragPointerStart.y;
    return (
      distanceX * distanceX + distanceY * distanceY <=
      DRAG_SELECTION_START_THRESHOLD_PX * DRAG_SELECTION_START_THRESHOLD_PX
    );
  };

  /** Ends drag selection and removes temporary document listeners. */
  const endDragSelection = () => {
    const drag = selectionState().drag;
    if (drag?.moved) {
      suppressPointerReleaseClick();
    }
    dispatchSelection({ type: "endDrag" });
    dragPointerStart = undefined;
    window.removeEventListener("pointermove", handleDragPointerMove);
    window.removeEventListener("pointerup", handleDragPointerUp);
  };

  /** Extends an active drag after movement exceeds click tolerance. */
  const handleDragPointerMove = (event: PointerEvent) => {
    const drag = selectionState().drag;
    if (!drag || !dragPointerStart) return;
    if (!drag.moved && isWithinClickTolerance(event)) return;

    const target = cellFromPoint(event.clientX, event.clientY);
    if (!target) return;
    const nextState = dispatchSelection({ type: "dragTo", target });
    if (nextState.drag === drag) return;
    event.preventDefault();
  };

  /** Completes an active drag selection on pointer release. */
  const handleDragPointerUp = (event: PointerEvent) => {
    const drag = selectionState().drag;
    if (drag?.moved) {
      event.preventDefault();
      endDragSelection();
      return;
    }

    if (
      drag &&
      isWithinClickTolerance(event) &&
      isExpandablePrimaryCell(drag.anchor)
    ) {
      event.preventDefault();
      activateCell(
        drag.anchor[0],
        drag.anchor[1],
        event as unknown as MouseEvent,
      );
      options.onCellClicked?.(
        drag.anchor,
        event as unknown as CellClickedEventArgs,
      );
      options.focusRoot();
      suppressPointerReleaseClick();
    }
    endDragSelection();
  };

  /** Starts pointer-driven cell range selection. */
  const beginDragSelection = (
    col: number,
    row: number,
    event: PointerEvent,
  ) => {
    if (event.button !== 0 || options.editingCell()) return;
    if (isInteractivePointerTarget(event.target)) return;

    const target: Item = [col, row];
    dragPointerStart = { x: event.clientX, y: event.clientY };
    if (
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !shouldPreserveExistingSelection(target, event)
    ) {
      activateCell(col, row, event);
    }
    dispatchSelection({
      type: "beginDrag",
      target,
      append: event.metaKey || event.ctrlKey,
    });
    options.focusRoot();

    window.addEventListener("pointermove", handleDragPointerMove);
    window.addEventListener("pointerup", handleDragPointerUp);
  };

  /** Removes any document listeners retained by an interrupted drag. */
  const dispose = () => {
    dragPointerStart = undefined;
    window.removeEventListener("pointermove", handleDragPointerMove);
    window.removeEventListener("pointerup", handleDragPointerUp);
  };

  return {
    activeCell,
    activateCell,
    beginDragSelection,
    consumeSuppressedCellClick,
    currentSelection,
    dispatchSelection,
    dispose,
    isExpandablePrimaryCell,
    selectedColumnSet,
    selectedRowSet,
    selectionState,
    selectCell,
    setSelectionState,
    shouldPreserveExistingSelection,
  };
}
