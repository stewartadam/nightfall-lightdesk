// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Minimum raw DMX spread that is meaningful enough to show a parent aggregate conflict. */
const PARAMETER_OUTPUT_CONFLICT_DMX_THRESHOLD = 1;

/** Returns whether element outputs differ by at least one raw DMX step. */
export function outputValuesConflict(values: number[]): boolean {
  if (values.length < 2) return false;

  let min = values[0];
  let max = values[0];
  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }

  return max - min >= PARAMETER_OUTPUT_CONFLICT_DMX_THRESHOLD;
}
