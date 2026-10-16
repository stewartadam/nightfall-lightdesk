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
      const T = await window.__nightfallHarness.load("three");
      const { readPixels, renderFrames, retainCanvas, verifyBackend } =
        await window.__nightfallHarness.load("optics");
      const { BeamType, FixtureLayout, GeometryType } = (
        await window.__nightfallHarness.load("visualizer")
      ).types;
      const { disposeFixtureInstance } = (
        await window.__nightfallHarness.load("visualizer")
      ).geometryBuilder;
      const { buildFixtureWithoutGeometry, buildFixtureWithRenderer } = (
        await window.__nightfallHarness.load("visualizer")
      ).rendererRegistry;
      const { resolveQualityProfile } = (
        await window.__nightfallHarness.load("visualizer")
      ).qualityProfile;
      const high = resolveQualityProfile("high");
      const { disposeLedBar } = (
        await window.__nightfallHarness.load("visualizer")
      ).ledBarRenderer;
      const { BeamManager } = (
        await window.__nightfallHarness.load("visualizer")
      ).beamManager;
      const { BeamUpdater } = (
        await window.__nightfallHarness.load("visualizer")
      ).beamUpdater;
      const { createRenderer } = (
        await window.__nightfallHarness.load("visualizer")
      ).renderer;
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

/** Seen obliquely at close range, the dark physical cells must not depth fight the coplanar luminous row into a stippled bar. */
test("lit LED bar cells are not occluded by their own dark lenses", async ({
  page,
}, testInfo) => {
  const errors = await openOpticsFixture(page);
  const result = await page.evaluate(async () => {
    const T = await window.__nightfallHarness.load("three");
    const { readPixels, renderFrames, retainCanvas, verifyBackend } =
      await window.__nightfallHarness.load("optics");
    const { FixtureLayout } = (
      await window.__nightfallHarness.load("visualizer")
    ).types;
    const { buildFixtureWithoutGeometry } = (
      await window.__nightfallHarness.load("visualizer")
    ).rendererRegistry;
    const { resolveQualityProfile } = (
      await window.__nightfallHarness.load("visualizer")
    ).qualityProfile;
    const { disposeLedBar, updateLedBarColors } = (
      await window.__nightfallHarness.load("visualizer")
    ).ledBarRenderer;
    const { createRenderer } = (
      await window.__nightfallHarness.load("visualizer")
    ).renderer;
    const width = 400;
    const height = 300;
    const renderer = createRenderer({
      canvas: document.querySelector("canvas")!,
      devicePixelRatio: 1,
    });
    renderer.setSize(width, height);
    await renderer.init();
    const backend = await verifyBackend(renderer, undefined);
    const scene = new T.Scene();
    scene.background = new T.Color(0);
    const camera = new T.PerspectiveCamera(50, width / height, 0.1, 40);
    // Close enough that the row needs no transverse expansion, at a grazing angle like an elevated stage view.
    camera.position.set(-0.6, 0.35, 1);
    camera.lookAt(0, -0.07, 0);
    const scenePass = T.pass(scene, camera);
    const pipeline = new T.RenderPipeline(renderer);
    pipeline.outputNode = scenePass.getTextureNode();
    const elements = Array.from({ length: 40 }, (_, i) => ({
      label: `Pixel ${i}`,
      parameters: [],
    }));
    const fixture = buildFixtureWithoutGeometry(
      "lens-bar",
      elements,
      undefined,
      resolveQualityProfile("medium"),
      FixtureLayout.LedBar,
    )!;
    const ledBar = { ...fixture, ledBarData: fixture.ledBarData! };
    if (!ledBar.ledBarData.filteredRow)
      throw new Error("Expected a filtered emitter row");
    scene.add(fixture.group);
    updateLedBarColors(
      ledBar,
      new Map(
        elements.map((element) => [
          element.label,
          { red: 0, green: 0, blue: 1, intensity: 1 },
        ]),
      ),
    );
    /** Sums blue output over the whole frame, which contains only the lit bar on black. */
    const capture = async (name: string) => {
      await renderFrames(renderer, 4, () => pipeline.render());
      retainCanvas(name, renderer.domElement);
      const pixels = readPixels(renderer.domElement, {
        x: 0,
        y: 0,
        width,
        height,
      });
      let total = 0;
      for (let i = 2; i < pixels.length; i += 4) total += pixels[i];
      return total;
    };
    try {
      const withLenses = await capture("led-bar-with-lenses");
      ledBar.ledBarData.cellMesh.visible = false;
      const withoutLenses = await capture("led-bar-without-lenses");
      return { backend, withLenses, withoutLenses };
    } finally {
      disposeLedBar(ledBar);
      scenePass.dispose();
      pipeline.dispose();
      renderer.dispose();
    }
  });
  annotateBackend(testInfo, result.backend);
  await expectWithArtifacts(
    testInfo,
    { page, artifacts: { "led-bar-lenses.json": result } },
    () => {
      expect(errors).toEqual([]);
      expect(result.withoutLenses).toBeGreaterThan(0);
      expect(result.withLenses / result.withoutLenses).toBeGreaterThan(0.95);
    },
  );
});
