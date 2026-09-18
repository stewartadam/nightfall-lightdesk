// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Show } from "solid-js";
import {
  type DropdownGridCell,
  dropdownDisplayValue,
  dropdownOptions,
  dropdownSelectedKey,
} from "../../../../lib/tanstack-dropdown-cell";
import { PrelineAdvancedSelect } from "../../advanced-select/preline-advanced-select";
import { canEditDropdownCell } from "../model/cell-utils";
import { DropdownCellAffordance } from "./dropdown-cell-affordance";
import "./dropdown-cell-select.css";

/** Shows an editable dropdown cell as a Preline select while preserving grid keyboard flow. */
export function DropdownCellSelect(props: {
  cell: DropdownGridCell;
  onCommit: (selectedKey: string) => void;
  onFocus: () => void;
}) {
  /** Returns whether the current dropdown cell can be edited. */
  const editable = () => canEditDropdownCell(props.cell);

  /** Returns the Preline options derived from dropdown cell metadata. */
  const selectOptions = () =>
    dropdownOptions(props.cell).map((option) => ({
      value: option.key,
      label: option.label,
    }));

  /** Returns the selected Preline option key for the dropdown cell. */
  const selectedValues = () => {
    const selectedKey = dropdownSelectedKey(props.cell);
    return selectedKey === "" ? [] : [selectedKey];
  };

  return (
    <Show
      when={editable()}
      fallback={
        <DropdownCellAffordance text={dropdownDisplayValue(props.cell)} />
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
        <PrelineAdvancedSelect
          options={selectOptions()}
          selectedValues={selectedValues()}
          onSelectedValuesChange={(selectedKeys) => {
            const selectedKey = selectedKeys[0];
            if (selectedKey === undefined) return;
            props.onCommit(selectedKey);
          }}
          ariaLabel="Choose cell value"
          containerClass="h-full w-full"
          selectIdPrefix="dropdown-cell-select"
          variant="grid"
          openOnMount
        />
      </div>
    </Show>
  );
}
