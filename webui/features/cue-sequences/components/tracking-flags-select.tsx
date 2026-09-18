// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  PrelineAdvancedSelect,
  type PrelineAdvancedSelectOption,
} from "../../../components/widgets/advanced-select";
import {
  TRACKING_FLAG_OPTIONS,
  type TrackingFlagId,
  trackingFlagsSummaryFromIds,
} from "../model/tracking-flags";

const TRACKING_FLAG_SELECT_OPTIONS: readonly PrelineAdvancedSelectOption[] =
  TRACKING_FLAG_OPTIONS.map((option) => ({
    value: option.id,
    label: option.label,
  }));

/**
 * Returns whether a string is one of the selectable tracking flag ids.
 */
function isTrackingFlagId(value: string): value is TrackingFlagId {
  return TRACKING_FLAG_OPTIONS.some((option) => option.id === value);
}

/**
 * Narrows generic Preline selected values back to tracking flag ids.
 */
function selectedTrackingFlagIds(
  selectedValues: readonly string[],
): readonly TrackingFlagId[] {
  return selectedValues.filter(isTrackingFlagId);
}

/**
 * Renders a Preline Advanced Select for editing cue tracking flags.
 */
export function TrackingFlagsAdvancedSelect(props: {
  selectedIds: readonly TrackingFlagId[];
  onSelectedIdsChange: (selectedIds: readonly TrackingFlagId[]) => void;
  ariaLabel?: string;
  containerClass?: string;
  selectIdPrefix?: string;
  variant?: "panel" | "grid";
  openOnMount?: boolean;
}) {
  return (
    <PrelineAdvancedSelect
      options={TRACKING_FLAG_SELECT_OPTIONS}
      selectedValues={props.selectedIds}
      onSelectedValuesChange={(selectedValues) =>
        props.onSelectedIdsChange(selectedTrackingFlagIds(selectedValues))
      }
      ariaLabel={props.ariaLabel}
      containerClass={props.containerClass}
      selectIdPrefix={props.selectIdPrefix}
      variant={props.variant}
      multiple
      openOnMount={props.openOnMount}
      toggleSummaryText={(selectedValues) =>
        trackingFlagsSummaryFromIds(selectedTrackingFlagIds(selectedValues))
      }
    />
  );
}
