// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {
  CustomCell,
  CustomRenderer,
  GridCell,
} from "../../../../lib/data-grid-types";
import { GridCellKind } from "../../../../lib/data-grid-types";
import {
  formatDurationInputValue,
  isTimeCellData,
  parseDurationInput,
  type RichTimeCellData,
} from "../../../../lib/datagrid-rich-cell-helpers";
import {
  type DropdownGridCell,
  dropdownOptions,
  isDropdownCell,
  makeDropdownEditedCell,
} from "../../../../lib/tanstack-dropdown-cell";
import { editableRichCellExtension } from "./rich-cell-extension";
import type { DataGridRichCellExtension } from "./types";

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

/** Returns whether a rich time cell can use the inline text editor. */
export function canEditTimeCell(
  cell: GridCell,
): cell is CustomCell<RichTimeCellData> {
  return (
    cell.kind === GridCellKind.Custom &&
    isTimeCellData(cell.data as Record<string, unknown>) &&
    cell.allowOverlay === true &&
    !cell.readonly
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
  richCellExtensions?: readonly DataGridRichCellExtension[],
): boolean {
  return (
    canEditTextCell(cell) ||
    canEditBooleanCell(cell) ||
    canEditDropdownCell(cell) ||
    editableRichCellExtension(richCellExtensions, cell) !== undefined ||
    canEditTimeCell(cell)
  );
}

/** Creates an edited text or number cell while preserving unsupported cell kinds. */
export function makeEditedCell(original: GridCell, value: string): GridCell {
  if (canEditTimeCell(original)) {
    const data = original.data;
    const parsed = parseDurationInput(value, { minMs: data.minMs });
    if (!parsed) {
      return data.clearable === true && value.trim() === ""
        ? {
            ...original,
            copyData: "",
            data: {
              ...data,
              cleared: true,
            },
          }
        : original;
    }
    const updatedData = {
      ...data,
      value: parsed,
      cleared: false,
      displayValue: undefined,
    };
    return {
      ...original,
      copyData: formatDurationInputValue(
        updatedData.value,
        updatedData.displayUnit,
        updatedData.precision,
      ),
      data: updatedData,
    };
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
  richCellExtensions?: readonly DataGridRichCellExtension[],
): GridCell | undefined {
  if (isReadonlyCell(original)) return undefined;

  if (canEditTimeCell(original)) {
    return original.data.clearable === true
      ? {
          ...original,
          copyData: "",
          data: {
            ...original.data,
            cleared: true,
          },
        }
      : undefined;
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

  const richCellExtension = editableRichCellExtension(
    richCellExtensions,
    original,
  );
  if (richCellExtension?.makeDeletedCell) {
    return richCellExtension.makeDeletedCell(original);
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
  richCellExtensions?: readonly DataGridRichCellExtension[],
): GridCell | undefined {
  if (isReadonlyCell(original)) return undefined;

  if (canEditTextCell(original) || canEditTimeCell(original)) {
    return makeEditedCell(original, value);
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

  const richCellExtension = editableRichCellExtension(
    richCellExtensions,
    original,
  );
  if (richCellExtension?.makePastedCell) {
    return richCellExtension.makePastedCell(original, value);
  }

  return undefined;
}
