// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { ComponentProps } from "solid-js";
import Tooltip from "../../../components/ui/tooltip";
import DataGrid from "../../../components/widgets/data-grid";
import { ATTRIBUTE_VALUE_NESTED_COLUMN_GROUPS } from "../../../lib/datagrid";
import { richTimeCellRenderer } from "../../../lib/datagrid-rich-cells";
import { parseTimingFanInput } from "../../../lib/timing-fan";
import type { CueCellTooltipState } from "../model/cue-editor-model";

type DataGridProps = ComponentProps<typeof DataGrid>;

type CueEditorGridProps = Pick<
  DataGridProps,
  | "columns"
  | "rows"
  | "cellProvider"
  | "onCellEdited"
  | "onCellsEdited"
  | "inlineEditTooltip"
  | "onCellClicked"
  | "onCellHovered"
  | "onCellContextMenu"
  | "onColumnHeaderContextMenu"
  | "onDelete"
  | "gridSelection"
  | "onGridSelectionChange"
> & {
  tooltip: () => CueCellTooltipState | undefined;
};

/** Renders the cue editor grid with its timing editor and tooltip configuration. */
export function CueEditorGrid(props: CueEditorGridProps) {
  return (
    <div class="min-h-0 flex-1" data-grid-owner="cue-editor">
      <DataGrid
        columns={props.columns}
        rows={props.rows}
        cellProvider={props.cellProvider}
        customRenderers={[richTimeCellRenderer]}
        onCellEdited={props.onCellEdited}
        onCellsEdited={props.onCellsEdited}
        shouldCommitUnparsedTimeInput={(value) =>
          parseTimingFanInput(value) !== null
        }
        inlineEditTooltip={props.inlineEditTooltip}
        onCellClicked={props.onCellClicked}
        onCellHovered={props.onCellHovered}
        onCellContextMenu={props.onCellContextMenu}
        onColumnHeaderContextMenu={props.onColumnHeaderContextMenu}
        onDelete={props.onDelete}
        gridSelection={props.gridSelection}
        onGridSelectionChange={props.onGridSelectionChange}
        rowHeight={30}
        width="100%"
        height="100%"
        freezeColumns={2}
        nestedColumnGroups={ATTRIBUTE_VALUE_NESTED_COLUMN_GROUPS}
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
