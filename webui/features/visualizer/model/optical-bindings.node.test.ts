// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type Attribute,
  DmxValueResolution,
  type FixtureElement,
  type GeometryNode,
  GeometryType,
  MergeStrategy,
  type ParameterMetadata,
} from "../../../types";
import {
  bindElementOpticalParameters,
  bindEmitterOpticalParameters,
  type OpticalParameterBinding,
} from "./optical-bindings";

/** Builds minimal source geometry without fixture-specific classification. */
function node(name: string, parentIndex: number, beam = false): GeometryNode {
  return {
    name,
    parentIndex,
    children: [],
    geometryType: beam ? GeometryType.Beam : GeometryType.Generic,
    transform: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
  };
}

/** Builds a parameter with one profile function of the given GDTF attribute. */
function parameter(
  attribute: Attribute,
  fnAttribute: string,
): ParameterMetadata {
  return {
    attribute,
    resolution: DmxValueResolution.Coarse,
    min: 0,
    max: 255,
    offset: { type: "Absolute", data: { value: 0 } },
    is_inverted: false,
    is_snap: false,
    merge_type: MergeStrategy.HTP,
    use_grandmaster: false,
    functions: [
      {
        name: fnAttribute,
        attribute: fnAttribute,
        dmx_from: 0,
        dmx_to: 255,
        physical_from: 0,
        physical_to: 1,
      },
    ],
  };
}

/** Builds an element named after the geometry its channels sit on. */
function element(
  label: string,
  parameters: ParameterMetadata[],
): FixtureElement {
  return { label, parameters } as FixtureElement;
}

/** Summarizes bindings as `element:attribute` pairs for readable assertions. */
function describe(bindings: readonly OpticalParameterBinding[] | undefined) {
  return bindings?.map(
    ({ element, parameterIndex }) =>
      `${element.label}:${element.parameters[parameterIndex].functions?.[0].attribute}`,
  );
}

/** Sibling apertures share ancestor optics, while local overrides affect only their descendants. */
test("optical control inheritance follows source geometry and specificity", () => {
  const head = element("Head", [
    parameter({ type: "Zoom" }, "Zoom"),
    parameter({ type: "Gobo" }, "Gobo1"),
  ]);
  const cellA = element("CellA", [parameter({ type: "Zoom" }, "Zoom")]);
  const other = element("Other", [parameter({ type: "Prism" }, "Prism1")]);
  const bindings = bindEmitterOpticalParameters(
    {
      nodes: [
        node("Head", -1),
        node("CellA", 0, true),
        node("CellB", 0, true),
        node("Other", -1),
      ],
      roots: [0, 3],
    },
    [head, cellA, other],
  );
  assert.deepEqual(describe(bindings.get("CellA")), [
    "CellA:Zoom",
    "Head:Gobo1",
  ]);
  assert.deepEqual(describe(bindings.get("CellB")), [
    "Head:Zoom",
    "Head:Gobo1",
  ]);
  assert.equal(bindings.has("Head"), false);
});

/** Parameters without optical functions, such as dimmers and color wheels, are never bound. */
test("optical binding skips non-optical parameters", () => {
  const cell = element("Cell", [
    parameter({ type: "Intensity" }, "Dimmer"),
    parameter({ type: "Custom", data: { label: "Color1" } }, "Color1"),
    parameter({ type: "Focus" }, "Focus1"),
  ]);
  assert.deepEqual(describe(bindElementOpticalParameters([cell])), [
    "Cell:Focus1",
  ]);
});

/** Malformed parent links cannot hang fixture loading or borrow unrelated controls. */
test("optical binding terminates malformed ancestry", () => {
  const cell = element("Cell", [parameter({ type: "Focus" }, "Focus1")]);
  const bindings = bindEmitterOpticalParameters(
    {
      nodes: [node("Cell", 0, true), node("Lost", 999, true)],
      roots: [],
    },
    [cell],
  );
  assert.deepEqual(describe(bindings.get("Cell")), ["Cell:Focus1"]);
  assert.deepEqual(describe(bindings.get("Lost")), []);
});
