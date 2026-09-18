// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { SceneObjectType } from "../../../types";
import type { RenderableFixture, RenderableSceneObject } from "../model/types";
import { buildVisualizerOverlayLabels } from "./use-visualizer-renderer-sync";

/**
 * Creates the fixture fields needed by visualizer renderer sync tests.
 */
function fixture(
  uid: string,
  fixtureId: number,
  position = { x: 0, y: 0, z: 0 },
): RenderableFixture {
  return {
    uid,
    fixtureId,
    make: "Generic",
    model: "Dimmer",
    position,
    rotation: { x: 0, y: 0, z: 0 },
    elements: [],
  };
}

/**
 * Creates the scene-object fields needed by overlay label tests.
 */
function sceneObject(
  uid: string,
  sceneObjectId: number,
): RenderableSceneObject {
  return {
    uid,
    sceneObjectId,
    objectType: SceneObjectType.Custom,
    label: "Object",
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    properties: { type: "Custom", data: { modelPath: "", scale: 1 } },
  };
}

test("buildVisualizerOverlayLabels uses renderable fixture and scene object ids", () => {
  assert.deepEqual(
    buildVisualizerOverlayLabels(
      [fixture("fixture-a", 101)],
      [sceneObject("scene-object-a", 7)],
    ),
    {
      "fixture-a": "101",
      "scene-object-a": "7",
    },
  );
});

test("buildVisualizerOverlayLabels reflects fixture additions and placement-only updates", () => {
  const initialLabels = buildVisualizerOverlayLabels(
    [fixture("fixture-a", 1)],
    [],
  );
  const changedLabels = buildVisualizerOverlayLabels(
    [fixture("fixture-a", 1, { x: 2, y: 0, z: 0 }), fixture("fixture-b", 2)],
    [],
  );

  assert.deepEqual(initialLabels, { "fixture-a": "1" });
  assert.deepEqual(changedLabels, {
    "fixture-a": "1",
    "fixture-b": "2",
  });
});
