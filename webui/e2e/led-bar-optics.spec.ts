// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** A definition-driven row of independent apertures must overlap into a sheet and retain cell blackout. */
for (const geometryDriven of [false, true]) {
  test(`sixty ${geometryDriven ? "imported geometry" : "builtin"} apertures overlap continuously while retaining independent control`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto("/e2e/fixtures/optics.html");
    const result = await page.evaluate(async (geometryDriven) => {
      const T = await import("/e2e/fixtures/three-api.ts");
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
          )
        : buildFixtureWithoutGeometry(
            "owned-bar",
            elements,
            BeamType.Wash,
            "high",
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
      /** Reads a horizontal slice through the fog, well away from both ends of the apertures. */
      const capture = async () => {
        await new Promise<void>((resolve) => {
          let frames = 0;
          renderer.setAnimationLoop(() => {
            pipeline.render();
            if (++frames === 4) {
              renderer.setAnimationLoop(null);
              resolve();
            }
          });
        });
        const canvas = document.createElement("canvas");
        canvas.width = 400;
        canvas.height = 500;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(renderer.domElement, 0, 0);
        const pixels = ctx.getImageData(0, 0, 400, 500).data;
        const line = Array.from(
          { length: 120 },
          (_, x) => pixels[(200 * 400 + 140 + x) * 4 + 2],
        );
        return { line, image: canvas.toDataURL() };
      };
      const all = await capture();
      for (let i = 30; i < 60; i++) colors.get(`Cell ${i}`)!.intensity = 0;
      beams.updateFixtureBeam(fixture.uid, fixture, colors);
      const half = await capture();
      beams.dispose();
      if (geometryDriven) disposeFixtureInstance(fixture);
      else disposeLedBar({ ...fixture, ledBarData: fixture.ledBarData! });
      scenePass.dispose();
      pipeline.dispose();
      renderer.dispose();
      return { all, half };
    }, geometryDriven);
    for (const [name, capture] of Object.entries(result))
      await testInfo.attach(`led-sheet-${name}.png`, {
        body: Buffer.from(capture.image.split(",")[1], "base64"),
        contentType: "image/png",
      });
    expect(errors).toEqual([]);
    expect(Math.min(...result.all.line)).toBeGreaterThan(5);
    expect(
      Math.min(...result.all.line) / Math.max(...result.all.line),
    ).toBeGreaterThan(0.6);
    const left = result.half.line.slice(10, 30).reduce((a, b) => a + b, 0);
    const right = result.half.line.slice(90, 110).reduce((a, b) => a + b, 0);
    expect(right).toBeLessThan(left * 0.1);
  });
}
