// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";

/**
 * Builds a selection expression naming exactly these fixtures or fixture elements, in order and
 * once each. Returns `undefined` when there are no refs, so callers skip commands that would act
 * on the active selection instead.
 */
export function resolvedSelectionExpr(
  fixtureRefs: readonly types.FixtureRef[],
): types.SelectionExpr | undefined {
  const seen = new Set<string>();
  const refs: types.FixtureRef[] = [];
  for (const ref of fixtureRefs) {
    const key = `${ref.fixture_uid}:${ref.index ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs.length > 0 ? { type: "Resolved", data: refs } : undefined;
}

/** Wraps {@link resolvedSelectionExpr} in the spatial selection that attribute commands take. */
export function resolvedSpatialSelection(
  fixtureRefs: readonly types.FixtureRef[],
): types.SpatialSelection | undefined {
  const source = resolvedSelectionExpr(fixtureRefs);
  return source ? { source, clauses: [] } : undefined;
}
