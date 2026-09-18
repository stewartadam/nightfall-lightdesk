// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal } from "solid-js";
import type {
  CellClickedEventArgs,
  GridCell,
  GridSelection,
  Item,
} from "../../../lib/data-grid-types";
import { CompactSelection, GridCellKind } from "../../../lib/data-grid-types";
import type { createDataGridEditingController } from "./editing-controller";
import {
  ARROW_KEY_DELTAS,
  clampIndex,
  isEditableKeyboardTarget,
  isExpandablePrimaryCellText,
  isInteractivePointerTarget,
  isPrintableEditKey,
  isSpaceKey,
} from "./event-adapter";
import {
  canEditBooleanCell,
  canEditDropdownCell,
  canEditTextCell,
  canEditTimeCell,
  cellDisplayValue,
  makeDeletedCell,
} from "./model/cell-utils";
import {
  clipboardEditsForPaste,
  clipboardTextForSelection,
  selectedClipboardCells,
} from "./model/clipboard";
import { editableRichCellExtension } from "./model/rich-cell-extension";
import {
  type DataGridSelectionState,
  deleteSelectionFromState,
  effectiveSelectedColumns,
  selectionFromState,
} from "./model/selection-model";
import type { DataGridProps } from "./model/types";
import type { createDataGridSelectionController } from "./selection-controller";
import type { createDataGridViewportController } from "./viewport";

type DataGridEditingController = ReturnType<
  typeof createDataGridEditingController
>;
type DataGridSelectionController = ReturnType<
  typeof createDataGridSelectionController
>;
type DataGridViewportController = ReturnType<
  typeof createDataGridViewportController
>;

interface DataGridKeyboardControllerOptions {
  props: DataGridProps;
  columns: () => readonly unknown[];
  primaryColumnIndex: () => number;
  getCellContent: () => (cell: Item) => GridCell;
  rootElement: () => HTMLDivElement | undefined;
  scrollElement: () => HTMLDivElement | undefined;
  editingController: DataGridEditingController;
  selectionController: DataGridSelectionController;
  viewportController: DataGridViewportController;
  focusRoot: () => void;
}

/** Owns DataGrid keyboard navigation, type-seek, and clipboard event handling. */
export function createDataGridKeyboardController(
  options: DataGridKeyboardControllerOptions,
) {
  let typeSeekTargetColumn: number | undefined;
  let typeSeekPreviousSelection: DataGridSelectionState | undefined;
  let typeSeekPreviousScroll: { x: number; y: number } | undefined;
  const [typeSeekActive, setTypeSeekActive] = createSignal(false);
  const [typeSeekText, setTypeSeekText] = createSignal("");
  const { beginEdit, cancelEdit, commitEdit, editingCell } =
    options.editingController;
  const {
    activeCell,
    currentSelection,
    dispatchSelection,
    selectedColumnSet,
    selectedRowSet,
    selectionState,
    selectCell,
    setSelectionState,
  } = options.selectionController;
  const {
    pageNavigationRowDelta,
    rowVirtualizer,
    scrolledColumnLeft,
    scrollCellIntoView,
    virtualRows,
  } = options.viewportController;

  /** Builds the public clipboard selection from the current reducer state. */
  const clipboardSelection = (): GridSelection => {
    const current = currentSelection();
    return {
      rows: CompactSelection.fromArray([...selectedRowSet()]),
      columns: CompactSelection.fromArray([...selectedColumnSet()]),
      ...(current ? { current } : {}),
    };
  };

  /** Moves the active cell with arrow keys and scrolls it into view. */
  const moveActiveCell = (event: KeyboardEvent): boolean => {
    const delta = ARROW_KEY_DELTAS[event.key];
    if (!delta) return false;

    const active = activeCell() ?? currentSelection()?.cell ?? [0, 0];
    const target: Item = [
      clampIndex(active[0] + delta[0], options.columns().length),
      clampIndex(active[1] + delta[1], options.props.rows),
    ];
    event.preventDefault();
    selectCell(target, {
      extend: event.shiftKey,
      preserveSelectedRows: false,
      scroll: true,
    });
    return true;
  };

  /** Moves the active cell by one viewport page and scrolls it into view. */
  const moveActiveCellByPage = (event: KeyboardEvent): boolean => {
    if (event.key !== "PageUp" && event.key !== "PageDown") return false;
    const active = activeCell() ?? currentSelection()?.cell ?? [0, 0];
    const direction = event.key === "PageDown" ? 1 : -1;
    const target: Item = [
      active[0],
      clampIndex(
        active[1] + direction * pageNavigationRowDelta(),
        options.props.rows,
      ),
    ];
    event.preventDefault();
    selectCell(target, {
      extend: event.shiftKey,
      preserveSelectedRows: false,
      scroll: true,
    });
    return true;
  };

  /** Moves the active cell to row or grid boundaries for Home and End. */
  const moveActiveCellToBoundary = (event: KeyboardEvent): boolean => {
    if (event.key !== "Home" && event.key !== "End") return false;
    const active = activeCell() ?? currentSelection()?.cell ?? [0, 0];
    const column = event.key === "Home" ? 0 : options.columns().length - 1;
    const row =
      event.ctrlKey || event.metaKey
        ? event.key === "Home"
          ? 0
          : options.props.rows - 1
        : active[1];
    const target: Item = [
      clampIndex(column, options.columns().length),
      clampIndex(row, options.props.rows),
    ];
    event.preventDefault();
    selectCell(target, {
      extend: event.shiftKey,
      preserveSelectedRows: false,
      scroll: true,
    });
    return true;
  };

  /** Moves the active cell horizontally with Tab and Shift+Tab. */
  const moveActiveCellWithTab = (event: KeyboardEvent): boolean => {
    if (event.key !== "Tab") return false;
    const active = activeCell() ?? currentSelection()?.cell ?? [0, 0];
    const target: Item = [
      clampIndex(
        active[0] + (event.shiftKey ? -1 : 1),
        options.columns().length,
      ),
      active[1],
    ];
    event.preventDefault();
    selectCell(target, { extend: false, scroll: true });
    return true;
  };

  /** Commits an inline edit and moves horizontally from the edited cell. */
  const commitEditAndMoveWithTab = (event: KeyboardEvent): boolean => {
    if (event.key !== "Tab") return false;
    const editing = editingCell();
    if (!editing) return false;
    const target: Item = [
      clampIndex(
        editing.col + (event.shiftKey ? -1 : 1),
        options.columns().length,
      ),
      editing.row,
    ];
    event.preventDefault();
    event.stopPropagation();
    commitEdit();
    selectCell(target, { extend: false, scroll: true });
    return true;
  };

  /** Returns whether the event should enter primary-column type-seek mode. */
  const isTypeSeekShortcut = (event: KeyboardEvent): boolean =>
    event.key.toLocaleLowerCase() === "g" &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey;

  /** Clears primary-column type-seek state. */
  const resetTypeSeek = () => {
    setTypeSeekActive(false);
    setTypeSeekText("");
    typeSeekTargetColumn = undefined;
    typeSeekPreviousSelection = undefined;
    typeSeekPreviousScroll = undefined;
  };

  /** Restores the selection and scroll position captured before type-seek. */
  const restoreTypeSeekOrigin = () => {
    if (typeSeekPreviousSelection) {
      setSelectionState(typeSeekPreviousSelection);
      options.props.onGridSelectionChange?.(
        selectionFromState(typeSeekPreviousSelection),
      );
    }
    const previousScroll = typeSeekPreviousScroll;
    const scrollElement = options.scrollElement();
    if (previousScroll && scrollElement) {
      scrollElement.scrollLeft = previousScroll.x;
      scrollElement.scrollTop = previousScroll.y;
    }
  };

  /** Completes type-seek, optionally restoring the original grid state. */
  const finishTypeSeek = (restore: boolean) => {
    if (restore) restoreTypeSeekOrigin();
    resetTypeSeek();
    options.focusRoot();
  };

  /** Selects the next row matching the primary-column type-seek text. */
  const selectPrimaryColumnMatch = (): boolean => {
    const query = typeSeekText().toLocaleLowerCase().trim();
    if (query === "") return false;

    const searchColumn = options.primaryColumnIndex();
    const active = activeCell() ??
      currentSelection()?.cell ?? [searchColumn, 0];
    const targetColumn = clampIndex(
      typeSeekTargetColumn ?? active[0] ?? searchColumn,
      options.columns().length,
    );
    const startRow = clampIndex(active[1] + 1, options.props.rows);
    for (let offset = 0; offset < options.props.rows; offset += 1) {
      const row = (startRow + offset) % options.props.rows;
      const rowText = cellDisplayValue(
        options.getCellContent()([searchColumn, row]),
      )
        .toLocaleLowerCase()
        .trim();
      if (!rowText.startsWith(query)) continue;
      selectCell([targetColumn, row], { extend: false, scroll: true });
      rowVirtualizer.scrollToIndex(row, { align: "center" });
      return true;
    }
    return false;
  };

  /** Returns the type-seek input position in scrolled content coordinates. */
  const typeSeekInputLeft = () =>
    scrolledColumnLeft(options.primaryColumnIndex());

  /** Starts primary-column type-seek mode with the modifier shortcut. */
  const activateTypeSeek = (event: KeyboardEvent): boolean => {
    if (!isTypeSeekShortcut(event)) return false;
    event.preventDefault();
    event.stopPropagation();
    const searchColumn = options.primaryColumnIndex();
    const active = activeCell() ??
      currentSelection()?.cell ?? [searchColumn, 0];
    typeSeekTargetColumn = clampIndex(active[0], options.columns().length);
    typeSeekPreviousSelection = selectionState();
    const scrollElement = options.scrollElement();
    typeSeekPreviousScroll = scrollElement
      ? { x: scrollElement.scrollLeft, y: scrollElement.scrollTop }
      : undefined;
    setTypeSeekText("");
    setTypeSeekActive(true);
    return true;
  };

  /** Updates type-seek text and moves to the matching primary-column row. */
  const updateTypeSeekText = (nextText: string) => {
    setTypeSeekText(nextText);
    selectPrimaryColumnMatch();
  };

  /** Handles text input while primary-column type-seek mode is active. */
  const typeSeekPrimaryColumn = (event: KeyboardEvent): boolean => {
    if (!typeSeekActive()) return false;

    if (event.key === "Escape") {
      event.preventDefault();
      finishTypeSeek(true);
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      finishTypeSeek(false);
      return true;
    }
    if (event.key === "Backspace") {
      event.preventDefault();
      updateTypeSeekText(typeSeekText().slice(0, -1));
      return true;
    }
    if (!isPrintableEditKey(event)) return false;
    event.preventDefault();
    updateTypeSeekText(`${typeSeekText()}${event.key}`);
    return true;
  };

  /** Extends selected rows with shift-arrow keyboard navigation. */
  const extendRowSelection = (event: KeyboardEvent): boolean => {
    if (
      !event.shiftKey ||
      (event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
      selectionState().selectedRows.length === 0
    ) {
      return false;
    }

    const nextState = dispatchSelection({
      type: "extendRowSelection",
      direction: event.key === "ArrowDown" ? 1 : -1,
      rowCount: options.props.rows,
    });
    const nextExtent = nextState.rowSelectionExtent;
    event.preventDefault();
    if (nextExtent !== undefined) {
      rowVirtualizer.scrollToIndex(nextExtent, { align: "auto" });
    }
    return true;
  };

  /** Extends selected columns with horizontal shift-arrow navigation. */
  const extendColumnSelection = (event: KeyboardEvent): boolean => {
    if (
      !event.shiftKey ||
      (event.key !== "ArrowLeft" && event.key !== "ArrowRight") ||
      effectiveSelectedColumns(selectionState()).length === 0
    ) {
      return false;
    }

    const nextState = dispatchSelection({
      type: "extendColumnSelection",
      direction: event.key === "ArrowRight" ? 1 : -1,
      columnCount: options.columns().length,
    });
    event.preventDefault();
    const nextActive = nextState.activeCell;
    if (nextActive) scrollCellIntoView(nextActive);
    return true;
  };

  /** Selects the row containing the active cell. */
  const selectActiveRow = (): boolean => {
    const previous = selectionState();
    const next = dispatchSelection({ type: "selectActiveRow" });
    return next !== previous;
  };

  /** Activates expandable primary cells without entering edit mode. */
  const activatePrimaryCell = (event: KeyboardEvent, active: Item): boolean => {
    if (event.key !== "Enter" && !isSpaceKey(event)) return false;
    if (event.shiftKey || active[0] !== options.primaryColumnIndex()) {
      return false;
    }

    const cell = options.getCellContent()(active);
    if (
      !isExpandablePrimaryCellText(cellDisplayValue(cell)) ||
      !options.props.onCellClicked
    ) {
      return false;
    }

    event.preventDefault();
    options.props.onCellClicked(
      active,
      event as unknown as CellClickedEventArgs,
    );
    options.focusRoot();
    return true;
  };

  /** Applies Delete-key clearing to editable selected cells. */
  const applyDefaultDelete = (selection: GridSelection): boolean => {
    if (!options.props.onCellEdited && !options.props.onCellsEdited) {
      return false;
    }

    const edits = selectedClipboardCells(
      selection,
      options.props.rows,
      options.columns().length,
    )
      .map((cell) => {
        const newValue = makeDeletedCell(
          options.getCellContent()(cell),
          options.props.richCellExtensions,
        );
        return newValue ? { cell, newValue } : undefined;
      })
      .filter((edit): edit is NonNullable<typeof edit> => edit !== undefined);

    if (edits.length === 0) return false;
    if (options.props.onCellsEdited) {
      options.props.onCellsEdited(edits);
      return true;
    }
    for (const edit of edits) {
      options.props.onCellEdited?.(edit.cell, edit.newValue);
    }
    return true;
  };

  /** Returns whether a body cell can host the inline text editor. */
  const canEditCellAt = (cell: Item): boolean => {
    const content = options.getCellContent()(cell);
    return canEditTextCell(content) || canEditTimeCell(content);
  };

  /** Returns the first body cell available for selected-column editing. */
  const selectedColumnEditAnchor = ():
    | { cell: Item; isVisible: boolean }
    | undefined => {
    if (options.props.rows <= 0 || options.columns().length === 0) {
      return undefined;
    }
    const selectedColumns = effectiveSelectedColumns(selectionState()).map(
      (column) => clampIndex(column, options.columns().length),
    );
    const visibleRows = virtualRows().map((row) => row.index);

    for (const col of selectedColumns) {
      for (const row of visibleRows) {
        const cell: Item = [col, row];
        if (canEditCellAt(cell)) return { cell, isVisible: true };
      }
    }
    for (const col of selectedColumns) {
      for (let row = 0; row < options.props.rows; row += 1) {
        const cell: Item = [col, row];
        if (canEditCellAt(cell)) return { cell, isVisible: false };
      }
    }
    return undefined;
  };

  /** Starts selected-column editing after ensuring the anchor row is mounted. */
  const beginColumnSelectionEdit = (
    anchor: { cell: Item; isVisible: boolean },
    initialValue?: string,
  ) => {
    if (anchor.isVisible) {
      beginEdit(anchor.cell[0], anchor.cell[1], initialValue);
      return;
    }
    rowVirtualizer.scrollToIndex(anchor.cell[1], { align: "auto" });
    requestAnimationFrame(() => {
      beginEdit(anchor.cell[0], anchor.cell[1], initialValue);
    });
  };

  /** Handles grid-level editing, deletion, toggles, and navigation. */
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;

    if (editingCell()) {
      const editing = editingCell();
      if (editing?.kind === "dropdown" || editing?.kind === "rich") {
        if (event.key === "Escape") {
          event.preventDefault();
          cancelEdit();
        }
        return;
      }
      if (commitEditAndMoveWithTab(event)) return;
      if (event.key === "Enter") {
        event.preventDefault();
        commitEdit(event.shiftKey ? "alternate" : "default");
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelEdit();
      }
      return;
    }

    if (activateTypeSeek(event) || typeSeekPrimaryColumn(event)) return;

    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (options.props.readOnly) return;
      const selection = deleteSelectionFromState(selectionState());
      const deleteResult = options.props.onDelete?.(selection, {
        shiftKey: event.shiftKey,
      });
      if (deleteResult && typeof deleteResult !== "boolean") {
        dispatchSelection({ type: "deleteSelection", selection: deleteResult });
        options.focusRoot();
        return;
      }
      if (deleteResult === true) {
        options.focusRoot();
        return;
      }
      if (applyDefaultDelete(selection)) options.focusRoot();
      return;
    }

    const active = activeCell() ?? currentSelection()?.cell;
    if (!active) {
      const editAnchor = selectedColumnEditAnchor();
      if (!editAnchor) return;
      if (event.key === "Enter") {
        event.preventDefault();
        beginColumnSelectionEdit(editAnchor);
        return;
      }
      if (isPrintableEditKey(event)) {
        const cell = options.getCellContent()(editAnchor.cell);
        if (canEditTextCell(cell) || canEditTimeCell(cell)) {
          event.preventDefault();
          event.stopPropagation();
          beginColumnSelectionEdit(editAnchor, event.key);
        }
      }
      return;
    }

    if (isSpaceKey(event) && event.shiftKey) {
      event.preventDefault();
      selectActiveRow();
      return;
    }
    if (extendRowSelection(event) || extendColumnSelection(event)) return;
    if (moveActiveCellWithTab(event)) return;
    if (moveActiveCellByPage(event) || moveActiveCellToBoundary(event)) return;
    if (moveActiveCell(event) || activatePrimaryCell(event, active)) return;

    const activeCellContent = options.getCellContent()(active);
    const activeRichCellExtension = editableRichCellExtension(
      options.props.richCellExtensions,
      activeCellContent,
    );
    if (activeRichCellExtension?.startsEditing?.(event)) {
      event.preventDefault();
      event.stopPropagation();
      beginEdit(active[0], active[1]);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      beginEdit(active[0], active[1]);
      return;
    }
    if (isSpaceKey(event)) {
      if (
        canEditDropdownCell(activeCellContent) ||
        editableRichCellExtension(
          options.props.richCellExtensions,
          activeCellContent,
        )
      ) {
        event.preventDefault();
        beginEdit(active[0], active[1]);
        return;
      }
      if (
        activeCellContent.kind === GridCellKind.Boolean &&
        canEditBooleanCell(activeCellContent) &&
        !options.props.readOnly
      ) {
        event.preventDefault();
        options.props.onCellEdited?.(active, {
          ...activeCellContent,
          data: activeCellContent.data !== true,
        });
        return;
      }
    }
    if (!isPrintableEditKey(event)) return;

    const cell = options.getCellContent()(active);
    if (canEditTextCell(cell) || canEditTimeCell(cell)) {
      event.preventDefault();
      event.stopPropagation();
      beginEdit(active[0], active[1], event.key);
      return;
    }
    const editAnchor = selectedColumnEditAnchor();
    if (editAnchor) {
      event.preventDefault();
      event.stopPropagation();
      beginColumnSelectionEdit(editAnchor, event.key);
    }
  };

  /** Copies selected grid cells as tab-separated plain text. */
  const handleCopy = (event: ClipboardEvent) => {
    if (editingCell()) return;
    const text = clipboardTextForSelection(
      clipboardSelection(),
      options.props.rows,
      options.columns().length,
      options.getCellContent(),
    );
    if (text === undefined) return;
    event.clipboardData?.setData("text/plain", text);
    event.preventDefault();
  };

  /** Pastes tabular plain text at the active selection. */
  const handlePaste = (event: ClipboardEvent) => {
    if (options.props.readOnly) {
      event.preventDefault();
      return;
    }
    if (editingCell()) return;
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text === "") return;

    const edits = clipboardEditsForPaste({
      selection: clipboardSelection(),
      activeCell: activeCell() ?? currentSelection()?.cell,
      rowCount: options.props.rows,
      columnCount: options.columns().length,
      text,
      getCellContent: options.getCellContent(),
      richCellExtensions: options.props.richCellExtensions,
    });
    if (edits.length === 0) return;
    event.preventDefault();
    if (options.props.onCellsEdited) {
      options.props.onCellsEdited(edits);
      return;
    }
    for (const edit of edits) {
      options.props.onCellEdited?.(edit.cell, edit.newValue);
    }
  };

  /** Handles document keys that commit or cancel active editing. */
  const handleDocumentKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const editing = editingCell();
    if (!editing) return;
    if (
      (event.key === "Enter" || event.key === "Escape") &&
      isEditableKeyboardTarget(event.target)
    ) {
      return;
    }
    const rootElement = options.rootElement();
    if (
      rootElement &&
      event.target instanceof Node &&
      !rootElement.contains(event.target)
    ) {
      return;
    }
    if (editing.kind === "dropdown" || editing.kind === "rich") {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelEdit();
      }
      return;
    }
    if (commitEditAndMoveWithTab(event)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      commitEdit(event.shiftKey ? "alternate" : "default");
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelEdit();
    }
  };

  /** Routes document keyboard events into the focused grid. */
  const handleDocumentGridKeyDown = (event: KeyboardEvent) => {
    const rootElement = options.rootElement();
    if (editingCell() || !rootElement) return;
    const activeElement = document.activeElement;
    const eventTarget = event.target;
    if (
      eventTarget instanceof Element &&
      eventTarget.closest("[data-grid-resize-handle]")
    )
      return;
    const isDeleteKey = event.key === "Delete" || event.key === "Backspace";
    const isCheckboxTarget =
      eventTarget instanceof HTMLInputElement &&
      eventTarget.type === "checkbox";
    if (
      isInteractivePointerTarget(eventTarget) &&
      !(isDeleteKey && isCheckboxTarget)
    ) {
      return;
    }
    const gridHasFocus =
      activeElement === rootElement ||
      (activeElement instanceof Node && rootElement.contains(activeElement)) ||
      (eventTarget instanceof Node && rootElement.contains(eventTarget));
    if (gridHasFocus) handleKeyDown(event);
  };

  return {
    finishTypeSeek,
    handleCopy,
    handleDocumentGridKeyDown,
    handleDocumentKeyDown,
    handlePaste,
    resetTypeSeek,
    typeSeekActive,
    typeSeekInputLeft,
    typeSeekText,
    updateTypeSeekText,
  };
}
