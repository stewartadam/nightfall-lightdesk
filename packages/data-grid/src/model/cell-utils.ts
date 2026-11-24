// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {
  CustomCell,
  CustomCellTextEditor,
  CustomRenderer,
  GridCell,
} from "../data-grid-types";
import { GridCellKind } from "../data-grid-types";
import {
  type DropdownGridCell,
  dropdownOptions,
  isDropdownCell,
  makeDropdownEditedCell,
} from "../dropdown-cell";
import { editableRichCellExtension } from "./rich-cell-extension";
import type { DataGridCellEditors } from "./types";

/** Converts supported cell kinds into the text shown or copied by the grid. */
export function cellDisplayValue(cell: GridCell): string {
  switch (cell.kind) {
    case GridCellKind.Text:
      return cell.displayData ?? cell.data ?? "";
    case GridCellKind.Number:
      return cell.displayData ?? String(cell.data ?? "");
    case GridCellKind.Boolean:
      return cell.data === true ? "true" : "";
    case GridCellKind.Custom:
      return cell.copyData ?? "";
    case GridCellKind.Loading:
      return "...";
    default:
      return "";
  }
}

/** Finds the first custom renderer that accepts a custom cell. */
export function findCustomRenderer(
  renderers: readonly CustomRenderer<any>[] | undefined,
  cell: CustomCell,
): CustomRenderer | undefined {
  return renderers?.find((renderer) => renderer.isMatch(cell));
}

/** Returns whether a text-like cell can open the inline text editor. */
export function canEditTextCell(cell: GridCell): boolean {
  return (
    (cell.kind === GridCellKind.Text || cell.kind === GridCellKind.Number) &&
    cell.allowOverlay === true &&
    !cell.readonly
  );
}

/** Returns whether a dropdown cell can be changed through the select editor. */
export function canEditDropdownCell(cell: GridCell): cell is DropdownGridCell {
  return isDropdownCell(cell) && cell.allowOverlay === true && !cell.readonly;
}

/**
 * Returns the text editor a custom renderer provides for an editable custom
 * cell, or undefined when the cell is readonly, has no overlay or no matching
 * renderer edits it as text. An editable rich-cell extension takes precedence,
 * matching the editor that opens when editing starts.
 */
export function customCellTextEditor(
  cell: GridCell,
  editors?: DataGridCellEditors,
): CustomCellTextEditor | undefined {
  if (
    cell.kind !== GridCellKind.Custom ||
    cell.allowOverlay !== true ||
    cell.readonly ||
    editableRichCellExtension(editors?.richCellExtensions, cell) !== undefined
  ) {
    return undefined;
  }
  return findCustomRenderer(editors?.customRenderers, cell)?.textEditor;
}

/** Returns whether a cell opens the inline text editor, either as text or through a custom text editor. */
export function canEditCellAsText(
  cell: GridCell,
  editors?: DataGridCellEditors,
): boolean {
  return (
    canEditTextCell(cell) || customCellTextEditor(cell, editors) !== undefined
  );
}

/** Returns whether a cell declares itself readonly. */
export function isReadonlyCell(cell: GridCell): boolean {
  return "readonly" in cell && cell.readonly === true;
}

/** Returns whether a boolean cell can be toggled through the checkbox editor. */
export function canEditBooleanCell(cell: GridCell): boolean {
  return cell.kind === GridCellKind.Boolean && !isReadonlyCell(cell);
}

/** Returns whether the grid should expose an editor for the cell. */
export function canUseCellEditor(
  cell: GridCell,
  editors?: DataGridCellEditors,
): boolean {
  return (
    canEditCellAsText(cell, editors) ||
    canEditBooleanCell(cell) ||
    canEditDropdownCell(cell) ||
    editableRichCellExtension(editors?.richCellExtensions, cell) !== undefined
  );
}

/**
 * Creates the cell produced by committing inline-editor text. Custom cells go
 * through their renderer's text editor; unsupported cells come back unchanged.
 */
export function makeEditedCell(
  original: GridCell,
  value: string,
  editors?: DataGridCellEditors,
): GridCell {
  const textEditor = customCellTextEditor(original, editors);
  if (textEditor && original.kind === GridCellKind.Custom) {
    return textEditor.makeEditedCell(original, value);
  }

  if (original.kind === GridCellKind.Number) {
    const parsed = Number.parseFloat(value);
    return {
      ...original,
      data: Number.isFinite(parsed) ? parsed : original.data,
      displayData: value,
    };
  }

  if (original.kind === GridCellKind.Text) {
    return {
      ...original,
      data: value,
      displayData: value,
    };
  }

  return original;
}

/** Creates the empty/default cell value used by Delete for editable cells. */
export function makeDeletedCell(
  original: GridCell,
  editors?: DataGridCellEditors,
): GridCell | undefined {
  if (isReadonlyCell(original)) return undefined;

  const richCellExtension = editableRichCellExtension(
    editors?.richCellExtensions,
    original,
  );
  if (richCellExtension?.makeDeletedCell) {
    return richCellExtension.makeDeletedCell(original);
  }

  const textEditor = customCellTextEditor(original, editors);
  if (textEditor && original.kind === GridCellKind.Custom) {
    return textEditor.makeDeletedCell?.(original);
  }

  if (canEditDropdownCell(original)) {
    return {
      ...original,
      copyData: "",
      data: {
        ...original.data,
        value: undefined,
      },
    };
  }

  if (original.kind === GridCellKind.Number && canEditTextCell(original)) {
    return {
      ...original,
      data: 0,
      displayData: "0",
    };
  }

  if (original.kind === GridCellKind.Text && canEditTextCell(original)) {
    return {
      ...original,
      data: "",
      displayData: "",
    };
  }

  if (original.kind === GridCellKind.Boolean && canEditBooleanCell(original)) {
    return {
      ...original,
      data: false,
    };
  }

  return undefined;
}

/** Parses common plain-text boolean clipboard values. */
function parseBooleanClipboardValue(value: string): boolean | undefined {
  const normalized = value.trim().toLocaleLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off", ""].includes(normalized)) return false;
  return undefined;
}

/** Creates an edited cell from pasted plain text when the target cell is editable. */
export function makePastedCell(
  original: GridCell,
  value: string,
  editors?: DataGridCellEditors,
): GridCell | undefined {
  if (isReadonlyCell(original)) return undefined;

  const richCellExtension = editableRichCellExtension(
    editors?.richCellExtensions,
    original,
  );
  if (richCellExtension?.makePastedCell) {
    return richCellExtension.makePastedCell(original, value);
  }

  if (canEditCellAsText(original, editors)) {
    return makeEditedCell(original, value, editors);
  }

  if (original.kind === GridCellKind.Boolean) {
    const parsed = parseBooleanClipboardValue(value);
    return parsed === undefined ? undefined : { ...original, data: parsed };
  }

  if (canEditDropdownCell(original)) {
    const normalized = value.trim();
    const selected = dropdownOptions(original).find(
      (option) => option.value === normalized || option.label === normalized,
    );
    return selected
      ? makeDropdownEditedCell(original, selected.key)
      : undefined;
  }

  return undefined;
}
