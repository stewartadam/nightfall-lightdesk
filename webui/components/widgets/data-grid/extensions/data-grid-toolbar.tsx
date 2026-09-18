// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { type JSX, Show } from "solid-js";
import PanelToolbar from "../../../ui/panel-toolbar";
import { ToolbarButton } from "../../../ui/toolbar-button";

export interface DataGridToolbarProps {
  /** Number of selected rows (shows delete button when > 0) */
  selectedCount: number;
  /** Callback when delete button is clicked */
  onDelete?: () => void;
  /** Additional buttons or controls to render on the right side */
  children?: JSX.Element;
}

/**
 * Reusable toolbar component for DataGrid panels with row selection.
 * Shows a delete button with count badge when rows are selected.
 */
export default function DataGridToolbar(props: DataGridToolbarProps) {
  return (
    <PanelToolbar
      rightClass="flex min-w-0 items-center gap-0.5"
      right={
        <>
          {props.children}
          <Show when={props.selectedCount > 0 && props.onDelete}>
            <ToolbarButton
              label={`Delete selected (${props.selectedCount})`}
              onClick={() => props.onDelete?.()}
              class="text-red-300 hover:bg-red-950"
            >
              <TrashIcon class="size-4" aria-hidden />
            </ToolbarButton>
          </Show>
        </>
      }
    />
  );
}
