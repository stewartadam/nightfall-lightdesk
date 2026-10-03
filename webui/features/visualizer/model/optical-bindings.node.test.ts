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
  type ElementParameterRef,
  type FixtureElement,
  type GeometryNode,
  GeometryType,
  MergeStrategy,
  type OpticalFunction,
  OpticalFunctionKind,
  type ParameterMetadata,
} from "../../../types";
import {
  bindElementOpticalParameters,
  bindEmitterOpticalParameters,
  type OpticalParameterBinding,
} from "./optical-bindings";

/** Builds a minimal geometry node, a beam carrying the backend's optical references when given. */
function node(
  name: string,
  parentIndex: number,
  opticalParameters?: ElementParameterRef[],
): GeometryNode {
  return {
    name,
    parentIndex,
    children: [],
    geometryType: opticalParameters ? GeometryType.Beam : GeometryType.Generic,
    transform: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    opticalParameters,
  };
}

/** Builds a parameter with one profile function, optically classified when `optical` is given. */
function parameter(
  attribute: Attribute,
  fnAttribute: string,
  optical?: OpticalFunction,
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
        optical,
      },
    ],
  };
}

/** Builds an element from its label and parameters. */
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

const ZOOM: OpticalFunction = { kind: OpticalFunctionKind.Zoom, wheel: 0 };
const GOBO: OpticalFunction = {
  kind: OpticalFunctionKind.GoboSelect,
  wheel: 1,
};
const FOCUS: OpticalFunction = { kind: OpticalFunctionKind.Focus, wheel: 0 };

/** Each beam binds the element parameters its backend references name, in reference order. */
test("beams resolve backend optical references to element parameters", () => {
  const head = element("Head", [
    parameter({ type: "Zoom" }, "Zoom", ZOOM),
    parameter({ type: "Gobo" }, "Gobo1", GOBO),
  ]);
  const cellA = element("CellA", [parameter({ type: "Zoom" }, "Zoom", ZOOM)]);
  const bindings = bindEmitterOpticalParameters(
    {
      nodes: [
        node("Head", -1),
        node("CellA", 0, [
          { element: 1, attribute: { type: "Zoom" } },
          { element: 0, attribute: { type: "Gobo" } },
        ]),
        node("CellB", 0, [
          { element: 0, attribute: { type: "Zoom" } },
          { element: 0, attribute: { type: "Gobo" } },
        ]),
      ],
      roots: [0],
    },
    [head, cellA],
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

/** References to elements or attributes the fixture does not have bind nothing. */
test("optical binding skips unknown references", () => {
  const cell = element("Cell", [parameter({ type: "Focus" }, "Focus1", FOCUS)]);
  const bindings = bindEmitterOpticalParameters(
    {
      nodes: [
        node("Cell", -1, [
          { element: 0, attribute: { type: "Focus" } },
          { element: 0, attribute: { type: "Prism" } },
          { element: 7, attribute: { type: "Focus" } },
        ]),
      ],
      roots: [0],
    },
    [cell],
  );
  assert.deepEqual(describe(bindings.get("Cell")), ["Cell:Focus1"]);
});

/** Without geometry, only parameters with backend-classified optical functions are bound. */
test("optical binding skips non-optical parameters", () => {
  const cell = element("Cell", [
    parameter({ type: "Intensity" }, "Dimmer"),
    parameter({ type: "Custom", data: { label: "Color1" } }, "Color1"),
    parameter({ type: "Focus" }, "Focus1", FOCUS),
  ]);
  assert.deepEqual(describe(bindElementOpticalParameters([cell])), [
    "Cell:Focus1",
  ]);
});
