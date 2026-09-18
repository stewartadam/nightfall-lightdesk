// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { ComponentProps } from "solid-js";
import Tooltip from "../../../components/ui/tooltip";
import DataGrid from "../../../components/widgets/data-grid";
import { richTimeCellRenderer } from "../../../lib/datagrid-rich-cells";
import { trackingFlagsDataGridExtension } from "../../cue-sequences";
import type { SequenceConflictTooltipState } from "../model/sequence-editor-model";

type DataGridProps = ComponentProps<typeof DataGrid>;

type SequenceEditorGridProps = Pick<
  DataGridProps,
  | "columns"
  | "rows"
  | "cellProvider"
  | "cellDecorations"
  | "decorationInvalidateKey"
  | "onCellEdited"
  | "onCellsEdited"
  | "onCellContextMenu"
  | "onCellHovered"
  | "onDelete"
  | "onCellClicked"
  | "gridSelection"
  | "onGridSelectionChange"
> & {
  tooltip: () => SequenceConflictTooltipState | undefined;
};

/** Renders the sequence editor grid with timing, tracking, and tooltip extensions. */
export function SequenceEditorGrid(props: SequenceEditorGridProps) {
  return (
    <div class="relative min-h-0 flex-1" data-grid-owner="sequence-editor">
      <DataGrid
        columns={props.columns}
        rows={props.rows}
        cellProvider={props.cellProvider}
        customRenderers={[richTimeCellRenderer]}
        richCellExtensions={[trackingFlagsDataGridExtension]}
        cellDecorations={props.cellDecorations}
        decorationInvalidateKey={props.decorationInvalidateKey}
        onCellEdited={props.onCellEdited}
        onCellsEdited={props.onCellsEdited}
        onCellContextMenu={props.onCellContextMenu}
        onCellHovered={props.onCellHovered}
        onDelete={props.onDelete}
        onCellClicked={props.onCellClicked}
        gridSelection={props.gridSelection}
        onGridSelectionChange={props.onGridSelectionChange}
        rowMarkers="checkbox"
        rowHeight={30}
        width="100%"
        height="100%"
        freezeColumns={2}
      />
      <Tooltip
        content={() => props.tooltip()?.content ?? ""}
        position="bottom"
        anchorRect={() => props.tooltip()?.anchorRect}
        animationKey={() => props.tooltip()?.id}
        forceVisible={() => props.tooltip() !== undefined}
      >
        <span aria-hidden="true" />
      </Tooltip>
    </div>
  );
}
