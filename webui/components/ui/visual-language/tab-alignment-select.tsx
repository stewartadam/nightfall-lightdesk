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

/**
 * Selects the placement of tabs along both horizontal and vertical group headers. The caller
 * labels it, through `id` or a wrapping `<label>`, so it fits a settings row or a stacked form.
 */
export function TabAlignmentSelect(props: {
  value: TabAlignment;
  id?: string;
  describedBy?: string;
  class?: string;
  onChange: (value: TabAlignment) => void;
}) {
  return (
    <NativeSelect
      id={props.id}
      aria-describedby={props.describedBy}
      class={props.class}
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
  );
}
