// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

for (const forceWebGL of [false, true]) {
  /** The global cap must retain a late relevant source and respond to live movement and removal. */
  test(`surface budget retains late relevant lights (${forceWebGL ? "WebGL" : "WebGPU"})`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto("/e2e/fixtures/optics.html");
    const result = await page.evaluate(async (forceWebGL) => {
      const THREE = await import("/e2e/fixtures/three-api.ts");
      const { OpticalSurfaceLighting, OpticalSurfaceLight } = await import(
        "/features/visualizer/rendering/effects/optical-surface-lighting.ts"
      );
      const renderer = new THREE.WebGPURenderer({
        canvas: document.querySelector("canvas")!,
        forceWebGL,
      });
      renderer.setSize(400, 400);
      await renderer.init();
      const lighting = new OpticalSurfaceLighting({
        gobos: true,
        shadows: true,
      });
      renderer.lighting = lighting;
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0);
      const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
      camera.position.z = 4;
      const wall = new THREE.Mesh(
        new THREE.PlaneGeometry(8, 8),
        new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1 }),
      );
      wall.position.z = -4;
      scene.add(wall);
      const distant = Array.from({ length: 1024 }, (_, i) => {
        const light = new THREE.PointLight(0xff0000, 1, 1);
        light.position.set(1000 + i, 0, 0);
        scene.add(light);
        return light;
      });
      const late = new OpticalSurfaceLight({
        shape: "round",
        radius: 0.02,
        slopeX: 0.15,
        slopeY: 0.15,
        halfPowerRatio: 0.5,
        distributionPower: 8,
        lumens: 1000,
      });
      late.color.setRGB(0, 0, 1);
      late.intensity = 0.1;
      scene.add(late);
      /** Captures the actual surface output after the current selection has reached the GPU. */
      const capture = async () => {
        await new Promise<void>((resolve) => {
          let frames = 0;
          renderer.setAnimationLoop(() => {
            renderer.render(scene, camera);
            if (++frames === 4) {
              renderer.setAnimationLoop(null);
              resolve();
            }
          });
        });
        const copy = document.createElement("canvas");
        copy.width = copy.height = 400;
        const context = copy.getContext("2d")!;
        context.drawImage(renderer.domElement, 0, 0);
        const pixels = context.getImageData(0, 0, 400, 400).data;
        let red = 0,
          blue = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          red += pixels[i];
          blue += pixels[i + 2];
        }
        return {
          red,
          blue,
          omitted: lighting.omittedPointLights,
          image: copy.toDataURL("image/png"),
        };
      };
      try {
        const blue = await capture();
        late.position.x = 1000;
        distant[0].position.set(0, 0, 0);
        distant[0].distance = 40;
        const red = await capture();
        scene.remove(distant[1]);
        const belowLimit = await capture();
        for (const light of distant) scene.remove(light);
        scene.remove(late);
        const empty = await capture();
        return { blue, red, belowLimit, empty };
      } finally {
        lighting.dispose();
        wall.geometry.dispose();
        wall.material.dispose();
        renderer.dispose();
      }
    }, forceWebGL);
    expect(errors).toEqual([]);
    expect(result.blue.blue).toBeGreaterThan(10000);
    expect(result.blue.red).toBe(0);
    expect(result.blue.omitted).toBe(1);
    expect(result.red.red).toBeGreaterThan(10000);
    expect(result.red.blue).toBe(0);
    expect(result.red.omitted).toBe(1);
    expect(result.belowLimit.omitted).toBe(0);
    expect(result.empty.omitted).toBe(0);
    expect(result.empty.red + result.empty.blue).toBe(0);
    for (const [name, capture] of Object.entries(result))
      await testInfo.attach(`${name}.png`, {
        body: Buffer.from(capture.image.split(",")[1], "base64"),
        contentType: "image/png",
      });
  });
}

/** The operator sees active quality reduction, and the notice disappears when the source count recovers. */
test("surface budget notice follows live instrumentation", async ({
  page,
}, testInfo) => {
  await page.route("**/surface-budget-metrics", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body><div id="root"></div><script type="module" src="/e2e/fixtures/surface-budget-metrics.tsx"></script></body></html>',
    }),
  );
  await page.goto("/surface-budget-metrics");
  await page.getByRole("button", { name: /Visualizer/ }).click();
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.getByRole("button", { name: "Exceed surface budget" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Surface light limit reached: 7 sources omitted.",
  );
  await page.screenshot({
    path: testInfo.outputPath("surface-budget-notice.png"),
  });
  await page.getByRole("button", { name: "Restore surface budget" }).click();
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.getByRole("button", { name: "Reduce prism detail" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Prism detail reduced on 2 emitters to stay within the rendering budget.",
  );
  await page.screenshot({
    path: testInfo.outputPath("prism-budget-notice.png"),
  });
  await page.getByRole("button", { name: "Restore prism detail" }).click();
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.getByRole("button", { name: "Exceed gobo budget" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Gobo mask limit reached on 3 emitters: additional masks omitted.",
  );
  await page.screenshot({
    path: testInfo.outputPath("gobo-budget-notice.png"),
  });
  await page.getByRole("button", { name: "Restore gobo budget" }).click();
  await expect(page.getByRole("status")).toHaveCount(0);
});
