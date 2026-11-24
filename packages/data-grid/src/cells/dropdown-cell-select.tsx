// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { For, Show } from "solid-js";
import {
  type DropdownGridCell,
  dropdownDisplaySwatch,
  dropdownDisplayValue,
  dropdownOptions,
  dropdownSelectedKey,
} from "../dropdown-cell";
import { canEditDropdownCell } from "../model/cell-utils";
import { DropdownCellAffordance } from "./dropdown-cell-affordance";

/**
 * Edits a dropdown cell with a native `<select>`, focused as soon as editing
 * starts, while keeping editor keystrokes and clicks out of the grid's own
 * handlers. Escape ends editing without a change. Owners that want a richer
 * picker register a rich-cell extension for dropdown cells instead.
 */
export function DropdownCellSelect(props: {
  cell: DropdownGridCell;
  onCommit: (selectedKey: string) => void;
  onCancel: () => void;
  onFocus: () => void;
}) {
  /** Returns whether the current dropdown cell can be edited. */
  const editable = () => canEditDropdownCell(props.cell);

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
        <select
          class="h-full w-full bg-transparent"
          aria-label="Choose cell value"
          value={dropdownSelectedKey(props.cell)}
          ref={(element) => queueMicrotask(() => element.focus())}
          onChange={(event) => props.onCommit(event.currentTarget.value)}
          on:keydown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              props.onCancel();
            }
          }}
        >
          <option value="" disabled hidden />
          <For each={dropdownOptions(props.cell)}>
            {(option) => <option value={option.key}>{option.label}</option>}
          </For>
        </select>
      </div>
    </Show>
  );
}
