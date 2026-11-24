// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import {
  type DropdownGridCell,
  dropdownDisplaySwatch,
  dropdownDisplayValue,
  dropdownOptions,
  dropdownSelectedKey,
} from "../../../../lib/tanstack-dropdown-cell";
import { dataGridEnvironment } from "../environment";
import { canEditDropdownCell } from "../model/cell-utils";
import { DropdownCellAffordance } from "./dropdown-cell-affordance";

/**
 * Shows an editable dropdown cell with the environment's dropdown editor while
 * keeping editor keystrokes and clicks out of the grid's own handlers.
 */
export function DropdownCellSelect(props: {
  cell: DropdownGridCell;
  onCommit: (selectedKey: string) => void;
  onCancel: () => void;
  onFocus: () => void;
}) {
  /** Returns whether the current dropdown cell can be edited. */
  const editable = () => canEditDropdownCell(props.cell);

  /** Returns the editor options derived from dropdown cell metadata. */
  const selectOptions = () =>
    dropdownOptions(props.cell).map((option) => ({
      value: option.key,
      label: option.label,
      swatch: option.swatch,
    }));

  /** Returns the selected option key, or undefined when the cell has no value. */
  const selectedKey = () => {
    const key = dropdownSelectedKey(props.cell);
    return key === "" ? undefined : key;
  };

  return (
    <Show
      when={editable()}
      fallback={
        <DropdownCellAffordance
          text={dropdownDisplayValue(props.cell)}
          swatch={dropdownDisplaySwatch(props.cell)}
        />
      }
    >
      <div
        ref={(element) => {
          element.onkeydown = (event) => event.stopPropagation();
        }}
        class="h-full w-full"
        onFocusIn={props.onFocus}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <Dynamic
          component={dataGridEnvironment().DropdownSelect}
          options={selectOptions()}
          selectedKey={selectedKey()}
          onSelect={props.onCommit}
          onClose={props.onCancel}
          ariaLabel="Choose cell value"
        />
      </div>
    </Show>
  );
}
