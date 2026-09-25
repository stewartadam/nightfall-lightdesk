// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Invisible per-cell proxies cost no beauty draws but remain usable by the GPU outline pass. */
test("selection proxies skip beauty submission and retain outlines", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.route("**/__selection-proxies__", (route) =>
    route.fulfill({ contentType: "text/html", body: "<canvas></canvas>" }),
  );
  await page.goto("/__selection-proxies__");
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
    const renderer = new THREE.WebGPURenderer({
      canvas: document.querySelector("canvas")!,
    });
    renderer.setSize(320, 240);
    await renderer.init();
    renderer.info.autoReset = false;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0);
    const camera = new THREE.PerspectiveCamera(45, 320 / 240, 0.1, 100);
    camera.position.z = 4;
    const pipeline = createPostProcessing(renderer, scene, camera);
    /** Samples one fully submitted frame after shaders and render targets have warmed. */
    const capture = async () => {
      await new Promise<void>((resolve) => {
        let frames = 0;
        renderer.setAnimationLoop(() => {
          renderer.info.reset();
          pipeline.postProcessing.render();
          if (++frames === 4) {
            renderer.setAnimationLoop(null);
            resolve();
          }
        });
      });
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 240;
      const context = canvas.getContext("2d")!;
      context.drawImage(renderer.domElement, 0, 0);
      const pixels = context.getImageData(0, 0, 320, 240).data;
      let brightness = 0;
      for (let i = 0; i < pixels.length; i += 4)
        brightness += pixels[i] + pixels[i + 1] + pixels[i + 2];
      return {
        draws: renderer.info.render.drawCalls,
        brightness,
        image: canvas.toDataURL("image/png"),
      };
    };
    const empty = await capture();
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const proxies = Array.from({ length: 100 }, () => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.visualizerOutlineOnly = true;
      mesh.visible = false;
      scene.add(mesh);
      return mesh;
    });
    const unselected = await capture();
    setOutlineSelectedObjects(pipeline, [proxies[0]]);
    const selected = await capture();
    const selectedProxyCount = proxies.filter((mesh) => mesh.visible).length;
    setEditSelectionOutlineSelectedObjects(pipeline, [proxies[0]]);
    setOutlineSelectedObjects(pipeline, []);
    const retainedByEditSelection = proxies[0].visible;
    setEditSelectionOutlineSelectedObjects(pipeline, []);
    const deselectedProxyCount = proxies.filter((mesh) => mesh.visible).length;
    const deselected = await capture();
    disposePostProcessing(pipeline);
    geometry.dispose();
    material.dispose();
    renderer.dispose();
    return {
      empty,
      unselected,
      selected,
      deselected,
      selectedProxyCount,
      retainedByEditSelection,
      deselectedProxyCount,
    };
  });
  expect(errors).toEqual([]);
  expect(result.unselected.draws).toBe(result.empty.draws);
  expect(result.unselected.brightness).toBe(result.empty.brightness);
  expect(result.selected.brightness).toBeGreaterThan(
    result.empty.brightness + 1000,
  );
  expect(result.selectedProxyCount).toBe(1);
  expect(result.retainedByEditSelection).toBe(true);
  expect(result.deselectedProxyCount).toBe(0);
  expect(result.deselected.brightness).toBe(result.empty.brightness);
  await testInfo.attach("selection-outline.png", {
    body: Buffer.from(result.selected.image.split(",")[1], "base64"),
    contentType: "image/png",
  });
});
