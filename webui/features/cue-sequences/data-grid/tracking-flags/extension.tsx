// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type DataGridRichCellExtension,
  DropdownCellAffordance,
} from "../../../../components/widgets/data-grid";
import type { GridCell } from "../../../../lib/data-grid-types";
import { TrackingFlagsCellSelect } from "./editor";
import { isTrackingFlagsCell, makeTrackingFlagsEditedCell } from "./model";

/** Returns whether a tracking-flags cell permits its domain editor. */
function canEditTrackingFlagsCell(cell: GridCell): boolean {
  return (
    isTrackingFlagsCell(cell) &&
    cell.allowOverlay === true &&
    cell.readonly !== true
  );
}

/** Resolves the tracking summary exactly as the rich cell renderer displays it. */
function trackingFlagsDisplayText(cell: GridCell): string {
  return isTrackingFlagsCell(cell) && cell.data.trackingMode === "Inherit"
    ? `Inherit: ${cell.data.inheritedSummary ?? "Sequence"}`
    : (cell.copyData ?? "");
}

/** Provides tracking-flags rendering and editing without coupling the generic grid to cue semantics. */
export const trackingFlagsDataGridExtension: DataGridRichCellExtension = {
  id: "cue-sequences:tracking-flags",
  matches: isTrackingFlagsCell,
  isEditable: canEditTrackingFlagsCell,
  measure: ({ cell, editable, measureText }) =>
    measureText(trackingFlagsDisplayText(cell)) + (editable ? 36 : 16),
  render: ({ cell, editable }) => {
    const text = trackingFlagsDisplayText(cell);
    return editable ? (
      <DropdownCellAffordance text={text} />
    ) : (
      <span class="w-full truncate text-left">{text}</span>
    );
  },
  renderEditor: ({ cell, coordinate, commit, onFocus, close }) =>
    isTrackingFlagsCell(cell) ? (
      <TrackingFlagsCellSelect
        cell={cell}
        onFocus={onFocus}
        onCommit={(selectedIds, trackingMode) => {
          commit((original) =>
            isTrackingFlagsCell(original) && canEditTrackingFlagsCell(original)
              ? makeTrackingFlagsEditedCell(original, selectedIds, trackingMode)
              : undefined,
          );
          onFocus();
          close();
        }}
      />
    ) : (
      <span data-invalid-rich-cell={coordinate.join(":")} />
    ),
  makeDeletedCell: (cell) =>
    isTrackingFlagsCell(cell)
      ? makeTrackingFlagsEditedCell(cell, [])
      : undefined,
  makePastedCell: (cell, value) =>
    isTrackingFlagsCell(cell) && value.trim() === ""
      ? makeTrackingFlagsEditedCell(cell, [])
      : undefined,
  startsEditing: (event) => event.key === " ",
};
