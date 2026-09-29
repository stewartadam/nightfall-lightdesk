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

for (const layout of ["matrix", "rgb-bar"] as const) {
  /** Instanced strobe cells must match independent mesh colors while eliminating per-cell draw submissions. */
  test(`${layout} strobe cells retain their appearance in two shared draws`, async ({
    page,
  }, testInfo) => {
    const errors = await openOpticsFixture(page);
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
      const { createTestRenderer, readPixels, renderFrames, retainCanvas } =
        await import("/e2e/fixtures/optics-harness.ts");
      const { renderer, backend } = await createTestRenderer({
        forceWebGL: undefined,
        width: 400,
        height: 300,
      });
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
      const capture = async (retain: string) => {
        await renderFrames(renderer, 4, () => {
          renderer.info.reset();
          renderer.render(scene, camera);
        });
        retainCanvas(retain, renderer.domElement);
        return {
          draws: renderer.info.render.drawCalls,
          pixels: readPixels(renderer.domElement),
        };
      };
      try {
        const batched = await capture("strobe-batched");
        for (const { mesh, sources } of fixture.strobePanelData
          .emitterBatches) {
          mesh.visible = false;
          for (const source of sources) source.visible = true;
        }
        const reference = await capture("strobe-reference");
        let difference = 0;
        let brightness = 0;
        for (let i = 0; i < batched.pixels.length; i++) {
          if (i % 4 === 3) continue;
          difference += Math.abs(batched.pixels[i] - reference.pixels[i]);
          brightness += reference.pixels[i];
        }
        return {
          backend,
          draws: batched.draws,
          referenceDraws: reference.draws,
          difference,
          brightness,
        };
      } finally {
        disposeStrobePanel(fixture);
        renderer.dispose();
      }
    }, layout);
    annotateBackend(testInfo, result.backend);
    await expectWithArtifacts(
      testInfo,
      { page, artifacts: { "strobe-batch.json": result } },
      () => {
        expect(errors).toEqual([]);
        expect(result.brightness).toBeGreaterThan(10000);
        expect(result.difference).toBeLessThan(result.brightness * 0.01);
        expect(result.referenceDraws - result.draws).toBe(
          layout === "matrix" ? 110 : 70,
        );
      },
    );
  });
}
