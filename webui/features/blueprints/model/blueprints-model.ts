// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Blueprint } from "../../../types";

/** Returns a new blueprint array ordered by operator-facing numeric ID. */
export function sortBlueprintsForDisplay(
  blueprints: readonly Blueprint[],
): Blueprint[] {
  return [...blueprints].sort(
    (left, right) => left.identifiers.id - right.identifiers.id,
  );
}

/** Returns the first positive blueprint ID not already in use. */
export function nextBlueprintId(blueprints: readonly Blueprint[]): number {
  const existing = new Set(
    blueprints.map((blueprint) => blueprint.identifiers.id),
  );
  let next = 1;
  while (existing.has(next)) next += 1;
  return next;
}
