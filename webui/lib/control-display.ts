// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

const CONTROL_DISPLAY_EPSILON = 0.5;

/**
 * Decides whether a fader shows a marker for its physical fader's position: only when a
 * physical fader has reported a position and it sits visibly away from the console level.
 */
export function shouldShowDisparateControlValues(
  hardwareValue: number | undefined,
  consoleValue: number,
): hardwareValue is number {
  return (
    hardwareValue !== undefined &&
    Math.abs(hardwareValue - consoleValue) > CONTROL_DISPLAY_EPSILON
  );
}
