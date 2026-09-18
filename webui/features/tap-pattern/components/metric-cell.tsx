// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Show } from "solid-js";

export interface MetricCellProps {
  label: string;
  value: string;
  sublabel?: string;
}

/** Renders one compact metric cell in the tap-pattern panel header. */
export function MetricCell(props: MetricCellProps) {
  return (
    <div class="min-w-28 border border-neutral-800 bg-neutral-950 px-3 py-2">
      <div class="text-[11px] uppercase text-neutral-500">{props.label}</div>
      <div class="mt-1 font-mono text-lg text-neutral-100">{props.value}</div>
      <Show when={props.sublabel}>
        <div class="text-[11px] text-neutral-500">{props.sublabel}</div>
      </Show>
    </div>
  );
}
