// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type GeometryNode,
  GeometryType,
  type OpticalChannel,
} from "../../../types";
import { bindEmitterOpticalChannels } from "./optical-bindings";

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

/** Builds an optical control whose source geometry determines its affected apertures. */
function channel(geometry: string, attribute: string): OpticalChannel {
  return {
    geometry,
    attribute,
    parameterKey: attribute,
    dmxMax: 255,
    functions: [],
  };
}

/** Sibling apertures share ancestor optics, while local overrides affect only their descendants. */
test("optical control inheritance follows source geometry and specificity", () => {
  const headZoom = channel("Head", "Zoom");
  const headGobo = channel("Head", "Gobo1");
  const localZoom = channel("CellA", "Zoom");
  const unrelated = channel("Other", "Prism1");
  const bindings = bindEmitterOpticalChannels({
    nodes: [
      node("Head", -1),
      node("CellA", 0, true),
      node("CellB", 0, true),
      node("Other", -1),
    ],
    roots: [0, 3],
    opticalChannels: [headZoom, headGobo, localZoom, unrelated],
  });
  assert.deepEqual(bindings.get("CellA"), [localZoom, headGobo]);
  assert.deepEqual(bindings.get("CellB"), [headZoom, headGobo]);
  assert.equal(bindings.has("Head"), false);
});

/** Malformed parent links cannot hang fixture loading or borrow unrelated controls. */
test("optical binding terminates malformed ancestry", () => {
  const control = channel("Cell", "Focus1");
  const bindings = bindEmitterOpticalChannels({
    nodes: [node("Cell", 0, true), node("Lost", 999, true)],
    roots: [],
    opticalChannels: [control],
  });
  assert.deepEqual(bindings.get("Cell"), [control]);
  assert.deepEqual(bindings.get("Lost"), []);
});
