// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CaretUpDownIcon } from "@squidlab/phosphor-solid/caret-up-down";

const GRID_DROPDOWN_AFFORDANCE_CLASSES =
  "relative flex h-full min-h-full w-full cursor-pointer items-center truncate border-0 bg-transparent px-2 pe-7 py-0 text-start text-sm leading-none text-white outline-hidden hover:bg-white/5 focus:bg-white/10";

/** Renders passive grid cell content with the same visual affordance as grid selects. */
export function DropdownCellAffordance(props: {
  text: string;
  align?: "left" | "right";
}) {
  /** Returns the text alignment class for the affordance label. */
  const textAlignClass = () =>
    props.align === "right" ? "text-right" : "text-left";

  return (
    <span
      class={GRID_DROPDOWN_AFFORDANCE_CLASSES}
      data-grid-dropdown-affordance="true"
    >
      <span class={`w-full truncate ${textAlignClass()}`}>{props.text}</span>
      <span class="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-neutral-400">
        <CaretUpDownIcon class="size-3.5 shrink-0" aria-hidden />
      </span>
    </span>
  );
}
