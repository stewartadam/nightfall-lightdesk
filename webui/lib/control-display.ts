// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

const CONTROL_DISPLAY_EPSILON = 0.5;

export function shouldShowDisparateControlValues(
  hardwareValue: number,
  consoleValue: number,
): boolean {
  return Math.abs(hardwareValue - consoleValue) > CONTROL_DISPLAY_EPSILON;
}
