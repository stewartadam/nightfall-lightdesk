// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { msToDuration } from "../../../lib/utils";
import type { TimelineContextType } from "../context/timeline-context-contract";

/** Toggles the current loop or creates a default loop at the playhead. */
export function toggleLoopRange(ctx: TimelineContextType) {
  const loop = ctx.loopRange();
  if (loop) {
    ctx.loopActions.setLoopRange({ ...loop, enabled: !loop.enabled });
    return;
  }
  const start = ctx.position();
  ctx.loopActions.setLoopRange({
    start: msToDuration(start),
    end: msToDuration(start + 10_000),
    enabled: true,
  });
}

/** Deletes the current timeline loop range. */
export function deleteLoopRange(ctx: TimelineContextType) {
  ctx.loopActions.setLoopRange(undefined);
}
