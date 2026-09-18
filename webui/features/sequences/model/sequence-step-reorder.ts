// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Moves one sequence step to another valid index without mutating the input. */
export function reorderSequenceSteps(
  steps: string[],
  fromIndex: number,
  toIndex: number,
): string[] {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= steps.length ||
    toIndex >= steps.length ||
    fromIndex === toIndex
  ) {
    return steps;
  }
  const reordered = [...steps];
  const [moved] = reordered.splice(fromIndex, 1);
  reordered.splice(toIndex, 0, moved);
  return reordered;
}

/** Moves selected sequence rows one position while preserving their order. */
export function moveSequenceStepsByRows(
  steps: string[],
  rowIndices: number[],
  offset: -1 | 1,
): string[] {
  if (steps.length === 0 || rowIndices.length === 0) return steps;
  const normalizedRows = [...new Set(rowIndices)]
    .filter((index) => index >= 0 && index < steps.length)
    .sort((left, right) => left - right);
  if (normalizedRows.length === 0) return steps;
  if (offset === -1 && normalizedRows[0] === 0) return steps;
  if (
    offset === 1 &&
    normalizedRows[normalizedRows.length - 1] === steps.length - 1
  ) {
    return steps;
  }

  const selectedSet = new Set(normalizedRows);
  const selectedFlags = steps.map((_, index) => selectedSet.has(index));
  const reordered = [...steps];
  if (offset === -1) {
    for (let index = 1; index < reordered.length; index++) {
      if (selectedFlags[index] && !selectedFlags[index - 1]) {
        [reordered[index - 1], reordered[index]] = [
          reordered[index],
          reordered[index - 1],
        ];
        [selectedFlags[index - 1], selectedFlags[index]] = [
          selectedFlags[index],
          selectedFlags[index - 1],
        ];
      }
    }
  } else {
    for (let index = reordered.length - 2; index >= 0; index--) {
      if (selectedFlags[index] && !selectedFlags[index + 1]) {
        [reordered[index], reordered[index + 1]] = [
          reordered[index + 1],
          reordered[index],
        ];
        [selectedFlags[index], selectedFlags[index + 1]] = [
          selectedFlags[index + 1],
          selectedFlags[index],
        ];
      }
    }
  }
  return reordered;
}
