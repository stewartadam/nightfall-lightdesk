// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";
import { parseDurationInput } from "./datagrid-rich-cell-helpers";
import { durationToMs, msToDuration } from "./duration";

/** Parses a timing fan expression into ordered duration waypoints. */
export function parseTimingFanInput(input: string): types.Duration[] | null {
  if (!input.includes(">")) return null;
  const values = input.split(">");
  if (values.length < 2 || values.some((value) => value.trim() === "")) {
    return null;
  }

  const durations = values.map((value) =>
    parseDurationInput(value.trim(), { minMs: 0 }),
  );
  if (durations.some((duration) => duration === null)) return null;
  return durations as types.Duration[];
}

/** Resolves one fixed duration from fan waypoints at a target offset. */
export function resolveTimingFanDuration(
  durations: readonly types.Duration[],
  offset: number,
  total: number,
): types.Duration {
  const first = durations[0] ?? msToDuration(0);
  if (durations.length <= 1 || total <= 1) return first;

  const t = offset / Math.max(1, total - 1);
  const maxSegment = durations.length - 1;
  const segmentPosition = t * maxSegment;
  const segmentIndex = Math.min(Math.floor(segmentPosition), maxSegment - 1);
  const segmentT = segmentPosition - segmentIndex;
  const start = durationToMs(durations[segmentIndex] ?? first);
  const end = durationToMs(durations[segmentIndex + 1] ?? first);
  return msToDuration(start + segmentT * (end - start));
}
