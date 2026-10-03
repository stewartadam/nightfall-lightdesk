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

for (const geometryDriven of [false, true]) {
  /** A definition-driven row of independent apertures must overlap into a sheet and retain cell blackout. */
  test(`sixty ${geometryDriven ? "imported geometry" : "builtin"} apertures overlap continuously while retaining independent control`, async ({
    page,
  }, testInfo) => {
    const errors = await openOpticsFixture(page);
    const result = await page.evaluate(async (geometryDriven) => {
      const T = await import("/e2e/fixtures/three-api.ts");
      const { readPixels, renderFrames, retainCanvas, verifyBackend } =
        await import("/e2e/fixtures/optics-harness.ts");
      const { BeamType, FixtureLayout, GeometryType } = await import(
        "/types/index.ts"
      );
      const { disposeFixtureInstance } = await import(
        "/features/visualizer/rendering/geometry-builder.ts"
      );
      const { buildFixtureWithoutGeometry, buildFixtureWithRenderer } =
        await import(
          "/features/visualizer/rendering/fixture-renderers/renderer-registry.ts"
        );
      const { resolveQualityProfile } = await import(
        "/features/visualizer/rendering/quality-profile.ts"
      );
      const high = resolveQualityProfile("high");
      const { disposeLedBar } = await import(
        "/features/visualizer/rendering/fixture-renderers/led-bar-renderer.ts"
      );
      const { BeamManager } = await import(
        "/features/visualizer/rendering/effects/beam-manager.ts"
      );
      const { BeamUpdater } = await import(
        "/features/visualizer/rendering/effects/beam-updater.ts"
      );
      const { createRenderer } = await import(
        "/features/visualizer/rendering/renderer.ts"
      );
      const renderer = createRenderer({
        canvas: document.querySelector("canvas")!,
        devicePixelRatio: 1,
      });
      renderer.setSize(400, 500);
      await renderer.init();
      const backend = await verifyBackend(renderer, undefined);
      const scene = new T.Scene();
      scene.background = new T.Color(0);
      const camera = new T.PerspectiveCamera(50, 400 / 500, 0.1, 40);
      camera.position.set(0, -1.5, 4);
      camera.lookAt(0, -1.5, 0);
      const scenePass = T.pass(scene, camera);
      const pipeline = new T.RenderPipeline(renderer);
      pipeline.outputNode = scenePass.getTextureNode();
      const elements = Array.from({ length: 60 }, (_, i) => ({
        label: `Cell ${i}`,
        parameters: [],
      }));
      const fixture = geometryDriven
        ? buildFixtureWithRenderer(
            "owned-geometry",
            {
              nodes: elements.map((element, i) => ({
                name: `Aperture ${i}`,
                geometryType: GeometryType.Beam,
                controlledElement: element.label,
                parentIndex: -1,
                transform: {
                  elements: new T.Matrix4()
                    .makeTranslation((i + 0.5) / 60 - 0.5, 0, 0)
                    .toArray(),
                },
                beam: {
                  radius: 0.005,
                  throwRatio: 1,
                  rectangleRatio: 1,
                  physical: {
                    beamType: BeamType.Wash,
                    beamAngle: 2,
                    fieldAngle: 4,
                    lumens: 200,
                  },
                },
              })),
              roots: elements.map((_, i) => i),
            },
            elements,
            undefined,
            high,
          )
        : buildFixtureWithoutGeometry(
            "owned-bar",
            elements,
            BeamType.Wash,
            high,
            FixtureLayout.LedBar,
            {
              beamType: BeamType.Wash,
              beamAngle: 2,
              fieldAngle: 4,
              lumens: 12000,
            },
          )!;
      if (geometryDriven) fixture.group.rotation.x = -Math.PI / 2;
      if (fixture.emitters.size !== 60)
        throw new Error("Expected sixty independent apertures");
      scene.add(fixture.group);
      const beams = new BeamUpdater(new BeamManager(scene));
      beams.syncWithFixtures(new Map([[fixture.uid, fixture]]));
      const colors = new Map(
        elements.map((element) => [
          element.label,
          { red: 0, green: 0, blue: 1, intensity: 1 },
        ]),
      );
      beams.updateFixtureBeam(fixture.uid, fixture, colors);
      /** Reads the blue channel along a horizontal slice through the fog, well away from both ends of the apertures. */
      const capture = async (name: string) => {
        await renderFrames(renderer, 4, () => pipeline.render());
        retainCanvas(name, renderer.domElement);
        const pixels = readPixels(renderer.domElement, {
          x: 140,
          y: 200,
          width: 120,
          height: 1,
        });
        return Array.from({ length: 120 }, (_, x) => pixels[x * 4 + 2]);
      };
      try {
        const all = await capture("led-sheet-all");
        for (let i = 30; i < 60; i++) colors.get(`Cell ${i}`)!.intensity = 0;
        beams.updateFixtureBeam(fixture.uid, fixture, colors);
        const half = await capture("led-sheet-half");
        return { backend, all, half };
      } finally {
        beams.dispose();
        if (geometryDriven) disposeFixtureInstance(fixture);
        else disposeLedBar({ ...fixture, ledBarData: fixture.ledBarData! });
        scenePass.dispose();
        pipeline.dispose();
        renderer.dispose();
      }
    }, geometryDriven);
    annotateBackend(testInfo, result.backend);
    await expectWithArtifacts(
      testInfo,
      { page, artifacts: { "led-sheet.json": result } },
      () => {
        expect(errors).toEqual([]);
        expect(Math.min(...result.all)).toBeGreaterThan(5);
        expect(
          Math.min(...result.all) / Math.max(...result.all),
        ).toBeGreaterThan(0.6);
        const left = result.half.slice(10, 30).reduce((a, b) => a + b, 0);
        const right = result.half.slice(90, 110).reduce((a, b) => a + b, 0);
        expect(right).toBeLessThan(left * 0.1);
      },
    );
  });
}
