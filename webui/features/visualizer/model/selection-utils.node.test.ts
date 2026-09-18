// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from "three/webgpu";
import { SceneObjectType } from "../../../types";
import type { ExtendedFixtureInstance } from "../rendering/fixture-renderers";
import {
  getSceneObjectSelectionMeshes,
  getSelectionTargetObjects,
  SelectionHighlighter,
} from "./selection-utils";
import type { SceneObjectInstance } from "./types";

/** Build a minimal strobe-panel fixture instance for selection-target tests. */
function strobeInstance(): ExtendedFixtureInstance {
  const pixel = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  const segment = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  const fallback = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  fallback.name = "Housing";
  return {
    uid: "fixture-a",
    group: fallback,
    nodeObjects: new Map(),
    emitters: new Map([
      ["Pixel_0", { mesh: pixel, controlledElement: "Pixel 1" }],
      ["White_0", { mesh: segment, controlledElement: "White 1" }],
    ]),
    rendererType: "strobe-panel",
    elementLabels: ["Pixel 1", "White 1"],
    strobePanelData: {
      type: "strobe-panel",
      layout: "matrix",
      panelGroup: fallback,
      pixelMeshes: [pixel],
      whiteSegmentMeshes: [segment],
      elementLabels: ["Pixel 1", "White 1"],
      pixelElementLabels: ["Pixel 1"],
      whiteSegmentElementLabels: ["White 1"],
    },
  } as unknown as ExtendedFixtureInstance;
}

/** Build fixture instances keyed by UID for selection highlighter tests. */
function fixtureInstances(): Map<string, ExtendedFixtureInstance> {
  const instance = strobeInstance();
  return new Map([[instance.uid, instance]]);
}

/** Build a minimal LED bar fixture instance with per-cell selection proxies. */
function ledBarInstance(): ExtendedFixtureInstance {
  const anchor = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  const proxy = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  const otherProxy = new Mesh(
    new BoxGeometry(1, 1, 1),
    new MeshBasicMaterial(),
  );

  return {
    uid: "fixture-led",
    group: new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()),
    nodeObjects: new Map(),
    emitters: new Map([
      ["EmitterAnchor_0", { mesh: anchor, controlledElement: "Pixel 1" }],
    ]),
    rendererType: "led-bar",
    elementLabels: ["Pixel 1", "Pixel 2"],
    ledBarData: {
      type: "led-bar",
      cellMesh: new Mesh(
        new BoxGeometry(1, 1, 1),
        new MeshBasicMaterial(),
      ) as unknown,
      cellCount: 2,
      cellSelectionMeshes: [proxy, otherProxy],
      cellSelectionMaterial: new MeshBasicMaterial(),
      elementToCellIndex: new Map([
        ["Pixel 1", 0],
        ["Pixel 2", 1],
      ]),
    },
  } as unknown as ExtendedFixtureInstance;
}

test("SelectionHighlighter keeps active span objects separate from general selection", () => {
  const instances = fixtureInstances();
  const instance = instances.get("fixture-a");
  assert.ok(instance);

  const highlighter = new SelectionHighlighter(instances);
  highlighter.setSelection(new Set(["fixture-a"]));
  highlighter.setActiveSelectionTargets([
    { fixtureUid: "fixture-a", elementIndex: 2 },
  ]);

  assert.deepEqual(highlighter.getSelectedObjects(), [instance.group]);
  assert.deepEqual(highlighter.getActiveTargetObjects(), [
    instance.strobePanelData?.whiteSegmentMeshes[0],
  ]);
});

/** Verifies programmer-value highlights can coexist with active selection highlights. */
test("SelectionHighlighter keeps programmer value objects separate from active selection", () => {
  const instances = fixtureInstances();
  const instance = instances.get("fixture-a");
  assert.ok(instance);

  const highlighter = new SelectionHighlighter(instances);
  highlighter.setSelection(new Set(["fixture-a"]));
  highlighter.setProgrammerValues(new Set(["fixture-a"]));

  assert.deepEqual(highlighter.getSelectedObjects(), [instance.group]);
  assert.deepEqual(highlighter.getProgrammerValueObjects(), [instance.group]);
});

test("SelectionHighlighter includes selected scene object meshes", () => {
  const objectMesh = new Mesh(
    new BoxGeometry(1, 1, 1),
    new MeshBasicMaterial(),
  );
  const objectGroup = new Group();
  objectGroup.add(objectMesh);
  const objectInstance: SceneObjectInstance = {
    uid: "scene-object-a",
    objectType: SceneObjectType.Truss,
    group: objectGroup,
    propertiesHash: "hash",
  };

  const highlighter = new SelectionHighlighter(new Map());
  highlighter.setSceneObjectInstances(
    new Map([[objectInstance.uid, objectInstance]]),
  );
  highlighter.setSelection(new Set(["scene-object-a"]));

  assert.deepEqual(getSceneObjectSelectionMeshes(objectInstance), [objectMesh]);
  assert.deepEqual(highlighter.getSelectedObjects(), [objectMesh]);
});

test("getSelectionTargetObjects resolves LED bar elements to cell proxies", () => {
  const instance = ledBarInstance();
  const highlighted = getSelectionTargetObjects(instance, {
    fixtureUid: "fixture-led",
    elementIndex: 1,
  });

  assert.equal(highlighted.length, 1);
  assert.equal(highlighted[0], instance.ledBarData?.cellSelectionMeshes[0]);
});

test("getSelectionTargetObjects resolves fixture element indexes to strobe meshes", () => {
  const instance = strobeInstance();
  const highlighted = getSelectionTargetObjects(instance, {
    fixtureUid: "fixture-a",
    elementIndex: 2,
  });

  assert.equal(highlighted.length, 1);
  assert.equal(highlighted[0], instance.strobePanelData?.whiteSegmentMeshes[0]);
});

test("getSelectionTargetObjects falls back to fixture meshes for unknown elements", () => {
  const instance = strobeInstance();
  const highlighted = getSelectionTargetObjects(instance, {
    fixtureUid: "fixture-a",
    elementIndex: 99,
  });

  assert.equal(highlighted.length, 1);
  assert.equal(highlighted[0], instance.group);
});
