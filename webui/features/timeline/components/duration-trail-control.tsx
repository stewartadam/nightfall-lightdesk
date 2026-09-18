// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ToggleToolbarButton } from "../../../components/ui/toolbar-button";
import { useTimelineContext } from "../context/timeline-context";

/** Toggles the optional duration trail overlay for timeline actions. */
export const DurationTrailControl = () => {
  const context = useTimelineContext();

  /** Flips duration trail visibility for the active timeline panel. */
  const handleToggleDurationTrails = () => {
    context.setShowDurationTrails(!context.showDurationTrails());
  };

  return (
    <ToggleToolbarButton
      type="button"
      data-timeline-duration-trail-toggle="true"
      size="labeled"
      label="Duration"
      onClick={handleToggleDurationTrails}
      pressed={context.showDurationTrails()}
      tooltip={
        context.showDurationTrails()
          ? "Hide action duration trails (D)"
          : "Show action duration trails (D)"
      }
    >
      <span aria-hidden="true" class="mr-1 inline-flex items-center">
        <span class="inline-block h-px w-3 border-t border-dotted border-current" />
        <span class="inline-block h-3 w-px bg-current" />
      </span>
      <span>Duration</span>
    </ToggleToolbarButton>
  );
};
