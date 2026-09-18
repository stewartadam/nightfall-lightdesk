// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { TimelinePlacementPreference } from "../types";

/** Returns the effective timeline placement preference with a stable default. */
export function timelinePlacementPreference(
  value: TimelinePlacementPreference | undefined,
): TimelinePlacementPreference {
  return value ?? TimelinePlacementPreference.Playhead;
}

/** Resolves the timeline position to use for insert or paste operations. */
export function timelinePlacementPosition(options: {
  preference: TimelinePlacementPreference | undefined;
  playheadMs: number;
  cursorMs?: number;
}): number {
  if (
    timelinePlacementPreference(options.preference) ===
      TimelinePlacementPreference.Cursor &&
    options.cursorMs !== undefined
  ) {
    return options.cursorMs;
  }
  return options.playheadMs;
}
