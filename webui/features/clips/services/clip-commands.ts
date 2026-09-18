// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { engineRuntime } from "../../../lib/engine-runtime";
import type * as types from "../../../types";

/** Starts the clip identified by its stable numeric command ID. */
export function startClip(clipId: number): void {
  const command: types.ClipCommand = {
    type: "StartClip",
    data: { type: "Single", data: clipId },
  };
  engineRuntime.sendCommand({ module: "ClipCommand", command });
}

/** Stops the clip identified by its stable numeric command ID. */
export function stopClip(clipId: number): void {
  const command: types.ClipCommand = {
    type: "StopClip",
    data: { type: "Single", data: clipId },
  };
  engineRuntime.sendCommand({ module: "ClipCommand", command });
}

/** Stores a complete clip snapshot through the command bus. */
export function storeClip(clip: types.Clip): void {
  const command: types.ClipCommand = {
    type: "StoreClip",
    data: clip,
  };
  engineRuntime.sendCommand({ module: "ClipCommand", command });
}

/** Changes an clip's numeric ID without changing its UID. */
export function renameClip(id: number, newId: number): void {
  const command: types.ClipCommand = {
    type: "RenameClip",
    data: { id, new_id: newId },
  };
  engineRuntime.sendCommand({ module: "ClipCommand", command });
}

/** Deletes the clip identified by its numeric command ID. */
export function deleteClip(id: number): void {
  const command: types.ClipCommand = {
    type: "DeleteClip",
    data: id,
  };
  engineRuntime.sendCommand({ module: "ClipCommand", command });
}

/** Starts or stops an clip according to its current active state. */
export function toggleClipPlayback(clipId: number, isActive: boolean): void {
  if (isActive) {
    stopClip(clipId);
  } else {
    startClip(clipId);
  }
}
