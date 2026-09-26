// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  annotateBackend,
  expectWithArtifacts,
  openOpticsFixture,
} from "./optics-harness";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Invisible per-cell proxies cost no beauty draws but remain usable by the GPU outline pass. */
test("selection proxies skip beauty submission and retain outlines", async ({
  page,
}, testInfo) => {
  const errors = await openOpticsFixture(page);
  const result = await page.evaluate(async () => {
    const THREE = await import("/e2e/fixtures/three-api.ts");
    const {
      createPostProcessing,
      disposePostProcessing,
      setOutlineSelectedObjects,
      setEditSelectionOutlineSelectedObjects,
    } = await import(
      "/features/visualizer/rendering/effects/post-processing.ts"
    );
    const { createTestRenderer, renderAndSum, retainCanvas } = await import(
      "/e2e/fixtures/optics-harness.ts"
    );
    const { renderer, backend } = await createTestRenderer({
      forceWebGL: undefined,
      width: 320,
      height: 240,
    });
    renderer.info.autoReset = false;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0);
    const camera = new THREE.PerspectiveCamera(45, 320 / 240, 0.1, 100);
    camera.position.z = 4;
    const originalLighting = renderer.lighting;
    const pipeline = createPostProcessing(renderer, scene, camera);
    /** Samples one fully submitted frame after shaders and render targets have warmed. */
    const capture = async (retain?: string) => {
      const sums = await renderAndSum(renderer, () => {
        renderer.info.reset();
        pipeline.postProcessing.render();
      });
      if (retain) retainCanvas(retain, renderer.domElement);
      return {
        draws: renderer.info.render.drawCalls,
        brightness: sums.red + sums.green + sums.blue,
      };
    };
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    try {
      const empty = await capture();
      const proxies = Array.from({ length: 100 }, () => {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.visualizerOutlineOnly = true;
        mesh.visible = false;
        scene.add(mesh);
        return mesh;
      });
      const unselected = await capture();
      setOutlineSelectedObjects(pipeline, [proxies[0]]);
      const selected = await capture("selection-outline");
      const selectedProxyCount = proxies.filter((mesh) => mesh.visible).length;
      setEditSelectionOutlineSelectedObjects(pipeline, [proxies[0]]);
      setOutlineSelectedObjects(pipeline, []);
      const retainedByEditSelection = proxies[0].visible;
      setEditSelectionOutlineSelectedObjects(pipeline, []);
      const deselectedProxyCount = proxies.filter(
        (mesh) => mesh.visible,
      ).length;
      const deselected = await capture();
      disposePostProcessing(pipeline);
      const restoredRenderer =
        renderer.lighting === originalLighting &&
        renderer.getRenderObjectFunction() === null;
      return {
        backend,
        restoredRenderer,
        empty,
        unselected,
        selected,
        deselected,
        selectedProxyCount,
        retainedByEditSelection,
        deselectedProxyCount,
      };
    } finally {
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    }
  });
  annotateBackend(testInfo, result.backend);
  await expectWithArtifacts(
    testInfo,
    { page, artifacts: { "selection-proxies.json": result } },
    () => {
      expect(errors).toEqual([]);
      expect(result.restoredRenderer).toBe(true);
      expect(result.unselected.draws).toBe(result.empty.draws);
      expect(result.unselected.brightness).toBe(result.empty.brightness);
      expect(result.selected.brightness).toBeGreaterThan(
        result.empty.brightness + 1000,
      );
      expect(result.selectedProxyCount).toBe(1);
      expect(result.retainedByEditSelection).toBe(true);
      expect(result.deselectedProxyCount).toBe(0);
      expect(result.deselected.brightness).toBe(result.empty.brightness);
    },
  );
});
