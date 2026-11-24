// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { DataGridProps } from "./model/types.ts";
import TanStackDataGrid from "./tanstack-data-grid.tsx";

export { DropdownCellAffordance } from "./cells/dropdown-cell-affordance.tsx";
export type { DataGridCellKey } from "./model/cell-provider.ts";
export { createKeyedDataGridCellProvider } from "./model/cell-provider.ts";
export { canEditDropdownCell } from "./model/cell-utils.ts";
export { selectedClipboardCells } from "./model/clipboard.ts";
export {
  activeGridSelectionRow,
  singleRowGridSelection,
} from "./model/row-selection.ts";
export type {
  DataGridCellDecorationCallback,
  DataGridCellEdit,
  DataGridEditCommitContext,
  DataGridEditCommitMode,
  DataGridMetricSample,
  DataGridProps,
  DataGridRichCellEditorContext,
  DataGridRichCellExtension,
  DataGridRichCellMeasureContext,
  DataGridRichCellRenderContext,
  DataGridScrollRequest,
  DataGridSelectionMode,
  HeaderCellView,
} from "./model/types.ts";

export default function DataGrid(props: DataGridProps) {
  return <TanStackDataGrid {...props} />;
}
