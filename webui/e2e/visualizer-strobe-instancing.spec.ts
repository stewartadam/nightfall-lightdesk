// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Instanced strobe cells must match independent mesh colors while eliminating per-cell draw submissions. */
for (const layout of ["matrix", "rgb-bar"] as const) {
  test(`${layout} strobe cells retain their appearance in two shared draws`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.route("**/__strobe_batch__", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<canvas></canvas>",
      }),
    );
    await page.goto("/__strobe_batch__");
    const result = await page.evaluate(async (layout) => {
      const THREE = await import("/e2e/fixtures/three-api.ts");
      const {
        buildStrobePanelFixture,
        buildRgbStrobeBarFixture,
        updateStrobePanelColors,
        disposeStrobePanel,
      } = await import(
        "/features/visualizer/rendering/fixture-renderers/strobe-renderer.ts"
      );
      const renderer = new THREE.WebGPURenderer({
        canvas: document.querySelector("canvas")!,
      });
      renderer.setSize(400, 300);
      await renderer.init();
      renderer.info.autoReset = false;
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0);
      const camera = new THREE.PerspectiveCamera(35, 4 / 3, 0.01, 10);
      camera.position.set(0, 0.2, layout === "matrix" ? 1.1 : 1.8);
      camera.lookAt(0, 0.2, 0);
      const fixture =
        layout === "matrix"
          ? buildStrobePanelFixture("batch", [])
          : buildRgbStrobeBarFixture("batch", []);
      const model = fixture.group.getObjectByName("Model");
      if (model) model.rotation.x = 0;
      scene.add(fixture.group);
      const values = new Map();
      for (let i = 0; i < (layout === "matrix" ? 112 : 72); i++)
        values.set(String(i), {
          red: i % 3 === 0 ? 1 : 0,
          green: i % 3 === 1 ? 1 : 0,
          blue: i % 3 === 2 ? 1 : 0,
          intensity: 0.5,
        });
      updateStrobePanelColors(fixture, values);
      fixture.strobePanelData.panelGroup.rotation.x = 0;
      /** Captures pixels and driver draw counts after pipeline compilation settles. */
      const capture = async () => {
        await new Promise<void>((resolve) => {
          let frames = 0;
          renderer.setAnimationLoop(() => {
            renderer.info.reset();
            renderer.render(scene, camera);
            if (++frames === 4) {
              renderer.setAnimationLoop(null);
              resolve();
            }
          });
        });
        const canvas = document.createElement("canvas");
        canvas.width = 400;
        canvas.height = 300;
        const context = canvas.getContext("2d")!;
        context.drawImage(renderer.domElement, 0, 0);
        return {
          draws: renderer.info.render.drawCalls,
          pixels: context.getImageData(0, 0, 400, 300).data,
          image: canvas.toDataURL("image/png"),
        };
      };
      const batched = await capture();
      for (const { mesh, sources } of fixture.strobePanelData.emitterBatches) {
        mesh.visible = false;
        for (const source of sources) source.visible = true;
      }
      const reference = await capture();
      let difference = 0,
        brightness = 0;
      for (let i = 0; i < batched.pixels.length; i++) {
        if (i % 4 === 3) continue;
        difference += Math.abs(batched.pixels[i] - reference.pixels[i]);
        brightness += reference.pixels[i];
      }
      disposeStrobePanel(fixture);
      renderer.dispose();
      return {
        draws: batched.draws,
        referenceDraws: reference.draws,
        difference,
        brightness,
        image: batched.image,
      };
    }, layout);
    expect(errors).toEqual([]);
    expect(result.brightness).toBeGreaterThan(10000);
    expect(result.difference).toBeLessThan(result.brightness * 0.01);
    expect(result.referenceDraws - result.draws).toBe(
      layout === "matrix" ? 110 : 70,
    );
    await testInfo.attach("strobe-batched.png", {
      body: Buffer.from(result.image.split(",")[1], "base64"),
      contentType: "image/png",
    });
  });
}
