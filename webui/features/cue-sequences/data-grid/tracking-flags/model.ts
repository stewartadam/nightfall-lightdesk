// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { CustomCell, GridCell } from "../../../../lib/data-grid-types";
import {
  type TrackingFlagId,
  trackingFlagsSummaryFromIds,
} from "../../model/tracking-flags";

export type TrackingFlagsCellMode = "Inherit" | "Flags";

export interface TrackingFlagsCellData {
  readonly kind: "tracking-flags-cell";
  readonly selectedIds: readonly TrackingFlagId[];
  readonly trackingMode?: TrackingFlagsCellMode;
  readonly inheritedSummary?: string;
}

export type TrackingFlagsGridCell = CustomCell<TrackingFlagsCellData>;

/** Formats the visible/copy text for a tracking flags grid cell. */
function trackingFlagsCellSummary(data: TrackingFlagsCellData): string {
  return data.trackingMode === "Inherit"
    ? `Inherit: ${data.inheritedSummary ?? "Sequence"}`
    : trackingFlagsSummaryFromIds(data.selectedIds);
}

/**
 * Returns whether a grid cell stores editable tracking flag selections.
 */
export function isTrackingFlagsCell(
  cell: GridCell,
): cell is TrackingFlagsGridCell {
  if (cell.kind !== "custom") return false;
  return (cell.data as { kind?: unknown }).kind === "tracking-flags-cell";
}

/**
 * Creates a tracking flags cell with updated selections and copy text.
 */
export function makeTrackingFlagsEditedCell(
  cell: TrackingFlagsGridCell,
  selectedIds: readonly TrackingFlagId[],
  trackingMode: TrackingFlagsCellMode | undefined = cell.data.trackingMode,
): TrackingFlagsGridCell {
  const data = {
    ...cell.data,
    selectedIds,
    trackingMode,
  };
  return {
    ...cell,
    data,
    copyData: trackingFlagsCellSummary(data),
  };
}
