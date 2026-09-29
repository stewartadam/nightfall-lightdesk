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

/**
 * Largest per-channel 8-bit difference allowed between emitter faces before and after the
 * GPU budget lowers the fog and glow resolutions. The scene pass stays at full resolution,
 * so faces must look the same; two levels absorb rounding in the reduced-resolution passes
 * composited over them, while losing scene resolution shifts edge pixels by far more.
 */
const OVERLOAD_FACE_TOLERANCE = 2;

for (const kind of ["bar", "panel", "strobe-bar"] as const) {
  /** Visible emitters without beam metadata produce colored haze glow, which disappears on blackout. */
  test(`${kind} produces colored glow outside its emitting faces`, async ({
    page,
  }, testInfo) => {
    const errors = await openOpticsFixture(page);
    const result = await page.evaluate(async (kind) => {
      const T = await import("/e2e/fixtures/three-api.ts");
      const { readPixels, renderFrames, retainCanvas, verifyBackend } =
        await import("/e2e/fixtures/optics-harness.ts");
      const { createRenderer } = await import(
        "/features/visualizer/rendering/renderer.ts"
      );
      const {
        createPostProcessing,
        renderWithPostProcessing,
        disposePostProcessing,
      } = await import(
        "/features/visualizer/rendering/effects/post-processing.ts"
      );
      const { buildSimpleLedBar, updateLedBarColors, disposeLedBar } =
        await import(
          "/features/visualizer/rendering/fixture-renderers/led-bar-renderer.ts"
        );
      const {
        buildStrobePanelFixture,
        buildRgbStrobeBarFixture,
        updateStrobePanelColors,
        disposeStrobePanel,
      } = await import(
        "/features/visualizer/rendering/fixture-renderers/strobe-renderer.ts"
      );
      const renderer = createRenderer({
        canvas: document.querySelector("canvas")!,
        devicePixelRatio: 1,
      });
      renderer.setSize(500, 400);
      await renderer.init();
      const backend = await verifyBackend(renderer, undefined);
      const scene = new T.Scene();
      scene.background = new T.Color(0);
      const camera = new T.PerspectiveCamera(40, 1.25, 0.1, 20);
      camera.position.set(0, 0, 2);
      camera.lookAt(0, 0, 0);
      const elements = Array.from(
        { length: kind === "bar" ? 60 : kind === "panel" ? 112 : 72 },
        (_, i) => ({ label: String(i), parameters: [] }),
      );
      const fixture =
        kind === "bar"
          ? buildSimpleLedBar("glow", elements)
          : kind === "panel"
            ? buildStrobePanelFixture("glow", elements)
            : buildRgbStrobeBarFixture("glow", elements);
      fixture.group.rotation.x =
        kind === "bar" ? -Math.PI / 2 : kind === "panel" ? Math.PI : 0;
      scene.add(fixture.group);
      const colors = new Map(
        elements.map((element, i) => [
          element.label,
          {
            red: kind === "bar" ? 1 : 0,
            green: 0,
            blue: kind === "bar" ? 0 : 1,
            intensity:
              (kind === "panel" && i >= 96) || (kind === "strobe-bar" && i < 24)
                ? 0
                : 1,
          },
        ]),
      );
      /** Updates the production fixture colors and holds a face-on matrix pose for image comparison. */
      const update = () => {
        if ("ledBarData" in fixture) updateLedBarColors(fixture, colors);
        else {
          updateStrobePanelColors(fixture, colors);
          fixture.strobePanelData.panelGroup.rotation.x = 0;
        }
      };
      update();
      const bounds = new T.Box3().setFromObject(fixture.group);
      const center = bounds.getCenter(new T.Vector3());
      camera.position.set(center.x, center.y, center.z + 2);
      camera.lookAt(center);
      const pipeline = createPostProcessing(renderer, scene, camera);
      const bloomPass = pipeline.bloomPass!;
      /** Captures the production tone-mapped pipeline after GPU submission completes. */
      const capture = async (retain?: string) => {
        await renderFrames(renderer, 4, () =>
          renderWithPostProcessing(pipeline),
        );
        if (retain) retainCanvas(retain, renderer.domElement);
        return { pixels: readPixels(renderer.domElement) };
      };
      bloomPass.strength.value = 0;
      const faces = await capture(`${kind}-faces`);
      // Force sustained GPU overload without depending on the test machine's speed.
      const start = performance.now() - 10_000;
      for (let id = 0; id < 10; id++)
        pipeline.gpuBudget.observe({ id, milliseconds: 20 }, start + id * 1001);
      for (let id = 10; id < 13; id++)
        renderWithPostProcessing(pipeline, { id, milliseconds: 20 });
      const overloadedFaces = await capture(`${kind}-overloaded-faces`);
      let faceDifference = 0;
      for (let i = 0; i < faces.pixels.length; i++)
        faceDifference = Math.max(
          faceDifference,
          Math.abs(faces.pixels[i] - overloadedFaces.pixels[i]),
        );
      const scales = {
        scene: pipeline.scenePass.getResolutionScale(),
        fog: pipeline.volumePass.getResolutionScale(),
        glow: bloomPass.getResolutionScale(),
        sceneWidth: (
          pipeline.scenePass.getTexture("output").image as { width: number }
        ).width,
        sceneHeight: (
          pipeline.scenePass.getTexture("output").image as { height: number }
        ).height,
      };
      bloomPass.strength.value = pipeline.config.bloomStrength;
      const glow = await capture(`${kind}-glow`);
      let haloPixels = 0;
      for (let i = 0; i < faces.pixels.length; i += 4) {
        const channel = kind === "bar" ? 0 : 2;
        if (
          Math.max(faces.pixels[i], faces.pixels[i + 1], faces.pixels[i + 2]) <
            2 &&
          glow.pixels[i + channel] > 10
        )
          haloPixels++;
      }
      for (const value of colors.values()) value.intensity = 0;
      update();
      const black = await capture();
      let blackoutMax = 0;
      for (let i = 0; i < black.pixels.length; i += 4)
        blackoutMax = Math.max(
          blackoutMax,
          black.pixels[i],
          black.pixels[i + 1],
          black.pixels[i + 2],
        );
      disposePostProcessing(pipeline);
      if ("ledBarData" in fixture) disposeLedBar(fixture);
      else disposeStrobePanel(fixture);
      renderer.dispose();
      return {
        backend,
        haloPixels,
        blackoutMax,
        faceDifference,
        scales,
      };
    }, kind);
    annotateBackend(testInfo, result.backend);
    await expectWithArtifacts(
      testInfo,
      { page, artifacts: { [`${kind}-glow.json`]: result } },
      () => {
        expect(errors).toEqual([]);
        expect(result.haloPixels).toBeGreaterThan(500);
        expect(result.blackoutMax).toBeLessThan(3);
        expect(result.faceDifference).toBeLessThanOrEqual(
          OVERLOAD_FACE_TOLERANCE,
        );
        expect(result.scales).toEqual({
          scene: 1,
          fog: 0.25,
          glow: 0.25,
          sceneWidth: 500,
          sceneHeight: 400,
        });
      },
    );
  });
}
