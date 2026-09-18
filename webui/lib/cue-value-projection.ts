// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";
import { sameFixtureUid } from "./cue-timing-values";
import type { ProcessedParameterValue } from "./datagrid";
import { normalizeAttributeName } from "./utils";
import {
  parameterValueForValueSource,
  parameterValueToProcessedParameterValue,
  valueSourceToProcessedParameterValue,
} from "./value-source";

export type ProjectedCueInstructionValues = {
  abs: Record<string, ProcessedParameterValue>;
  rel: Record<string, ProcessedParameterValue>;
  release: Set<string>;
};

/** Returns whether a fixture ref targets the whole fixture rather than one element. */
function isWholeFixtureRef(ref: types.FixtureRef): boolean {
  return ref.index === null || ref.index === undefined;
}

/** Returns whether two fixture refs point at the same fixture and element scope. */
function sameFixtureRef(
  left: types.FixtureRef,
  right: types.FixtureRef,
): boolean {
  return (
    sameFixtureUid(left.fixture_uid, right.fixture_uid) &&
    (left.index ?? undefined) === (right.index ?? undefined)
  );
}

/**
 * Finds the selection position whose value source should apply to a displayed row.
 *
 * Element rows prefer an exact element ref, then inherit a whole-fixture ref when
 * the instruction selected the full fixture. Parent rows only match whole-fixture
 * refs so element-only assertions do not appear as fixture-wide values.
 */
export function valueSourcePositionForFixtureRef(
  selectionRefs: readonly types.FixtureRef[],
  fixtureRef: types.FixtureRef,
): number | undefined {
  const exactIndex = selectionRefs.findIndex((ref) =>
    sameFixtureRef(ref, fixtureRef),
  );
  if (exactIndex >= 0) return exactIndex;

  if (isWholeFixtureRef(fixtureRef)) return undefined;

  const wholeFixtureIndex = selectionRefs.findIndex(
    (ref) =>
      sameFixtureUid(ref.fixture_uid, fixtureRef.fixture_uid) &&
      isWholeFixtureRef(ref),
  );
  return wholeFixtureIndex >= 0 ? wholeFixtureIndex : undefined;
}

/** Projects instruction values onto one displayed fixture or fixture-element row. */
export function projectCueInstructionValuesForFixtureRef(
  values: Record<string, types.ValueSource> | undefined,
  selectionRefs: readonly types.FixtureRef[],
  fixtureRef: types.FixtureRef,
): ProjectedCueInstructionValues {
  const projected: ProjectedCueInstructionValues = {
    abs: {},
    rel: {},
    release: new Set<string>(),
  };
  const position = valueSourcePositionForFixtureRef(selectionRefs, fixtureRef);
  if (position === undefined) return projected;

  for (const [attr, source] of Object.entries(values ?? {})) {
    const normalizedAttr = normalizeAttributeName(attr);
    if (source.type === "Release") {
      projected.release.add(normalizedAttr);
      continue;
    }

    const value =
      source.type === "Inline" || source.type === "Fanned"
        ? parameterValueForValueSource(source, position, selectionRefs.length)
        : undefined;
    const processedValue = value
      ? parameterValueToProcessedParameterValue(value)
      : valueSourceToProcessedParameterValue(source);
    if (!processedValue) continue;

    if (processedValue.isRelative) {
      projected.rel[normalizedAttr] = processedValue;
    } else {
      projected.abs[normalizedAttr] = processedValue;
    }
  }

  return projected;
}
