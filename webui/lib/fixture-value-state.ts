// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";
import { ObjectType } from "../types";
import { normalizeAttributeName } from "./utils";

export type FixtureValueWinningSource = "manual" | "input" | "normal";

export interface FixtureValueSourceState {
  winningSource: FixtureValueWinningSource | null;
  hasShadowedManual: boolean;
}

const TRANSPORT_INPUT_LAYER_ID = 0;
const MANUAL_ASSERTION_LAYER_ID = 1;
const EMPTY_FIXTURE_VALUE_SOURCE_STATE: FixtureValueSourceState = {
  winningSource: null,
  hasShadowedManual: false,
};

/** Returns whether a layer is the compositor-owned manual assertion layer. */
export function isManualAssertionLayer(
  layer: types.OutboundLayerState,
): boolean {
  return (
    isParameterAssertionLayer(layer, MANUAL_ASSERTION_LAYER_ID) ||
    isProgrammerAssertionLayer(layer)
  );
}

/** Returns whether a layer represents programmer-authored fixture assertions. */
export function isProgrammerAssertionLayer(
  layer: types.OutboundLayerState,
): boolean {
  return (
    layer.creator === "Programmer" ||
    layer.creator.startsWith("Programmer Instruction ")
  );
}

/** Returns whether a layer is the compositor-owned input assertion layer. */
export function isTransportInputAssertionLayer(
  layer: types.OutboundLayerState,
): boolean {
  return isParameterAssertionLayer(layer, TRANSPORT_INPUT_LAYER_ID);
}

/** Resolves the high-level source family represented by a layer. */
export function fixtureValueSourceForLayer(
  layer: types.OutboundLayerState,
): FixtureValueWinningSource {
  if (isManualAssertionLayer(layer)) return "manual";
  if (isTransportInputAssertionLayer(layer)) return "input";
  return "normal";
}

/** Returns whether a layer is one of the persistent parameter assertion layers. */
function isParameterAssertionLayer(
  layer: types.OutboundLayerState,
  id: number,
): boolean {
  return (
    layer.object_ref?.type === "ById" &&
    layer.object_ref.data.object_type === ObjectType.Parameter &&
    layer.object_ref.data.id === id
  );
}

/** Returns true when one fixture parameter row contains the requested attribute. */
function rowHasAttribute(
  rows: types.OutboundElementParameterValues[] | undefined,
  fixtureUid: string,
  elementIndex: number | undefined,
  attribute: string,
): boolean {
  if (!rows) return false;
  const fixtureRow = rows.find((row) => row.fixture_uid === fixtureUid);
  if (!fixtureRow) return false;

  const hasAttribute = (parameters: Record<string, unknown> | undefined) =>
    parameters !== undefined &&
    Object.keys(parameters).some(
      (key) => normalizeAttributeName(key) === attribute,
    );

  if (elementIndex !== undefined) {
    return hasAttribute(fixtureRow.parameters[elementIndex - 1]);
  }

  return fixtureRow.parameters.some(hasAttribute);
}

/** Returns the element indexes in one row set that assert an attribute. */
function rowElementIndexesWithAttribute(
  rows: types.OutboundElementParameterValues[] | undefined,
  fixtureUid: string,
  attribute: string,
): number[] {
  if (!rows) return [];
  const fixtureRow = rows.find((row) => row.fixture_uid === fixtureUid);
  if (!fixtureRow) return [];

  const indexes: number[] = [];
  fixtureRow.parameters.forEach((parameters, index) => {
    const hasAttribute = Object.keys(parameters).some(
      (key) => normalizeAttributeName(key) === attribute,
    );
    if (hasAttribute) {
      indexes.push(index + 1);
    }
  });
  return indexes;
}

/** Collects concrete element indexes that assert an attribute in the layer set. */
function assertedElementIndexesForAttribute(
  layers: readonly types.OutboundLayerState[],
  fixtureUid: string,
  attribute: string,
  layerFilter?: (layer: types.OutboundLayerState) => boolean,
): number[] {
  const indexes = new Set<number>();
  for (const layer of layers) {
    if (layerFilter && !layerFilter(layer)) continue;
    for (const index of rowElementIndexesWithAttribute(
      layer.asserted_absolute_values,
      fixtureUid,
      attribute,
    )) {
      indexes.add(index);
    }
    for (const index of rowElementIndexesWithAttribute(
      layer.asserted_relative_values,
      fixtureUid,
      attribute,
    )) {
      indexes.add(index);
    }
  }
  return [...indexes].sort((left, right) => left - right);
}

/** Returns whether a layer directly asserts the requested fixture attribute. */
function layerHasAssertedFixtureAttribute(
  layer: types.OutboundLayerState,
  fixtureUid: string,
  elementIndex: number | undefined,
  attribute: string,
): boolean {
  return (
    rowHasAttribute(
      layer.asserted_absolute_values,
      fixtureUid,
      elementIndex,
      attribute,
    ) ||
    rowHasAttribute(
      layer.asserted_relative_values,
      fixtureUid,
      elementIndex,
      attribute,
    )
  );
}

/** Resolves source state for a concrete fixture element value cell. */
function concreteFixtureValueSourceState(
  layers: readonly types.OutboundLayerState[],
  fixtureUid: string,
  elementIndex: number,
  attribute: string,
  layerFilter?: (layer: types.OutboundLayerState) => boolean,
): FixtureValueSourceState {
  let winningSource: FixtureValueWinningSource | null = null;
  let hasManualAssertion = false;

  for (const layer of layers) {
    if (layerFilter && !layerFilter(layer)) continue;
    if (
      !layerHasAssertedFixtureAttribute(
        layer,
        fixtureUid,
        elementIndex,
        attribute,
      )
    ) {
      continue;
    }

    const source = fixtureValueSourceForLayer(layer);
    if (source === "manual") {
      hasManualAssertion = true;
    }
    winningSource = source;
  }

  return {
    winningSource,
    hasShadowedManual: hasManualAssertion && winningSource !== "manual",
  };
}

/** Aggregates element-local source states without comparing unrelated elements. */
function aggregateFixtureValueSourceState(
  layers: readonly types.OutboundLayerState[],
  fixtureUid: string,
  attribute: string,
  layerFilter?: (layer: types.OutboundLayerState) => boolean,
): FixtureValueSourceState {
  const elementIndexes = assertedElementIndexesForAttribute(
    layers,
    fixtureUid,
    attribute,
    layerFilter,
  );
  if (elementIndexes.length === 0) {
    return EMPTY_FIXTURE_VALUE_SOURCE_STATE;
  }

  const states = elementIndexes.map((index) =>
    concreteFixtureValueSourceState(
      layers,
      fixtureUid,
      index,
      attribute,
      layerFilter,
    ),
  );
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

/** Resolves the winning and shadowed manual state for a fixture value cell. */
export function fixtureValueSourceState(
  layers: readonly types.OutboundLayerState[],
  fixtureUid: string,
  elementIndex: number | undefined,
  attribute: string,
  layerFilter?: (layer: types.OutboundLayerState) => boolean,
): FixtureValueSourceState {
  if (elementIndex === undefined) {
    return aggregateFixtureValueSourceState(
      layers,
      fixtureUid,
      attribute,
      layerFilter,
    );
  }

  return concreteFixtureValueSourceState(
    layers,
    fixtureUid,
    elementIndex,
    attribute,
    layerFilter,
  );
}
