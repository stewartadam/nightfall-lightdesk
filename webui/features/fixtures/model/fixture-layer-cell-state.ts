// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type FixtureValueSourceState,
  type FixtureValueWinningSource,
  fixtureValueSourceForLayer,
} from "../../../lib/fixture-value-state";
import { normalizeAttributeName } from "../../../lib/utils";
import type * as types from "../../../types";

export interface FixtureLayerCellState {
  sourceStates: ReadonlyMap<string, FixtureValueSourceState>;
  transitioning: ReadonlySet<string>;
}

type MutableFixtureValueSourceState = {
  winningSource: FixtureValueWinningSource | null;
  hasManualAssertion: boolean;
};

type AggregateFixtureValueSourceState = {
  fixtureUid: string;
  attribute: string;
  elementIndexes: Set<number>;
};

type TransitioningFixtureAttributeLookup = ReadonlySet<string>;

const EMPTY_FIXTURE_VALUE_SOURCE_STATE: FixtureValueSourceState = {
  winningSource: null,
  hasShadowedManual: false,
};

/** Builds a stable lookup key for layer-derived fixture cell styling state. */
export function fixtureLayerCellKey(
  fixtureUid: string,
  elementIndex: number | undefined,
  attribute: string,
): string {
  return `${fixtureUid}|${elementIndex ?? ""}|${normalizeAttributeName(attribute)}`;
}

/** Records one concrete fixture value assertion into the source-state accumulator. */
function recordSourceAssertion(
  sourceStates: Map<string, MutableFixtureValueSourceState>,
  aggregateSourceStates: Map<string, AggregateFixtureValueSourceState>,
  fixtureUid: string,
  elementIndex: number,
  attribute: string,
  source: FixtureValueWinningSource,
): void {
  const concreteKey = fixtureLayerCellKey(fixtureUid, elementIndex, attribute);
  const state = sourceStates.get(concreteKey) ?? {
    winningSource: null,
    hasManualAssertion: false,
  };

  if (source === "manual") {
    state.hasManualAssertion = true;
  }
  state.winningSource = source;
  sourceStates.set(concreteKey, state);

  const aggregateKey = fixtureLayerCellKey(fixtureUid, undefined, attribute);
  const aggregateState = aggregateSourceStates.get(aggregateKey) ?? {
    fixtureUid,
    attribute,
    elementIndexes: new Set<number>(),
  };
  aggregateState.elementIndexes.add(elementIndex);
  aggregateSourceStates.set(aggregateKey, aggregateState);
}

/** Builds normalized keys for transition flags reported by one layer snapshot. */
function buildTransitioningFixtureAttributeLookup(
  rows: readonly types.OutboundElementTransitionState[],
): TransitioningFixtureAttributeLookup {
  const transitioning = new Set<string>();

  for (const fixtureRow of rows) {
    fixtureRow.parameters.forEach((parameters, index) => {
      for (const [attribute, isTransitioning] of Object.entries(parameters)) {
        if (!isTransitioning) continue;
        const normalizedAttribute = normalizeAttributeName(attribute);
        transitioning.add(
          fixtureLayerCellKey(
            fixtureRow.fixture_uid,
            index + 1,
            normalizedAttribute,
          ),
        );
        transitioning.add(
          fixtureLayerCellKey(
            fixtureRow.fixture_uid,
            undefined,
            normalizedAttribute,
          ),
        );
      }
    });
  }

  return transitioning;
}

/** Records one concrete fixture transition value owned by the current asserting layer. */
function recordTransitionAssertion(
  transitions: Map<string, boolean>,
  transitioning: TransitioningFixtureAttributeLookup,
  fixtureUid: string,
  elementIndex: number,
  attribute: string,
): void {
  const concreteKey = fixtureLayerCellKey(fixtureUid, elementIndex, attribute);
  const aggregateKey = fixtureLayerCellKey(fixtureUid, undefined, attribute);
  transitions.set(concreteKey, transitioning.has(concreteKey));
  transitions.set(aggregateKey, transitioning.has(aggregateKey));
}

/** Visits every asserted fixture attribute in one row set. */
function visitAssertedFixtureAttributes(
  rows: readonly types.OutboundElementParameterValues[],
  visitor: (
    fixtureUid: string,
    elementIndex: number,
    attribute: string,
  ) => void,
): void {
  for (const fixtureRow of rows) {
    fixtureRow.parameters.forEach((parameters, index) => {
      for (const attribute of Object.keys(parameters)) {
        visitor(
          fixtureRow.fixture_uid,
          index + 1,
          normalizeAttributeName(attribute),
        );
      }
    });
  }
}

/** Converts mutable concrete source tracking into a display-ready source state. */
function finishConcreteSourceState(
  state: MutableFixtureValueSourceState,
): FixtureValueSourceState {
  return {
    winningSource: state.winningSource,
    hasShadowedManual:
      state.hasManualAssertion && state.winningSource !== "manual",
  };
}

/** Aggregates element-local source states for one parent fixture row cell. */
function finishAggregateSourceState(
  sourceStates: ReadonlyMap<string, FixtureValueSourceState>,
  aggregateState: AggregateFixtureValueSourceState,
): FixtureValueSourceState {
  const states = [...aggregateState.elementIndexes]
    .sort((left, right) => left - right)
    .map((elementIndex) =>
      sourceStates.get(
        fixtureLayerCellKey(
          aggregateState.fixtureUid,
          elementIndex,
          aggregateState.attribute,
        ),
      ),
    )
    .filter((state): state is FixtureValueSourceState => state !== undefined);
  const firstWinningSource = states[0]?.winningSource ?? null;
  const hasUniformWinningSource = states.every(
    (state) => state.winningSource === firstWinningSource,
  );

  if (!hasUniformWinningSource) {
    return EMPTY_FIXTURE_VALUE_SOURCE_STATE;
  }

  return {
    winningSource: firstWinningSource,
    hasShadowedManual:
      firstWinningSource !== null &&
      states.every((state) => state.hasShadowedManual),
  };
}

/** Builds layer-derived fixture cell source and transition lookups for the Fixtures grid. */
export function buildFixtureLayerCellState(
  layers: readonly types.OutboundLayerState[],
): FixtureLayerCellState {
  const mutableSourceStates = new Map<string, MutableFixtureValueSourceState>();
  const aggregateSourceStates = new Map<
    string,
    AggregateFixtureValueSourceState
  >();
  const transitionOwnership = new Map<string, boolean>();

  for (const layer of layers) {
    const source = fixtureValueSourceForLayer(layer);
    const transitioning = buildTransitioningFixtureAttributeLookup(
      layer.computed_transitioning,
    );
    const visitor = (
      fixtureUid: string,
      elementIndex: number,
      attribute: string,
    ) => {
      recordSourceAssertion(
        mutableSourceStates,
        aggregateSourceStates,
        fixtureUid,
        elementIndex,
        attribute,
        source,
      );
      recordTransitionAssertion(
        transitionOwnership,
        transitioning,
        fixtureUid,
        elementIndex,
        attribute,
      );
    };

    visitAssertedFixtureAttributes(layer.asserted_absolute_values, visitor);
    visitAssertedFixtureAttributes(layer.asserted_relative_values, visitor);
  }

  const sourceStates = new Map<string, FixtureValueSourceState>();
  for (const [key, state] of mutableSourceStates) {
    sourceStates.set(key, finishConcreteSourceState(state));
  }
  for (const [key, state] of aggregateSourceStates) {
    sourceStates.set(key, finishAggregateSourceState(sourceStates, state));
  }

  const transitioning = new Set<string>();
  for (const [key, isTransitioning] of transitionOwnership) {
    if (isTransitioning) {
      transitioning.add(key);
    }
  }

  return {
    sourceStates,
    transitioning,
  };
}
