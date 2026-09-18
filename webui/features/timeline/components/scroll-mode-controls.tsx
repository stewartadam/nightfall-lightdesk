// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { NativeSelect } from "../../../components/ui/form-controls";
import { useTimelineContext } from "../context/timeline-context";
import { refocusTimelinePanel } from "../services/timeline-panel-focus";

export const ScrollMode = {
  FREE: "free",
  CENTER_LOCK: "center",
  FOLLOW: "follow",
} as const;

export type ScrollMode = (typeof ScrollMode)[keyof typeof ScrollMode];

/** Chooses how the viewport follows playback and returns focus to the timeline. */
export const ScrollModeControls = () => {
  const ctx = useTimelineContext();

  /** Publishes the selected scroll behavior and restores panel keyboard ownership. */
  const handleChange = (event: Event) => {
    const value = (event.currentTarget as HTMLSelectElement)
      .value as ScrollMode;
    ctx.setScrollMode(value);
    refocusTimelinePanel(
      event.currentTarget as HTMLSelectElement,
      ctx.componentId,
    );
  };

  return (
    <div class="flex w-24 shrink-0 items-center">
      <NativeSelect
        density="compact"
        value={ctx.scrollMode()}
        aria-label="Timeline scroll mode"
        onChange={handleChange}
      >
        <option value={ScrollMode.FREE}>Free</option>
        <option value={ScrollMode.CENTER_LOCK}>Center</option>
        <option value={ScrollMode.FOLLOW}>Follow</option>
      </NativeSelect>
    </div>
  );
};
