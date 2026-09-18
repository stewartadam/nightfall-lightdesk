// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CaretDoubleDownIcon } from "@squidlab/phosphor-solid/caret-double-down";
import { CaretDoubleUpIcon } from "@squidlab/phosphor-solid/caret-double-up";
import PanelToolbar from "../../../components/ui/panel-toolbar";
import { ToolbarButton } from "../../../components/ui/toolbar-button";
import ColumnVisibilityMenu from "../../../components/widgets/data-grid/extensions/column-visibility-menu";
import type { GridColumn } from "../../../lib/data-grid-types";

interface LayerPanelToolbarProps {
  canCollapse: boolean;
  canExpand: boolean;
  columns: () => GridColumn[];
  onCollapseAll: () => void;
  onExpandAll: () => void;
  panelId: string;
}

/** Presents layer expansion and column-visibility actions from supplied callbacks. */
export function LayerPanelToolbar(props: LayerPanelToolbarProps) {
  return (
    <PanelToolbar
      right={
        <>
          <ToolbarButton
            label="Expand all layers"
            onClick={props.onExpandAll}
            disabled={!props.canExpand}
          >
            <CaretDoubleDownIcon class="size-4" aria-hidden />
          </ToolbarButton>
          <ToolbarButton
            label="Collapse all layers"
            onClick={props.onCollapseAll}
            disabled={!props.canCollapse}
          >
            <CaretDoubleUpIcon class="size-4" aria-hidden />
          </ToolbarButton>
          <ColumnVisibilityMenu
            scope={`${props.panelId}:layers`}
            columns={props.columns}
          />
        </>
      }
    />
  );
}
