// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../../../types";

/** Normalizes UUID text so simple and hyphenated wire representations compare equally. */
function normalizeUid(uid: string): string {
  return uid.replace(/-/g, "").toLowerCase();
}

/** Builds a normalized UID index for objects carrying user-facing identifiers. */
function identifiersByUid<T extends { identifiers: types.Identifiers }>(
  values: Record<string, T>,
): Map<string, types.Identifiers> {
  return new Map(
    Object.values(values).map((value) => [
      normalizeUid(value.identifiers.uid),
      value.identifiers,
    ]),
  );
}

/** Replaces stable group identities with their current user-facing aliases recursively. */
function groupReferenceForEditing(
  reference: types.GroupRefExpr,
  groupsByUid: ReadonlyMap<string, types.Identifiers>,
): types.GroupRefExpr {
  switch (reference.type) {
    case "ByUid": {
      const identifiers = groupsByUid.get(normalizeUid(reference.data.uid));
      return identifiers ? { type: "ById", data: identifiers.id } : reference;
    }
    case "Add":
    case "Sub":
      return {
        type: reference.type,
        data: {
          lhs: groupReferenceForEditing(reference.data.lhs, groupsByUid),
          rhs: groupReferenceForEditing(reference.data.rhs, groupsByUid),
        },
      };
    case "Span":
      return {
        type: "Span",
        data: groupReferenceForEditing(reference.data, groupsByUid),
      };
    default:
      return reference;
  }
}

/** Converts resolved fixture identities into parser-compatible fixture expressions when possible. */
function fixtureExpressionForEditing(
  fixtureRefs: readonly types.FixtureRef[],
  fixturesByUid: ReadonlyMap<string, types.Identifiers>,
): types.SelectionExpr | null {
  const expressions = fixtureRefs.map((fixtureRef) => {
    const identifiers = fixturesByUid.get(normalizeUid(fixtureRef.fixture_uid));
    if (!identifiers) return null;
    return {
      type: "Fixture",
      data: {
        fixture_id: identifiers.id,
        element_index: fixtureRef.index,
      },
    } satisfies types.SelectionExpr;
  });
  if (expressions.length === 0 || expressions.some((value) => value === null))
    return null;

  const [first, ...remaining] = expressions as types.SelectionExpr[];
  return remaining.reduce<types.SelectionExpr>(
    (lhs, rhs) => ({ type: "Add", data: { lhs, rhs } }),
    first,
  );
}

/** Rewrites identity-backed selection sources into parser-compatible editor aliases. */
function selectionExpressionForEditing(
  expression: types.SelectionExpr,
  fixturesByUid: ReadonlyMap<string, types.Identifiers>,
  groupsByUid: ReadonlyMap<string, types.Identifiers>,
): types.SelectionExpr {
  switch (expression.type) {
    case "Group":
      return {
        type: "Group",
        data: groupReferenceForEditing(expression.data, groupsByUid),
      };
    case "Resolved":
      return (
        fixtureExpressionForEditing(expression.data, fixturesByUid) ??
        expression
      );
    case "Add":
    case "Sub":
      return {
        type: expression.type,
        data: {
          lhs: selectionExpressionForEditing(
            expression.data.lhs,
            fixturesByUid,
            groupsByUid,
          ),
          rhs: selectionExpressionForEditing(
            expression.data.rhs,
            fixturesByUid,
            groupsByUid,
          ),
        },
      };
    case "Span":
      return {
        type: "Span",
        data: selectionExpressionForEditing(
          expression.data,
          fixturesByUid,
          groupsByUid,
        ),
      };
    case "Spatial":
      return {
        type: "Spatial",
        data: spatialSelectionForEditingWithIndexes(
          expression.data,
          fixturesByUid,
          groupsByUid,
        ),
      };
    default:
      return expression;
  }
}

/** Applies editor alias conversion to one spatial pipeline and all union branches. */
function spatialSelectionForEditingWithIndexes(
  selection: types.SpatialSelection,
  fixturesByUid: ReadonlyMap<string, types.Identifiers>,
  groupsByUid: ReadonlyMap<string, types.Identifiers>,
): types.SpatialSelection {
  return {
    ...selection,
    source: selectionExpressionForEditing(
      selection.source,
      fixturesByUid,
      groupsByUid,
    ),
    union: selection.union?.map((branch) =>
      spatialSelectionForEditingWithIndexes(branch, fixturesByUid, groupsByUid),
    ),
  };
}

/** Returns a display-only selection whose references can be parsed as user-facing commands. */
export function spatialSelectionForEditing(
  selection: types.SpatialSelection,
  fixtures: Record<string, types.Fixture>,
  groups: Record<string, types.Group>,
): types.SpatialSelection {
  return spatialSelectionForEditingWithIndexes(
    selection,
    identifiersByUid(fixtures),
    identifiersByUid(groups),
  );
}
