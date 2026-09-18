// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CubeIcon } from "@squidlab/phosphor-solid/cube";
import { EraserIcon } from "@squidlab/phosphor-solid/eraser";
import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import type { ComponentProps } from "solid-js";
import PanelToolbar, {
  ToolbarSeparator,
} from "../../../components/ui/panel-toolbar";
import { ToolbarButton } from "../../../components/ui/toolbar-button";
import ColumnVisibilityMenu from "../../../components/widgets/data-grid/extensions/column-visibility-menu";
import DataGridFilterMenu from "../../../components/widgets/data-grid/extensions/data-grid-filter-menu";

interface ProgrammerToolbarProps {
  storeCue: () => void;
  storeGroup: () => void;
  clear: () => void;
  filterMenu: ComponentProps<typeof DataGridFilterMenu>;
  columnVisibilityMenu: ComponentProps<typeof ColumnVisibilityMenu>;
}

/** Renders programmer store/clear actions and grid view controls. */
export function ProgrammerToolbar(props: ProgrammerToolbarProps) {
  return (
    <PanelToolbar
      left={
        <>
          <ToolbarButton
            tooltip={"Store Cue"}
            type="button"
            label="Store cue"
            onClick={props.storeCue}
          >
            <PlusIcon class="size-4" aria-hidden />
          </ToolbarButton>

          <ToolbarButton
            tooltip={"Store Group"}
            type="button"
            label="Store group"
            onClick={props.storeGroup}
          >
            <CubeIcon class="size-4" aria-hidden />
          </ToolbarButton>

          <ToolbarSeparator />

          <ToolbarButton
            tooltip={"Clear programmer (selection first, then values)"}
            type="button"
            label="Clear programmer"
            onClick={props.clear}
          >
            <EraserIcon class="size-4" aria-hidden />
          </ToolbarButton>
        </>
      }
      right={
        <>
          <DataGridFilterMenu {...props.filterMenu} />
          <ColumnVisibilityMenu {...props.columnVisibilityMenu} />
        </>
      }
    />
  );
}
