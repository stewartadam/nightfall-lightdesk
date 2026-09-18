// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type * as types from "../types";
import { ObjectType } from "../types";
import {
  fixtureValueSourceForLayer,
  fixtureValueSourceState,
  isManualAssertionLayer,
  isProgrammerAssertionLayer,
  isTransportInputAssertionLayer,
} from "./fixture-value-state";

/** Builds a compact layer fixture row for source-state tests. */
function row(
  fixtureUid: string,
  parameters: Array<Record<string, types.ParameterValue>>,
): types.OutboundElementParameterValues {
  return { fixture_uid: fixtureUid, parameters };
}

/** Builds a compact layer state for source-state tests. */
function layer(
  objectRef: types.ObjectRef | undefined,
  parameters: Array<Record<string, types.ParameterValue>>,
  creator = "Test",
): types.OutboundLayerState {
  return {
    creator,
    object_ref: objectRef,
    priority: 0,
    is_releasing: false,
    asserted_absolute_values: [row("fixture-a", parameters)],
    asserted_relative_values: [],
    lookahead_asserted_values: [],
    computed_values: [],
    computed_transitioning: [],
  };
}

/** Builds an object reference for compositor-owned assertion layers. */
function parameterLayerRef(id: number): types.ObjectRef {
  return {
    type: "ById",
    data: { object_type: ObjectType.Parameter, id },
  };
}

const manualLayer = layer(parameterLayerRef(1), [
  { Red: { type: "Absolute", data: { value: 1 } } },
]);
const inputLayer = layer(parameterLayerRef(0), [
  { Red: { type: "Absolute", data: { value: 1 } } },
]);
const normalLayer = layer(undefined, [
  { Red: { type: "Absolute", data: { value: 1 } } },
]);
const programmerLayer = layer(
  undefined,
  [{ Red: { type: "Absolute", data: { value: 1 } } }],
  "Programmer",
);

/** Verifies persistent assertion layers are identified by object reference. */
test("fixture value source helpers identify compositor-owned assertion layers", () => {
  assert.equal(isManualAssertionLayer(manualLayer), true);
  assert.equal(isTransportInputAssertionLayer(inputLayer), true);
  assert.equal(fixtureValueSourceForLayer(normalLayer), "normal");
});

/** Verifies programmer layers share manual source styling in fixture grids. */
test("fixture value source helpers identify programmer assertion layers as manual", () => {
  assert.equal(isProgrammerAssertionLayer(programmerLayer), true);
  assert.equal(isManualAssertionLayer(programmerLayer), true);
  assert.equal(fixtureValueSourceForLayer(programmerLayer), "manual");
  assert.equal(
    isProgrammerAssertionLayer(
      layer(
        undefined,
        [{ Red: { type: "Absolute", data: { value: 1 } } }],
        "Programmer Instruction 1",
      ),
    ),
    true,
  );
});

/** Verifies programmer-authored fixture values resolve as manual winners. */
test("fixtureValueSourceState resolves programmer values as manual", () => {
  const state = fixtureValueSourceState(
    [normalLayer, programmerLayer],
    "fixture-a",
    1,
    "Red",
  );

  assert.deepEqual(state, {
    winningSource: "manual",
    hasShadowedManual: false,
  });
});

/** Verifies the highest asserting layer supplies the winning source. */
test("fixtureValueSourceState resolves the highest asserting layer", () => {
  const state = fixtureValueSourceState(
    [inputLayer, manualLayer, normalLayer],
    "fixture-a",
    1,
    "Red",
  );

  assert.deepEqual(state, {
    winningSource: "normal",
    hasShadowedManual: true,
  });
});

/** Verifies manual winning state is not reported as shadowed. */
test("fixtureValueSourceState resolves manual winning state", () => {
  const state = fixtureValueSourceState(
    [normalLayer, manualLayer],
    "fixture-a",
    1,
    "Red",
  );

  assert.deepEqual(state, {
    winningSource: "manual",
    hasShadowedManual: false,
  });
});

/** Verifies parent rows match assertions from any element. */
test("fixtureValueSourceState supports uniform parent aggregate rows", () => {
  const state = fixtureValueSourceState(
    [
      layer(parameterLayerRef(1), [
        {},
        { Red: { type: "Absolute", data: { value: 1 } } },
      ]),
    ],
    "fixture-a",
    undefined,
    "Red",
  );

  assert.deepEqual(state, {
    winningSource: "manual",
    hasShadowedManual: false,
  });
});

/** Verifies parent rows do not compare source winners across unrelated elements. */
test("fixtureValueSourceState avoids cross-element parent winner comparisons", () => {
  const state = fixtureValueSourceState(
    [
      layer(parameterLayerRef(1), [
        { Red: { type: "Absolute", data: { value: 1 } } },
        {},
      ]),
      layer(undefined, [
        {},
        { Red: { type: "Absolute", data: { value: 0.5 } } },
      ]),
    ],
    "fixture-a",
    undefined,
    "Red",
  );

  assert.deepEqual(state, {
    winningSource: null,
    hasShadowedManual: false,
  });
});
