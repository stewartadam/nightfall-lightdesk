// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";
import { normalizeFixtureUid } from "./binding-utils";
import { projectResolvedSpatialSelection } from "./wasm-bridge";

/** Returns a stable key for one resolved fixture or fixture element reference. */
export function fixtureRefKey(ref: types.FixtureRef): string {
  return `${normalizeFixtureUid(ref.fixture_uid).toLowerCase()}:${ref.index ?? "fixture"}`;
}

/** Returns refs in first-seen order without duplicate fixture references. */
export function uniqueFixtureRefs(
  refs: readonly types.FixtureRef[],
): types.FixtureRef[] {
  const seen = new Set<string>();
  const uniqueRefs: types.FixtureRef[] = [];
  for (const ref of refs) {
    const key = fixtureRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueRefs.push(ref);
  }
  return uniqueRefs;
}

/** Resolves selection-expression set operations whose leaves already carry concrete fixtures. */
export async function resolvedFixtureRefsForSource(
  source: types.SelectionExpr,
): Promise<types.FixtureRef[]> {
  switch (source.type) {
    case "Resolved":
      return uniqueFixtureRefs(source.data);
    case "Add": {
      const lhs = await resolvedFixtureRefsForSource(source.data.lhs);
      const rhs = await resolvedFixtureRefsForSource(source.data.rhs);
      return uniqueFixtureRefs([...lhs, ...rhs]);
    }
    case "Sub": {
      const lhs = await resolvedFixtureRefsForSource(source.data.lhs);
      const rhs = await resolvedFixtureRefsForSource(source.data.rhs);
      const rhsKeys = new Set(rhs.map(fixtureRefKey));
      return lhs.filter((ref) => !rhsKeys.has(fixtureRefKey(ref)));
    }
    case "Span":
      return resolvedFixtureRefsForSource(source.data);
    case "Spatial":
      return resolvedFixtureRefsForSelection(source.data);
    default:
      return [];
  }
}

/** Projects resolved fixture refs through spatial clauses and union branches. */
export async function resolvedFixtureRefsForSelection(
  selection: types.SpatialSelection,
): Promise<types.FixtureRef[]> {
  const projectedRefs: types.FixtureRef[] = [];
  const sourceRefs = await resolvedFixtureRefsForSource(selection.source);
  if (sourceRefs.length > 0) {
    const projected = await projectResolvedSpatialSelection({
      ...selection,
      source: { type: "Resolved", data: sourceRefs },
      union: [],
    });
    for (const index of projected?.resolved.indexes ?? []) {
      for (const member of index.members) {
        projectedRefs.push({ ...member.fixture });
      }
    }
  }

  for (const unionSelection of selection.union ?? []) {
    projectedRefs.push(
      ...(await resolvedFixtureRefsForSelection(unionSelection)),
    );
  }

  return uniqueFixtureRefs(projectedRefs);
}
