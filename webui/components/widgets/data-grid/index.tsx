// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { DataGridProps } from "./model/types";
import TanStackDataGrid from "./tanstack-data-grid";

export {
  drawActiveCuePlayIcon,
  drawConflictWarningIcon,
} from "./canvas-decorations";
export { DropdownCellAffordance } from "./cells/dropdown-cell-affordance";
export type { DataGridCellKey } from "./model/cell-provider";
export { createKeyedDataGridCellProvider } from "./model/cell-provider";
export { selectedClipboardCells } from "./model/clipboard";
export type {
  DataGridCellDecorationCallback,
  DataGridCellEdit,
  DataGridEditCommitContext,
  DataGridEditCommitMode,
  DataGridProps,
  DataGridRichCellEditorContext,
  DataGridRichCellExtension,
  DataGridRichCellMeasureContext,
  DataGridRichCellRenderContext,
  DataGridScrollRequest,
  HeaderCellView,
} from "./model/types";

export default function DataGrid(props: DataGridProps) {
  return <TanStackDataGrid {...props} />;
}
