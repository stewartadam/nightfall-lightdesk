// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Leading columns that name a row and stay pinned while the list scrolls sideways. */
const FROZEN_LEADING_COLUMN_IDS = new Set(["marker", "id", "label"]);

/**
 * Counts the leading marker, ID and Label columns to pin at the start of an
 * object list, so a row stays identifiable while later columns scroll
 * horizontally. Always pins at least the first visible column.
 */
export function frozenLeadingColumnCount(
  columns: readonly { id: string }[],
): number {
  let count = 0;
  while (
    count < columns.length &&
    FROZEN_LEADING_COLUMN_IDS.has(columns[count]!.id.toLowerCase())
  ) {
    count += 1;
  }
  return Math.max(count, 1);
}
