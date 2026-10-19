// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ListIcon } from "@squidlab/phosphor-solid/list";
import { SquaresFourIcon } from "@squidlab/phosphor-solid/squares-four";
import { type Accessor, createEffect, on, onCleanup } from "solid-js";
import { playContentEntrance } from "../../ui/content-entrance";
import {
  SegmentedControl,
  type SegmentedControlOption,
} from "../../ui/segmented-control";

export type CrudViewMode = "grid" | "list";

const VIEW_MODE_OPTIONS: readonly SegmentedControlOption<CrudViewMode>[] = [
  {
    value: "list",
    icon: ListIcon,
    ariaLabel: "List view",
    tooltip: "List view",
  },
  {
    value: "grid",
    icon: SquaresFourIcon,
    ariaLabel: "Grid view",
    tooltip: "Grid view",
  },
];

/** Slides layout content after a view change while leaving initial render and repeated selections still. */
export function createCrudViewEntrance(
  mode: Accessor<CrudViewMode | undefined>,
  content: Accessor<HTMLElement | undefined>,
) {
  /** Waits for the selected layout to render and cancels any superseded entrance. */
  createEffect(
    on(mode, (next, previous) => {
      if (!next || !previous || next === previous) return;
      let cancel: (() => void) | undefined;
      const frame = requestAnimationFrame(() => {
        const element = content();
        if (element)
          cancel = playContentEntrance(element, {
            direction: next === "grid" ? "right" : "left",
          });
      });
      onCleanup(() => {
        cancelAnimationFrame(frame);
        cancel?.();
      });
    }),
  );
}

interface CrudViewModeToggleProps {
  viewMode: CrudViewMode;
  onViewModeChange: (mode: CrudViewMode) => void;
}

/** Switches between list and card layouts with a compact segmented control. */
export default function CrudViewModeToggle(props: CrudViewModeToggleProps) {
  return (
    <SegmentedControl
      label="View"
      density="compact"
      options={VIEW_MODE_OPTIONS}
      value={props.viewMode}
      onChange={props.onViewModeChange}
    />
  );
}
