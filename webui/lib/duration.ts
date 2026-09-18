// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Duration, TransitionMode } from "../types";

export const ZERO_DURATION: Duration = { secs: 0, nanos: 0 };

export function durationToMs(duration: Duration | undefined): number {
  if (!duration) return 0;
  return duration.secs * 1000 + duration.nanos / 1_000_000;
}

export function durationToSeconds(duration: Duration | undefined): number {
  return durationToMs(duration) / 1000;
}

export function msToDuration(ms: number): Duration {
  const normalizedMs = Math.max(0, ms);
  return {
    secs: Math.trunc(normalizedMs / 1000),
    nanos: Math.trunc((normalizedMs % 1000) * 1_000_000),
  };
}

export function secondsToDuration(seconds: number): Duration {
  return msToDuration(seconds * 1000);
}

export function secondsNearlyEqual(
  left: number,
  right: number,
  toleranceSeconds = 0.0005,
): boolean {
  return Math.abs(left - right) < toleranceSeconds;
}

export function durationsNearlyEqual(
  left: Duration | undefined,
  right: Duration | undefined,
  toleranceMs = 0.5,
): boolean {
  return Math.abs(durationToMs(left) - durationToMs(right)) < toleranceMs;
}

export function transitionModeToDuration(
  mode: TransitionMode | undefined,
): Duration {
  if (!mode) return ZERO_DURATION;
  switch (mode.type) {
    case "Fixed":
      return mode.data;
    case "Interpolated":
      return mode.data.start;
    case "Manual":
      return mode.data[0] ?? ZERO_DURATION;
  }
}

export function transitionModeToSeconds(
  mode: TransitionMode | undefined,
): number {
  return durationToSeconds(transitionModeToDuration(mode));
}
