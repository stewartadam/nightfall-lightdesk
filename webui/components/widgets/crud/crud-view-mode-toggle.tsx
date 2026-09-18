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
import { ToolbarButton } from "../../ui/toolbar-button";

export type CrudViewMode = "grid" | "list";

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

/** Switches between list and card layouts using shared toolbar toggle states. */
export default function CrudViewModeToggle(props: CrudViewModeToggleProps) {
  return (
    <div class="flex items-center gap-0.5">
      <ToolbarButton
        tooltip={"List view"}
        type="button"
        ariaPressed={props.viewMode === "list"}
        label="Switch to list view"
        onClick={() => props.onViewModeChange("list")}
      >
        <ListIcon class="size-4" aria-hidden />
      </ToolbarButton>

      <ToolbarButton
        tooltip={"Grid view"}
        type="button"
        ariaPressed={props.viewMode === "grid"}
        label="Switch to grid view"
        onClick={() => props.onViewModeChange("grid")}
      >
        <SquaresFourIcon class="size-4" aria-hidden />
      </ToolbarButton>
    </div>
  );
}
