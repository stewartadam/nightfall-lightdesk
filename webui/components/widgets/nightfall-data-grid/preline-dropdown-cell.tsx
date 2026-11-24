// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  canEditDropdownCell,
  type DataGridRichCellEditorContext,
  type DataGridRichCellExtension,
  type DataGridRichCellRenderContext,
  DropdownCellAffordance,
} from "@stewartadam/nightfall-data-grid";
import {
  type DropdownGridCell,
  dropdownDisplaySwatch,
  dropdownDisplayValue,
  dropdownOptions,
  dropdownSelectedKey,
  isDropdownCell,
  makeDropdownEditedCell,
  makeDropdownEditedCellByValue,
} from "@stewartadam/nightfall-data-grid/dropdown-cell";
import type { GridCell } from "@stewartadam/nightfall-data-grid/types";
import { PrelineAdvancedSelect } from "../advanced-select/preline-advanced-select";
import "./preline-dropdown-cell.css";

/** Shows a dropdown cell's value: an affordance when editable, plain right-aligned text otherwise. */
function renderDropdownValue(context: DataGridRichCellRenderContext) {
  const cell = context.cell as DropdownGridCell;
  return context.editable ? (
    <DropdownCellAffordance
      text={dropdownDisplayValue(cell)}
      swatch={dropdownDisplaySwatch(cell)}
    />
  ) : (
    <span class="w-full truncate text-right">{dropdownDisplayValue(cell)}</span>
  );
}

/**
 * Edits a dropdown cell with the app's Preline select, opened as soon as
 * editing starts. Keystrokes and clicks stay inside the select so the grid's
 * own navigation does not react to them.
 */
function renderPrelineDropdownEditor(context: DataGridRichCellEditorContext) {
  const cell = context.cell as DropdownGridCell;
  const selectedKey = dropdownSelectedKey(cell);
  return (
    <div
      ref={(element) => {
        element.onkeydown = (event) => event.stopPropagation();
      }}
      class="h-full w-full"
      onFocusIn={context.onFocus}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <PrelineAdvancedSelect
        options={dropdownOptions(cell).map((option) => ({
          value: option.key,
          label: option.label,
          swatch: option.swatch,
        }))}
        selectedValues={selectedKey === "" ? [] : [selectedKey]}
        onSelectedValuesChange={(selectedKeys) => {
          const key = selectedKeys[0];
          const selected = dropdownOptions(cell).find(
            (option) => option.key === key,
          );
          if (!selected) return;
          context.commit((original) =>
            canEditDropdownCell(original)
              ? makeDropdownEditedCellByValue(original, selected.value)
              : undefined,
          );
          context.close();
        }}
        ariaLabel="Choose cell value"
        containerClass="h-full w-full"
        selectIdPrefix="dropdown-cell-select"
        variant="grid"
        openOnMount
      />
    </div>
  );
}

/** Clears a dropdown cell's value for Delete. */
function makeDeletedDropdownCell(cell: GridCell): GridCell | undefined {
  if (!isDropdownCell(cell)) return undefined;
  return { ...cell, copyData: "", data: { ...cell.data, value: undefined } };
}

/** Selects the option whose value or label matches pasted text, ignoring text that matches none. */
function makePastedDropdownCell(
  cell: GridCell,
  value: string,
): GridCell | undefined {
  if (!isDropdownCell(cell)) return undefined;
  const normalized = value.trim();
  const selected = dropdownOptions(cell).find(
    (option) => option.value === normalized || option.label === normalized,
  );
  return selected ? makeDropdownEditedCell(cell, selected.key) : undefined;
}

/** Starts editing on Space, matching the grid's built-in dropdown cells. */
function startsDropdownEditing(event: KeyboardEvent): boolean {
  return event.key === " " || event.key === "Space";
}

/**
 * Nightfall's dropdown cell type: replaces the grid's native `<select>` with
 * the app's Preline select while keeping the built-in dropdown's Delete,
 * paste, Space-to-edit and column sizing behavior.
 */
export const prelineDropdownCellExtension: DataGridRichCellExtension = {
  id: "nightfall-preline-dropdown",
  matches: isDropdownCell,
  isEditable: canEditDropdownCell,
  render: renderDropdownValue,
  renderEditor: renderPrelineDropdownEditor,
  makeDeletedCell: makeDeletedDropdownCell,
  makePastedCell: makePastedDropdownCell,
  startsEditing: startsDropdownEditing,
};
