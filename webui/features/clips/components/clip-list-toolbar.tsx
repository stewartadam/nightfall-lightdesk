// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { PencilSimpleLineIcon } from "@squidlab/phosphor-solid/pencil-simple-line";
import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import { SelectionIcon } from "@squidlab/phosphor-solid/selection";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { Show } from "solid-js";
import PanelToolbar from "../../../components/ui/panel-toolbar";
import { ToolbarButton } from "../../../components/ui/toolbar-button";
import CrudPanelSearch, {
  type CrudPanelSearchController,
} from "../../../components/widgets/crud/crud-panel-search";
import CrudViewModeToggle, {
  type CrudViewMode,
} from "../../../components/widgets/crud/crud-view-mode-toggle";

interface ClipListToolbarProps {
  search: CrudPanelSearchController;
  viewMode: CrudViewMode;
  selectionMode: boolean;
  selectedCount: number;
  onCreate: () => void;
  onEditSelected: () => void;
  onDeleteSelected: () => void;
  onToggleSelectionMode: () => void;
  onViewModeChange: (mode: CrudViewMode) => void;
}

/** Renders props-only clip list actions, search, and view controls. */
export function ClipListToolbar(props: ClipListToolbarProps) {
  return (
    <PanelToolbar
      left={
        <>
          <ToolbarButton
            tooltip={"Add clip (N)"}
            type="button"
            onClick={props.onCreate}
            label="Add clip"
          >
            <PlusIcon class="size-4" aria-hidden />
          </ToolbarButton>

          <ToolbarButton
            tooltip={"Edit selected clip (Enter)"}
            type="button"
            onClick={props.onEditSelected}
            disabled={props.selectedCount !== 1}
            label="Edit selected clip"
          >
            <PencilSimpleLineIcon class="size-4" aria-hidden />
          </ToolbarButton>

          <ToolbarButton
            variant="danger"
            size="labeled"
            tooltip={
              props.selectedCount > 0
                ? `Delete selected clips (${props.selectedCount})`
                : "Delete selected clips (Delete/Backspace)"
            }
            type="button"
            onClick={props.onDeleteSelected}
            disabled={props.selectedCount === 0}
            label="Delete selected clips"
          >
            <TrashIcon class="size-4" aria-hidden />
            <Show when={props.selectedCount > 0}>
              <span class="rounded bg-red-800 px-1 text-[10px] leading-4 text-red-100">
                {props.selectedCount}
              </span>
            </Show>
          </ToolbarButton>

          <Show when={props.viewMode === "grid"}>
            <div class="mx-1 h-6 w-px bg-neutral-700" aria-hidden="true" />
            <ToolbarButton
              tooltip={`${props.selectionMode ? "Exit" : "Enter"} selection mode (V)`}
              type="button"
              onClick={props.onToggleSelectionMode}
              ariaPressed={props.selectionMode}
              label="Toggle selection mode"
            >
              <SelectionIcon class="size-4" aria-hidden />
            </ToolbarButton>
          </Show>
        </>
      }
      right={
        <>
          <CrudPanelSearch search={props.search} placeholder="Search clips" />
          <CrudViewModeToggle
            viewMode={props.viewMode}
            onViewModeChange={props.onViewModeChange}
          />
        </>
      }
    />
  );
}
