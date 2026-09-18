// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { VisualizerCanvasApi } from "../controllers/visualizer-canvas-api";
import type { CameraState, Vec3 } from "../rendering/renderers/renderer-api";
import {
  registerVisualizerDebugApi,
  setActiveVisualizerDebugApiPanel,
  unregisterVisualizerDebugApi,
} from "./visualizer-debug-api-registry";

type TestWindowLike = {
  visualizerApis?: Record<string, VisualizerCanvasApi>;
  visualizerActivePanelId?: string;
  getVisualizerApi?: (panelId?: string) => VisualizerCanvasApi | undefined;
  visualizerApi?: VisualizerCanvasApi;
};

function createFakeApi(): VisualizerCanvasApi {
  return {
    pause: () => undefined,
    resume: () => undefined,
    isPaused: () => false,
    getScene: () => undefined,
    toggleEmitterDebug: () => undefined,
    toggleBeams: () => undefined,
    isUsingWorker: () => false,
    getCameraState: async () =>
      ({
        position: { x: 0, y: 0, z: 0 },
        target: { x: 0, y: 0, z: 0 },
      }) satisfies CameraState,
    setCameraPosition: (_position: Vec3) => undefined,
    setCameraTarget: (_target: Vec3) => undefined,
    setCameraState: (_state: CameraState) => undefined,
    resetCamera: () => undefined,
    zoomToFit: (_uids?: string[]) => undefined,
    zoomToSelection: () => undefined,
  };
}

test("register exposes panel-scoped APIs and defaults active panel to first register", () => {
  const windowLike: TestWindowLike = {};
  const firstApi = createFakeApi();
  const secondApi = createFakeApi();

  registerVisualizerDebugApi("panel-a", firstApi, windowLike);
  registerVisualizerDebugApi("panel-b", secondApi, windowLike);

  assert.equal(windowLike.visualizerActivePanelId, "panel-a");
  assert.equal(windowLike.getVisualizerApi?.("panel-a"), firstApi);
  assert.equal(windowLike.getVisualizerApi?.("panel-b"), secondApi);
  assert.equal(windowLike.getVisualizerApi?.(), firstApi);
  assert.equal(windowLike.visualizerApi, firstApi);
});

test("setActive switches default visualizerApi getter target by panel id", () => {
  const windowLike: TestWindowLike = {};
  const firstApi = createFakeApi();
  const secondApi = createFakeApi();

  registerVisualizerDebugApi("panel-a", firstApi, windowLike);
  registerVisualizerDebugApi("panel-b", secondApi, windowLike);
  setActiveVisualizerDebugApiPanel("panel-b", windowLike);

  assert.equal(windowLike.visualizerActivePanelId, "panel-b");
  assert.equal(windowLike.getVisualizerApi?.(), secondApi);
  assert.equal(windowLike.visualizerApi, secondApi);
});

test("unregister removes panel API and retargets active panel when needed", () => {
  const windowLike: TestWindowLike = {};
  const firstApi = createFakeApi();
  const secondApi = createFakeApi();

  registerVisualizerDebugApi("panel-a", firstApi, windowLike);
  registerVisualizerDebugApi("panel-b", secondApi, windowLike);

  setActiveVisualizerDebugApiPanel("panel-b", windowLike);
  unregisterVisualizerDebugApi("panel-b", windowLike);

  assert.equal(windowLike.getVisualizerApi?.("panel-b"), undefined);
  assert.equal(windowLike.visualizerActivePanelId, "panel-a");
  assert.equal(windowLike.getVisualizerApi?.(), firstApi);
  assert.equal(windowLike.visualizerApi, firstApi);

  unregisterVisualizerDebugApi("panel-a", windowLike);
  assert.equal(windowLike.visualizerActivePanelId, undefined);
  assert.equal(windowLike.getVisualizerApi?.(), undefined);
  assert.equal(windowLike.visualizerApi, undefined);
});

test("setActive falls back to first available panel when target is missing", () => {
  const windowLike: TestWindowLike = {};
  const firstApi = createFakeApi();
  const secondApi = createFakeApi();

  registerVisualizerDebugApi("panel-a", firstApi, windowLike);
  registerVisualizerDebugApi("panel-b", secondApi, windowLike);

  setActiveVisualizerDebugApiPanel("missing-panel", windowLike);

  assert.equal(windowLike.visualizerActivePanelId, "panel-a");
  assert.equal(windowLike.getVisualizerApi?.(), firstApi);
});
