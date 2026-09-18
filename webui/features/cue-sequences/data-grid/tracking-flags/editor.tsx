// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Show } from "solid-js";
import { TrackingFlagsAdvancedSelect } from "../../components/tracking-flags-select";
import {
  type TrackingFlagId,
  trackingFlagsSummaryFromIds,
} from "../../model/tracking-flags";
import type {
  TrackingFlagsCellData,
  TrackingFlagsCellMode,
  TrackingFlagsGridCell,
} from "./model";

/** Preserves existing grid selections when Preline reports one newly added flag as a replacement. */
function normalizeTrackingFlagCommit(
  previousIds: readonly TrackingFlagId[],
  selectedIds: readonly TrackingFlagId[],
): readonly TrackingFlagId[] {
  const selectedId = selectedIds[0];
  if (
    selectedIds.length === 1 &&
    previousIds.length > 1 &&
    selectedId !== undefined &&
    !previousIds.includes(selectedId)
  ) {
    return [...previousIds, selectedId];
  }
  return selectedIds;
}

/** Formats non-editable tracking cell content. */
function trackingCellText(data: TrackingFlagsCellData): string {
  return data.trackingMode === "Inherit"
    ? `Inherit: ${data.inheritedSummary ?? "Sequence"}`
    : trackingFlagsSummaryFromIds(data.selectedIds);
}

/**
 * Renders a Preline Advanced Select for editing tracking flag cells.
 */
export function TrackingFlagsCellSelect(props: {
  cell: TrackingFlagsGridCell;
  onCommit: (
    selectedIds: readonly TrackingFlagId[],
    trackingMode?: TrackingFlagsCellMode,
  ) => void;
  onFocus: () => void;
}) {
  const initialSelectedIds = [...props.cell.data.selectedIds];

  /** Returns whether the current tracking flags cell can be edited. */
  const editable = () =>
    props.cell.allowOverlay === true && props.cell.readonly !== true;
  /** Returns whether this cell exposes cue-level inherit/override behavior. */
  const hasTrackingMode = () => props.cell.data.trackingMode !== undefined;

  return (
    <Show
      when={editable()}
      fallback={
        <span class="w-full truncate text-left">
          {trackingCellText(props.cell.data)}
        </span>
      }
    >
      <div
        class="flex h-full w-full items-center gap-1 overflow-hidden"
        onFocusIn={props.onFocus}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <Show when={hasTrackingMode()}>
          <select
            aria-label="Choose tracking mode"
            class="h-full min-w-[5.75rem] border border-neutral-600 bg-[#101014] px-1 text-xs text-neutral-100 outline-none focus:border-blue-500"
            value={props.cell.data.trackingMode}
            onChange={(event) =>
              props.onCommit(
                props.cell.data.selectedIds,
                event.currentTarget.value === "Inherit" ? "Inherit" : "Flags",
              )
            }
          >
            <option value="Inherit">Inherit</option>
            <option value="Flags">Override</option>
          </select>
        </Show>
        <Show
          when={props.cell.data.trackingMode !== "Inherit"}
          fallback={
            <span class="min-w-0 flex-1 truncate px-1 text-xs text-neutral-400">
              {props.cell.data.inheritedSummary ?? "Sequence"}
            </span>
          }
        >
          <TrackingFlagsAdvancedSelect
            selectedIds={props.cell.data.selectedIds}
            onSelectedIdsChange={(selectedIds) =>
              props.onCommit(
                normalizeTrackingFlagCommit(initialSelectedIds, selectedIds),
                props.cell.data.trackingMode,
              )
            }
            ariaLabel="Choose tracking flags"
            containerClass="h-full min-w-0 flex-1"
            selectIdPrefix="tracking-flags-cell-select"
            variant="grid"
            openOnMount
          />
        </Show>
      </div>
    </Show>
  );
}
