// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { fixtureValueSourceState } from "../../../lib/fixture-value-state";
import type * as types from "../../../types";
import { ObjectType } from "../../../types";
import {
  buildFixtureLayerCellState,
  fixtureLayerCellKey,
} from "./fixture-layer-cell-state";

/** Builds a compact assertion row for fixture layer-cell state tests. */
function row(
  fixtureUid: string,
  parameters: Array<Record<string, types.ParameterValue>>,
): types.OutboundElementParameterValues {
  return { fixture_uid: fixtureUid, parameters };
}

/** Builds a compact transition row for fixture layer-cell state tests. */
function transitionRow(
  fixtureUid: string,
  parameters: Array<Record<string, boolean>>,
): types.OutboundElementTransitionState {
  return { fixture_uid: fixtureUid, parameters };
}

/** Builds an absolute fixture parameter value for layer-cell state tests. */
function absolute(value: number): types.ParameterValue {
  return { type: "Absolute", data: { value } };
}

/** Builds an object reference for compositor-owned assertion layers. */
function parameterLayerRef(id: number): types.ObjectRef {
  return {
    type: "ById",
    data: { object_type: ObjectType.Parameter, id },
  };
}

/** Builds a compact layer state for fixture layer-cell state tests. */
function layer(options: {
  objectRef?: types.ObjectRef;
  absoluteRows?: types.OutboundElementParameterValues[];
  relativeRows?: types.OutboundElementParameterValues[];
  transitionRows?: types.OutboundElementTransitionState[];
  creator?: string;
}): types.OutboundLayerState {
  return {
    creator: options.creator ?? "Test",
    object_ref: options.objectRef,
    priority: 0,
    is_releasing: false,
    asserted_absolute_values: options.absoluteRows ?? [],
    asserted_relative_values: options.relativeRows ?? [],
    lookahead_asserted_values: [],
    computed_values: [],
    computed_transitioning: options.transitionRows ?? [],
  };
}

/** Verifies indexed source states match the existing concrete and aggregate resolver. */
test("buildFixtureLayerCellState matches fixtureValueSourceState", () => {
  const layers = [
    layer({
      objectRef: parameterLayerRef(1),
      absoluteRows: [
        row("fixture-a", [{ Red: absolute(1) }, { Red: absolute(1) }]),
      ],
    }),
    layer({
      absoluteRows: [row("fixture-a", [{ Red: absolute(0.5) }, {}])],
    }),
  ];

  const state = buildFixtureLayerCellState(layers);

  assert.deepEqual(
    state.sourceStates.get(fixtureLayerCellKey("fixture-a", 1, "Red")),
    fixtureValueSourceState(layers, "fixture-a", 1, "Red"),
  );
  assert.deepEqual(
    state.sourceStates.get(fixtureLayerCellKey("fixture-a", 2, "Red")),
    fixtureValueSourceState(layers, "fixture-a", 2, "Red"),
  );
  assert.deepEqual(
    state.sourceStates.get(fixtureLayerCellKey("fixture-a", undefined, "Red")),
    fixtureValueSourceState(layers, "fixture-a", undefined, "Red"),
  );
});

/** Verifies transition flags follow the highest asserting layer for each cell. */
test("buildFixtureLayerCellState indexes transition ownership by asserting layer", () => {
  const layers = [
    layer({
      absoluteRows: [
        row("fixture-a", [{ Red: absolute(1), Blue: absolute(1) }]),
      ],
      transitionRows: [transitionRow("fixture-a", [{ Red: true, Blue: true }])],
    }),
    layer({
      absoluteRows: [row("fixture-a", [{ Red: absolute(0.5) }])],
      transitionRows: [transitionRow("fixture-a", [{ Red: false }])],
    }),
  ];

  const state = buildFixtureLayerCellState(layers);

  assert.equal(
    state.transitioning.has(fixtureLayerCellKey("fixture-a", 1, "Red")),
    false,
  );
  assert.equal(
    state.transitioning.has(fixtureLayerCellKey("fixture-a", undefined, "Red")),
    false,
  );
  assert.equal(
    state.transitioning.has(fixtureLayerCellKey("fixture-a", 1, "Blue")),
    true,
  );
  assert.equal(
    state.transitioning.has(
      fixtureLayerCellKey("fixture-a", undefined, "Blue"),
    ),
    true,
  );
});

/** Verifies internal adapter attribute names are normalized in lookup keys. */
test("buildFixtureLayerCellState normalizes fixture attribute keys", () => {
  const layers = [
    layer({
      absoluteRows: [row("fixture-a", [{ VirtualIntensity: absolute(1) }])],
      transitionRows: [
        transitionRow("fixture-a", [{ VirtualIntensity: true }]),
      ],
    }),
  ];

  const state = buildFixtureLayerCellState(layers);

  assert.deepEqual(
    state.sourceStates.get(fixtureLayerCellKey("fixture-a", 1, "Intensity")),
    {
      winningSource: "normal",
      hasShadowedManual: false,
    },
  );
  assert.equal(
    state.transitioning.has(fixtureLayerCellKey("fixture-a", 1, "Intensity")),
    true,
  );
  assert.equal(
    fixtureLayerCellKey("fixture-a", 1, "VirtualIntensity"),
    fixtureLayerCellKey("fixture-a", 1, "Intensity"),
  );
});
