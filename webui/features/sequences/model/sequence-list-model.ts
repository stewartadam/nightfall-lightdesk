// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Sequence } from "../../../types";

/** Normalizes sequence identifiers for store, selection, and DOM comparisons. */
export function normalizeSequenceUid(uid: unknown): string {
  return String(uid).toLowerCase();
}

/** Returns a new sequence array ordered by operator-facing numeric ID. */
export function sortSequencesForDisplay(
  sequences: readonly Sequence[],
): Sequence[] {
  return [...sequences].sort(
    (left, right) => left.identifiers.id - right.identifiers.id,
  );
}
