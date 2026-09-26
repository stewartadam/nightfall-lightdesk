// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  ALWAYS_ATTACH_ARTIFACTS,
  backendLabel,
  evaluateOnBackend,
  expectWithArtifacts,
  openOpticsFixture,
} from "./optics-harness";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

for (const forceWebGL of [false, true]) {
  /** The global cap must retain a late relevant source and respond to live movement and removal. */
  test(`surface budget retains late relevant lights (${backendLabel(forceWebGL)})`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000);
    const errors = await openOpticsFixture(page);
    const result = await evaluateOnBackend(
      page,
      async (forceWebGL) => {
        const THREE = await import("/e2e/fixtures/three-api.ts");
        const { OpticalSurfaceLighting, OpticalSurfaceLight } = await import(
          "/features/visualizer/rendering/effects/optical-surface-lighting.ts"
        );
        const { createTestRenderer, renderAndSum, retainCanvas } = await import(
          "/e2e/fixtures/optics-harness.ts"
        );
        const { renderer } = await createTestRenderer({
          forceWebGL,
          width: 400,
          height: 400,
        });
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
        /** Captures the surface output and omission count once the current selection reaches the GPU. */
        const capture = async (name: string) => {
          const { red, blue } = await renderAndSum(renderer, () =>
            renderer.render(scene, camera),
          );
          retainCanvas(name, renderer.domElement);
          return { red, blue, omitted: lighting.omittedPointLights };
        };
        try {
          const blue = await capture("blue");
          late.position.x = 1000;
          distant[0].position.set(0, 0, 0);
          distant[0].distance = 40;
          const red = await capture("red");
          scene.remove(distant[1]);
          const belowLimit = await capture("below-limit");
          for (const light of distant) scene.remove(light);
          scene.remove(late);
          const empty = await capture("empty");
          return { blue, red, belowLimit, empty };
        } finally {
          lighting.dispose();
          wall.geometry.dispose();
          wall.material.dispose();
          renderer.dispose();
        }
      },
      forceWebGL,
    );
    await expectWithArtifacts(
      testInfo,
      { page, artifacts: { "surface-budget.json": result } },
      () => {
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
      },
    );
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
  /** Captures the visible notice for review when artifacts are requested. */
  const screenshot = async (name: string) => {
    if (ALWAYS_ATTACH_ARTIFACTS)
      await testInfo.attach(name, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
  };
  await page.getByRole("button", { name: /Visualizer/ }).click();
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.getByRole("button", { name: "Exceed surface budget" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Surface light limit reached: 7 sources omitted.",
  );
  await screenshot("surface-budget-notice.png");
  await page.getByRole("button", { name: "Restore surface budget" }).click();
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.getByRole("button", { name: "Reduce prism detail" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Prism detail reduced on 2 emitters to stay within the rendering budget.",
  );
  await screenshot("prism-budget-notice.png");
  await page.getByRole("button", { name: "Restore prism detail" }).click();
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.getByRole("button", { name: "Exceed gobo budget" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Gobo mask limit reached on 3 emitters: additional masks omitted.",
  );
  await screenshot("gobo-budget-notice.png");
  await page.getByRole("button", { name: "Restore gobo budget" }).click();
  await expect(page.getByRole("status")).toHaveCount(0);
});
