// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";
import { parseDurationInput } from "./datagrid-rich-cell-helpers";
import { getLogger } from "./logger";
import { splitFanInput } from "./value-fan";
import { loadedWasmBridge } from "./wasm-module";

const log = getLogger(import.meta.url);

/** Parses a timing fan expression into ordered duration waypoints. */
export function parseTimingFanInput(input: string): types.Duration[] | null {
  const values = splitFanInput(input);
  if (!values) return null;

  const durations = values.map((value) =>
    parseDurationInput(value, { minMs: 0 }),
  );
  if (durations.some((duration) => duration === null)) return null;
  return durations as types.Duration[];
}

/**
 * Resolves one fixed duration per target from timing fan waypoints, with the
 * same rules cue playback uses for a fanned (manual) transition mode. Returns
 * null while the WASM bridge is still loading.
 */
export function fanTimingDurations(
  durations: readonly types.Duration[],
  total: number,
): types.Duration[] | null {
  const wasm = loadedWasmBridge();
  if (!wasm) {
    log.warn(
      "Timing fan edit ignored because the WASM bridge has not loaded yet",
    );
    return null;
  }
  const mode: types.TransitionMode = {
    type: "Manual",
    data: [...durations],
  };
  const requests = Array.from({ length: Math.max(0, total) }, (_, offset) => ({
    mode,
    offset,
    total,
  }));
  return wasm.resolve_transition_modes(requests) as types.Duration[];
}
