// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { NativeSelect } from "../form-controls";

export type TabAlignment = "start" | "center" | "justify" | "end";

/** Defaults missing or unsupported alignment choices to a filled tab strip. */
export function normalizeTabAlignment(value: unknown): TabAlignment {
  return value === "center" || value === "start" || value === "end"
    ? value
    : "justify";
}

/** Selects the placement of tabs along both horizontal and vertical group headers. */
export function TabAlignmentSelect(props: {
  value: TabAlignment;
  onChange: (value: TabAlignment) => void;
}) {
  return (
    <label class="block">
      <span class="text-sm text-gray-300">Tab alignment</span>
      <NativeSelect
        class="mt-1"
        value={props.value}
        onChange={(event) =>
          props.onChange(normalizeTabAlignment(event.currentTarget.value))
        }
      >
        <option value="start">Start</option>
        <option value="center">Center</option>
        <option value="justify">Justify</option>
        <option value="end">End</option>
      </NativeSelect>
    </label>
  );
}
