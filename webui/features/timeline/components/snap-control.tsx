// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ToggleToolbarButton } from "../../../components/ui/toolbar-button";
import { useTimelineContext } from "../context/timeline-context";

/** Toggles snapping using the same pressed-state presentation as other toolbars. */
export const SnapControl = () => {
  const context = useTimelineContext();

  /** Updates the active timeline grid snapping preference. */
  const handleToggleSnap = () => {
    context.setSnapEnabled(!context.snapEnabled());
  };

  return (
    <ToggleToolbarButton
      type="button"
      label="Snap"
      onClick={handleToggleSnap}
      pressed={context.snapEnabled()}
      tooltip={
        context.snapEnabled() ? "Disable grid snapping" : "Enable grid snapping"
      }
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M3 3v18h18" />
        <path d="M9 9v8" />
        <path d="M9 17h8" />
        <path d="M17 9v8" />
      </svg>
    </ToggleToolbarButton>
  );
};
