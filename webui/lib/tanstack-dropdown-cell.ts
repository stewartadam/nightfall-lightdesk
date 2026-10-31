// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { CustomCell, GridCell } from "./data-grid-types";

type DropdownOption =
  | string
  | {
      value: string;
      label: string;
      /** Hex color shown as a swatch next to the label. */
      swatch?: string;
    }
  | undefined
  | null;

interface DropdownCellData {
  readonly kind: "dropdown-cell";
  readonly value: string | undefined | null;
  readonly allowedValues: readonly DropdownOption[];
}

export type DropdownGridCell = CustomCell<DropdownCellData>;

export interface NormalizedDropdownOption {
  readonly key: string;
  readonly value: string | undefined | null;
  readonly label: string;
  readonly swatch?: string;
}

export function isDropdownCell(cell: GridCell): cell is DropdownGridCell {
  if (cell.kind !== "custom") return false;
  return (cell.data as { kind?: unknown }).kind === "dropdown-cell";
}

export function dropdownOptions(
  cell: DropdownGridCell,
): NormalizedDropdownOption[] {
  return cell.data.allowedValues.map((option, index) => {
    if (typeof option === "string") {
      return {
        key: String(index),
        value: option,
        label: option,
      };
    }

    if (option === null || option === undefined) {
      return {
        key: String(index),
        value: option,
        label: "",
      };
    }

    return {
      key: String(index),
      value: option.value,
      label: option.label,
      ...(option.swatch === undefined ? {} : { swatch: option.swatch }),
    };
  });
}

/** Returns the option matching a dropdown cell's current value, if any. */
function dropdownSelectedOption(
  cell: DropdownGridCell,
): NormalizedDropdownOption | undefined {
  return dropdownOptions(cell).find(
    (option) => option.value === cell.data.value,
  );
}

export function dropdownDisplayValue(cell: DropdownGridCell): string {
  return dropdownSelectedOption(cell)?.label ?? cell.data.value ?? "";
}

/** Returns the swatch color of a dropdown cell's selected option, if it has one. */
export function dropdownDisplaySwatch(
  cell: DropdownGridCell,
): string | undefined {
  return dropdownSelectedOption(cell)?.swatch;
}

export function dropdownSelectedKey(cell: DropdownGridCell): string {
  return dropdownSelectedOption(cell)?.key ?? "";
}

export function makeDropdownEditedCell(
  cell: DropdownGridCell,
  selectedKey: string,
): DropdownGridCell {
  const selected = dropdownOptions(cell).find(
    (option) => option.key === selectedKey,
  );
  return selected ? makeDropdownEditedCellByValue(cell, selected.value) : cell;
}

export function makeDropdownEditedCellByValue(
  cell: DropdownGridCell,
  selectedValue: string | undefined | null,
): DropdownGridCell {
  const selected = dropdownOptions(cell).find(
    (option) => option.value === selectedValue,
  );
  if (!selected) return cell;

  return {
    ...cell,
    data: {
      ...cell.data,
      value: selectedValue,
    },
    copyData: selected.label,
  };
}
