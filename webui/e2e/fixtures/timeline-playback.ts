// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createRoot } from "solid-js";
import { createTimelinePlaybackController } from "../../features/timeline/controllers/timeline-playback-controller";

/** Supplies inert commands while exercising the production playback clock. */
const ignoreCommand = () => {};

export let dispose: () => void;
export const playback = createRoot((cleanup) => {
  dispose = cleanup;
  return createTimelinePlaybackController({
    isManualTriggerMode: () => false,
    loopRange: () => undefined,
    commands: {
      onPlay: ignoreCommand,
      onPause: ignoreCommand,
      onSeek: ignoreCommand,
      onStop: ignoreCommand,
    },
  });
});
