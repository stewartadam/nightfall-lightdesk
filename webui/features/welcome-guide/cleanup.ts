// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { engineRuntime } from "../../lib/engine-runtime";
import { activeInstances, timecodes } from "../../state/appStores";
import type {
  InstanceCommand,
  ProgrammerCommand,
  TimecodeCommand,
} from "../../types";

export { isPlaybackRunning } from "./progress";

/** Releases the Programmer's selection and values in one step, unlike the two-press Clear button. */
export function clearProgrammerCompletely(): void {
  for (const command of [
    { type: "ClearProgrammerSelection" },
    { type: "ClearProgrammerValues" },
  ] satisfies ProgrammerCommand[])
    engineRuntime.sendCommand({ module: "ProgrammerCommand", command });
}

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
