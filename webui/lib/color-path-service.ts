// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";
import { FadeCurve } from "../types";
import { commandEnvelope } from "./command-envelope";
import { engineRuntime } from "./engine-runtime";
import { getLogger } from "./logger";

const log = getLogger(import.meta.url);

/** Stores a color path definition through the cue command channel. */
export function storeColorPath(colorPath: types.ColorPath): void {
  const command: types.CueCommand = {
    type: "StoreColorPath",
    data: colorPath,
  };
  engineRuntime.sendCommand(commandEnvelope("CueCommand", command));
  log.info(`Stored color path ${colorPath.identifiers.id}:`, colorPath);
}

/** Deletes a color path definition by numeric ID. */
export function deleteColorPath(id: number): void {
  const command: types.CueCommand = {
    type: "DeleteColorPath",
    data: id,
  };
  engineRuntime.sendCommand(commandEnvelope("CueCommand", command));
  log.info(`Deleted color path ${id}`);
}

/** Builds a new custom color path with default timing and interpolation settings. */
export function createDefaultColorPath(
  id: number,
  label = `Color Path ${id}`,
): types.ColorPath {
  return {
    identifiers: {
      id,
      uid: crypto.randomUUID().replace(/-/g, ""),
      label,
    },
    interpolation_space: "Hsv" as types.ColorInterpolationSpace,
    hue_direction: "Shortest" as types.HueDirection,
    timing: {
      in_color: undefined,
      out_color: undefined,
      brightness_percent: undefined,
      attributes: {},
    },
    curve: FadeCurve.Linear,
  };
}
