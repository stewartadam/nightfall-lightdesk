// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { engineRuntime } from "../../lib/engine-runtime";
import { activeInstances, timecodes } from "../../state/appStores";
import type { InstanceCommand, TimecodeCommand } from "../../types";

export { isPlaybackRunning } from "./progress";

/** Stops running timelines first so they cannot relaunch clips, then every playback instance. */
export function stopAllPlayback(): void {
  for (const [timecode, state] of Object.values(timecodes.get())) {
    if (!state.is_active) continue;
    const command: TimecodeCommand = {
      type: "StopTimecode",
      data: timecode.identifiers.id,
    };
    engineRuntime.sendCommand({ module: "TimecodeCommand", command });
  }
  if (Object.keys(activeInstances.get()).length === 0) return;
  const command: InstanceCommand = { type: "StopAll", data: undefined };
  engineRuntime.sendCommand({ module: "InstanceCommand", command });
}
