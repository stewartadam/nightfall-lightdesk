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
import PanelToolbar, {
  ToolbarSeparator,
} from "../../../components/ui/panel-toolbar";
import {
  ToggleToolbarButton,
  ToolbarButton,
} from "../../../components/ui/toolbar-button";
import CrudPanelSearch, {
  type CrudPanelSearchController,
} from "../../../components/widgets/crud/crud-panel-search";
import { CrudRunStopButtons } from "../../../components/widgets/crud/crud-run-stop-buttons";
import CrudViewModeToggle, {
  type CrudViewMode,
} from "../../../components/widgets/crud/crud-view-mode-toggle";

interface ClipListToolbarProps {
  search: CrudPanelSearchController;
  viewMode: CrudViewMode;
  selectionMode: boolean;
  selectedCount: number;
  /** Whether any selected clip is stopped and can start. */
  canRunSelected: boolean;
  /** Whether any selected clip is playing and can stop. */
  canStopSelected: boolean;
  onCreate: () => void;
  onEditSelected: () => void;
  onDeleteSelected: () => void;
  onRunSelected: () => void;
  onStopSelected: () => void;
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
            count={props.selectedCount}
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
          </ToolbarButton>

          <CrudRunStopButtons
            noun="clips"
            canRun={props.canRunSelected}
            canStop={props.canStopSelected}
            onRun={props.onRunSelected}
            onStop={props.onStopSelected}
          />

          <Show when={props.viewMode === "grid"}>
            <ToolbarSeparator />
            <ToggleToolbarButton
              tooltip={`${props.selectionMode ? "Exit" : "Enter"} selection mode (V)`}
              type="button"
              onClick={props.onToggleSelectionMode}
              pressed={props.selectionMode}
              label="Toggle selection mode"
            >
              <SelectionIcon class="size-4" aria-hidden />
            </ToggleToolbarButton>
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
