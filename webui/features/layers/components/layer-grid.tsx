// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Show } from "solid-js";
import DataGrid, {
  type DataGridProps,
} from "../../../components/widgets/data-grid";
import type { GridColumn, GridSelection } from "../../../lib/data-grid-types";
import { ATTRIBUTE_VALUE_NESTED_COLUMN_GROUPS } from "../../../lib/datagrid";
import { richColorSwatchCellRenderer } from "../../../lib/datagrid-rich-cells";

interface LayerGridProps {
  cellProvider: DataGridProps["cellProvider"];
  columns: GridColumn[];
  gridSelection: GridSelection | undefined;
  isOpen: boolean;
  layerIndex: number;
  onCellClicked: NonNullable<DataGridProps["onCellClicked"]>;
  onCellContextMenu: NonNullable<DataGridProps["onCellContextMenu"]>;
  panelId: string;
  performanceProbes: Record<string, unknown>;
  rows: number;
}

/** Presents a projected layer grid without reading stores or owning commands. */
export function LayerGrid(props: LayerGridProps) {
  return (
    <div class="h-[300px] p-2">
      <Show when={props.isOpen}>
        <DataGrid
          columns={props.columns}
          rows={props.rows}
          cellProvider={props.cellProvider}
          customRenderers={[richColorSwatchCellRenderer]}
          onCellClicked={props.onCellClicked}
          onCellContextMenu={props.onCellContextMenu}
          gridSelection={props.gridSelection}
          freezeColumns={1}
          rowHeight={30}
          width="100%"
          height="100%"
          nestedColumnGroups={ATTRIBUTE_VALUE_NESTED_COLUMN_GROUPS}
          performanceScope={`layers.${props.panelId}.${props.layerIndex}`}
          performanceProbes={props.performanceProbes}
        />
      </Show>
    </div>
  );
}
