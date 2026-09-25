// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  backendLabel,
  evaluateOnBackend,
  expectWithArtifacts,
  openOpticsFixture,
} from "./optics-harness";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/**
 * Runs every backend × DPR × quality combination of the subpixel-motion test when `1`.
 * By default each backend runs DPR 2 with one unbloomed preset (low and medium share the
 * same LED path) and the bloomed high preset, covering each distinct output path.
 */
const FULL_SWEEP = process.env.NIGHTFALL_VISUALIZER_ANTIALIAS_SWEEP === "1";

/**
 * Relative difference allowed between one beam and two coincident beams on the low preset,
 * whose schematic cones blend by maximum rather than adding. Rasterization order can move a
 * few edge pixels by one level; additive blending would raise the total by tens of percent.
 */
const MAX_BLEND_TOLERANCE = 0.005;

const motionVariants = [false, true].flatMap((forceWebGL) =>
  (FULL_SWEEP ? [1, 2] : [2]).flatMap((pixelRatio) =>
    (FULL_SWEEP
      ? (["low", "medium", "high"] as const)
      : (["medium", "high"] as const)
    ).map((quality) => ({ forceWebGL, pixelRatio, quality })),
  ),
);

for (const { forceWebGL, pixelRatio, quality } of motionVariants) {
  /** Measures distant LED stability during subpixel motion and checks that filtering leaves no blackout history. */
  test(`HDR LED subpixel motion and blackout ${backendLabel(forceWebGL)} ${quality} DPR ${pixelRatio}`, async ({
    page,
  }, testInfo) => {
    const errors = await openOpticsFixture(page);
    const result = await evaluateOnBackend(
      page,
      async ({ forceWebGL, quality, pixelRatio }) => {
        const T = await import("/e2e/fixtures/three-api.ts");
        const { createPostProcessing, disposePostProcessing } = await import(
          "/features/visualizer/rendering/effects/post-processing.ts"
        );
        const { FilteredEmitterRow } = await import(
          "/features/visualizer/rendering/effects/filtered-emitter-row.ts"
        );
        const { resolveQualityProfile } = await import(
          "/features/visualizer/rendering/quality-profile.ts"
        );
        const { createTestRenderer, readPixels, renderFrames, retainCanvas } =
          await import("/e2e/fixtures/optics-harness.ts");
        const { renderer } = await createTestRenderer({
          forceWebGL,
          width: 600,
          height: 400,
          pixelRatio,
        });
        renderer.toneMapping = T.ACESFilmicToneMapping;
        const scene = new T.Scene();
        scene.background = new T.Color(0);
        const camera = new T.PerspectiveCamera(45, 1.5, 0.1, 100);
        const geometry = new T.BoxGeometry(0.01, 0.02, 0.03);
        const radiance = quality === "high" ? 16 : 2;
        const material = new T.MeshBasicMaterial({
          color: new T.Color(radiance, radiance, radiance),
        });
        const mesh = new T.InstancedMesh(geometry, material, 60);
        const matrix = new T.Matrix4();
        for (let i = 0; i < 60; i++) {
          matrix.makeTranslation((i - 29.5) / 60, 0, 0);
          mesh.setMatrixAt(i, matrix);
        }
        scene.add(mesh);
        const row = new FilteredEmitterRow(60, 1 / 60, 0.01, 0.02, 0.03);
        scene.add(row.mesh);
        const pipeline = createPostProcessing(renderer, scene, camera, {
          profile: resolveQualityProfile(quality),
          configOverrides: { bloomStrength: 0 },
        });
        const wall = new T.Mesh(
          new T.PlaneGeometry(2, 2),
          new T.MeshBasicMaterial({ color: 0 }),
        );
        try {
          const filtered =
            quality === "high"
              ? pipeline.postProcessing.outputNode
              : T.renderOutput(
                  pipeline.postProcessing.outputNode,
                  renderer.toneMapping,
                  renderer.outputColorSpace,
                );
          pipeline.postProcessing.outputColorTransform = false;
          /** Reads one submitted frame's RGB energy without temporal accumulation or previous-frame blending. */
          const capture = async () => {
            await renderFrames(renderer, 1, () =>
              pipeline.postProcessing.render(),
            );
            const pixels = readPixels(renderer.domElement);
            const energy = [0, 0, 0];
            for (let i = 0; i < pixels.length; i += 4)
              for (let channel = 0; channel < 3; channel++)
                energy[channel] += pixels[i + channel];
            return energy;
          };
          camera.position.z = 4;
          pipeline.outlinePass.selectedObjects = [mesh];
          await capture();
          pipeline.outlinePass.selectedObjects = [];
          const measurements = [];
          for (const alternating of [false, true]) {
            for (let i = 0; i < 60; i++)
              mesh.setColorAt(
                i,
                new T.Color(
                  alternating && i % 2 ? 0 : 1,
                  alternating ? 0 : 1,
                  alternating && !(i % 2) ? 0 : 1,
                ),
              );
            mesh.instanceColor!.needsUpdate = true;
            row.update(
              Array.from(
                mesh.instanceColor!.array,
                (value) => value * radiance,
              ),
            );
            for (const distance of [1.5, 4, 8])
              for (const angle of [0.12, 0.6])
                for (const antialiased of [false, true]) {
                  camera.position.z = distance;
                  mesh.rotation.z = angle;
                  row.mesh.rotation.z = angle;
                  row.mesh.visible = antialiased;
                  mesh.visible = true;
                  material.color.setScalar(antialiased ? 0 : radiance);
                  pipeline.postProcessing.outputNode = antialiased
                    ? filtered
                    : T.renderOutput(
                        pipeline.scenePass.getTextureNode("output"),
                        renderer.toneMapping,
                        renderer.outputColorSpace,
                      );
                  pipeline.postProcessing.needsUpdate = true;
                  const frames = [];
                  for (let step = 0; step < 8; step++) {
                    camera.position.x =
                      (step * distance * Math.tan(Math.PI / 8)) / 1600;
                    frames.push(await capture());
                  }
                  if (antialiased)
                    retainCanvas(
                      `row-${distance}-${angle}-${alternating}`,
                      renderer.domElement,
                    );
                  const totals = frames.map((frame) =>
                    frame.reduce((a, b) => a + b, 0),
                  );
                  const mean =
                    totals.reduce((a, b) => a + b, 0) / totals.length;
                  measurements.push({
                    alternating,
                    distance,
                    angle,
                    antialiased,
                    variation:
                      (Math.max(...totals) - Math.min(...totals)) / mean,
                    frames,
                  });
                }
          }
          material.color.setScalar(0);
          row.update(new Float32Array(180));
          const blackout = await capture();
          wall.position.z = 0.1;
          scene.add(wall);
          row.update(new Float32Array(180).fill(radiance));
          const occluded = await capture();
          return { measurements, blackout, occluded };
        } finally {
          disposePostProcessing(pipeline);
          row.dispose();
          geometry.dispose();
          material.dispose();
          mesh.dispose();
          wall.geometry.dispose();
          wall.material.dispose();
          renderer.dispose();
        }
      },
      { forceWebGL, quality, pixelRatio },
    );
    await expectWithArtifacts(
      testInfo,
      { page, artifacts: { "motion.json": result } },
      () => {
        expect(errors).toEqual([]);
        expect(result.blackout).toEqual([0, 0, 0]);
        expect(result.occluded).toEqual([0, 0, 0]);
        for (const measurement of result.measurements.filter(
          (item) => item.antialiased,
        )) {
          expect(
            measurement.variation,
            `${measurement.distance}m, angle ${measurement.angle}, alternating ${measurement.alternating}`,
          ).toBeLessThan(0.05);
          if (measurement.alternating) {
            for (const [red, green, blue] of measurement.frames) {
              // ACES mixes channels; the averaged red/blue pattern must remain visibly magenta.
              expect(green).toBeLessThan(Math.min(red, blue));
            }
            // Tone mapping need not preserve equal red/blue values, but camera motion must preserve their balance.
            const ratios = measurement.frames.map(
              ([red, _green, blue]) => red / blue,
            );
            const averageRatio =
              ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
            expect(
              (Math.max(...ratios) - Math.min(...ratios)) / averageRatio,
            ).toBeLessThan(0.05);
          }
        }
      },
    );
  });
}

for (const forceWebGL of [false, true]) {
  for (const pixelRatio of [1, 2]) {
    /** Separates HDR coverage, bloom downsampling, and atmospheric integration at a fixed camera. */
    test(`HDR LED stage diagnostics ${backendLabel(forceWebGL)} DPR ${pixelRatio}`, async ({
      page,
    }, testInfo) => {
      const errors = await openOpticsFixture(page);
      const captures = await evaluateOnBackend(
        page,
        async ({ forceWebGL, pixelRatio }) => {
          const T = await import("/e2e/fixtures/three-api.ts");
          const { createPostProcessing, disposePostProcessing } = await import(
            "/features/visualizer/rendering/effects/post-processing.ts"
          );
          const { EmitterVolumeBatch } = await import(
            "/features/visualizer/rendering/effects/emitter-volume-batch.ts"
          );
          const { createTestRenderer, readPixels, renderFrames, retainCanvas } =
            await import("/e2e/fixtures/optics-harness.ts");
          const { renderer } = await createTestRenderer({
            forceWebGL,
            width: 600,
            height: 400,
            pixelRatio,
          });
          renderer.toneMapping = T.ACESFilmicToneMapping;
          const scene = new T.Scene();
          scene.background = new T.Color(0);
          const camera = new T.PerspectiveCamera(45, 1.5, 0.1, 100);
          camera.position.set(0, 0, 4);
          const pipeline = createPostProcessing(renderer, scene, camera);
          const bloomPass = pipeline.bloomPass!;
          const batch = new EmitterVolumeBatch(scene);
          const geometry = new T.BoxGeometry(0.01, 0.02, 0.03);
          const material = new T.MeshBasicMaterial({
            color: new T.Color(16, 16, 16),
          });
          const cells = new T.InstancedMesh(geometry, material, 240);
          const matrix = new T.Matrix4();
          for (let i = 0; i < 240; i++) {
            const row = Math.floor(i / 60);
            const x = ((i % 60) - 29.5) / 60;
            const y = (row - 1.5) * 0.35 + x * 0.12;
            matrix.makeTranslation(x, y, 0);
            cells.setMatrixAt(i, matrix);
            cells.setColorAt(
              i,
              new T.Color(
                row === 0 ? 1 : 0.2,
                row === 1 ? 0.1 : 1,
                row === 2 ? 0.1 : 1,
              ),
            );
            const anchor = new T.Object3D();
            anchor.position.set(x, y, 0);
            anchor.rotation.x = -Math.PI / 2;
            anchor.updateMatrixWorld(true);
            batch.update(String(i), anchor, {
              optics: {
                shape: "round",
                radius: 0.005,
                slopeX: 1,
                slopeY: 1,
                halfPowerRatio: 0.5,
                distributionPower: 2,
                lumens: 20,
              },
              color: { red: 1, green: 0.5, blue: 0.1, intensity: 1 },
            });
          }
          scene.add(cells);
          const original = pipeline.postProcessing.outputNode;
          const originalDisplay = pipeline.displayMaterial!.fragmentNode;
          const originalBloom = T.bloom(
            pipeline.scenePass
              .getTextureNode("output")
              .add(pipeline.volumePass.getTextureNode("output")),
            0.8,
            0.85,
            0.8,
          );
          try {
            const output = [];
            for (const scale of [0.5, 0.25]) {
              pipeline.volumePass.setResolutionScale(scale);
              bloomPass.setResolutionScale(scale);
              originalBloom.setResolutionScale(scale);
              for (const stage of [
                "scene",
                "bloom",
                "atmosphere",
                "combined",
                "develop-brightness",
                "display-antialias",
                "original-bloom",
                "no-tone-mapping",
                "develop-style",
              ] as const) {
                material.color.setScalar(
                  stage.startsWith("develop-") ? 1.15 : 16,
                );
                renderer.toneMapping =
                  stage === "no-tone-mapping" || stage === "develop-style"
                    ? T.NoToneMapping
                    : T.ACESFilmicToneMapping;
                pipeline.postProcessing.outputNode =
                  stage === "scene" ||
                  stage.startsWith("develop-") ||
                  stage === "no-tone-mapping"
                    ? pipeline.scenePass.getTextureNode("output")
                    : stage === "bloom"
                      ? bloomPass
                      : stage === "atmosphere"
                        ? pipeline.volumePass.getTextureNode("output")
                        : original;
                pipeline.postProcessing.needsUpdate = true;
                pipeline.postProcessing.outputColorTransform =
                  stage !== "display-antialias" && stage !== "combined";
                pipeline.displayMaterial!.fragmentNode =
                  stage === "display-antialias"
                    ? T.renderOutput(
                        pipeline.scenePass.getTextureNode("output"),
                        renderer.toneMapping,
                        renderer.outputColorSpace,
                      )
                    : originalDisplay;
                pipeline.displayMaterial!.needsUpdate = true;
                if (stage === "original-bloom")
                  pipeline.postProcessing.outputNode = originalBloom;
                await renderFrames(renderer, 3, () =>
                  pipeline.postProcessing.render(),
                );
                const name = `${stage}-${scale}`;
                retainCanvas(name, renderer.domElement);
                const width = renderer.domElement.width;
                const pixels = readPixels(renderer.domElement);
                const columns: number[] = [];
                let partial = 0;
                let energy = 0;
                for (let x = 260 * pixelRatio; x < 340 * pixelRatio; x++) {
                  let column = 0;
                  for (let y = 247 * pixelRatio; y < 280 * pixelRatio; y++) {
                    const value = pixels[(y * width + x) * 4];
                    column += value;
                    if (value > 5 && value < 180) partial++;
                  }
                  columns.push(column);
                  energy += column;
                }
                let ripple = 0;
                for (let i = 1; i < columns.length - 1; i++)
                  ripple += Math.abs(
                    columns[i - 1] - 2 * columns[i] + columns[i + 1],
                  );
                output.push({ name, partial, energy, ripple });
              }
            }
            return output;
          } finally {
            batch.dispose();
            originalBloom.dispose();
            disposePostProcessing(pipeline);
            geometry.dispose();
            material.dispose();
            cells.dispose();
            renderer.dispose();
          }
        },
        { forceWebGL, pixelRatio },
      );
      /** Looks up one stage measurement by name. */
      const stage = (name: string) =>
        captures.find((capture) => capture.name === name)!;
      await expectWithArtifacts(
        testInfo,
        { page, artifacts: { "hdr-metrics.json": captures } },
        () => {
          expect(errors).toEqual([]);
          expect(captures).toHaveLength(18);
          for (const scale of [0.5, 0.25]) {
            const raw = stage(`scene-${scale}`);
            const antialiased = stage(`display-antialias-${scale}`);
            expect(antialiased.ripple).toBeLessThan(raw.ripple * 0.8);
            expect(antialiased.energy).toBeGreaterThan(raw.energy * 0.8);
            expect(antialiased.energy).toBeLessThan(raw.energy * 1.1);
          }
          const originalBloom = stage("original-bloom-0.25");
          const filteredBloom = stage("bloom-0.25");
          // At DPR 1 the quarter-resolution footprint reproduces visible periodic blobs.
          // At DPR 2 quantization dominates this second-difference metric; bound absolute ripple instead.
          if (pixelRatio === 1)
            expect(filteredBloom.ripple).toBeLessThan(originalBloom.ripple);
          expect(filteredBloom.ripple / filteredBloom.energy).toBeLessThan(
            0.001,
          );
          // The aliased reference can overestimate brightness; filtering must retain the luminous appearance.
          expect(filteredBloom.energy).toBeGreaterThan(
            originalBloom.energy * 0.85,
          );
          expect(filteredBloom.energy).toBeLessThan(
            originalBloom.energy * 1.15,
          );
        },
      );
    });
  }
}

for (const quality of ["low", "medium"] as const) {
  for (const forceWebGL of [false, true]) {
    /** Checks preset-specific overlap blending and opaque occlusion. */
    test(`${quality} geometry beams respect opaque depth on ${backendLabel(forceWebGL)}`, async ({
      page,
    }, testInfo) => {
      const errors = await openOpticsFixture(page);
      const result = await evaluateOnBackend(
        page,
        async ({ quality, forceWebGL }) => {
          const T = await import("/e2e/fixtures/three-api.ts");
          const { createPostProcessing, disposePostProcessing } = await import(
            "/features/visualizer/rendering/effects/post-processing.ts"
          );
          const { EmitterVolumeBatch } = await import(
            "/features/visualizer/rendering/effects/emitter-volume-batch.ts"
          );
          const { resolveQualityProfile } = await import(
            "/features/visualizer/rendering/quality-profile.ts"
          );
          const { createTestRenderer, renderAndSum, retainCanvas } =
            await import("/e2e/fixtures/optics-harness.ts");
          const { renderer } = await createTestRenderer({
            forceWebGL,
            width: 400,
            height: 300,
          });
          const scene = new T.Scene();
          scene.background = new T.Color(0);
          const camera = new T.PerspectiveCamera(50, 4 / 3, 0.1, 100);
          camera.position.set(4, 2, 4);
          camera.lookAt(0, 0, -8);
          scene.add(camera);
          const pipeline = createPostProcessing(renderer, scene, camera, {
            profile: resolveQualityProfile(quality),
          });
          const batch = new EmitterVolumeBatch(scene);
          const beam = {
            optics: {
              shape: "round" as const,
              radius: 0.02,
              slopeX: 0.08,
              slopeY: 0.08,
              halfPowerRatio: 0.5,
              distributionPower: 4,
              lumens: 1000,
            },
            color: { red: 1, green: 0, blue: 0, intensity: 0.5 },
          };
          const wall = new T.Mesh(
            new T.PlaneGeometry(2, 2),
            new T.MeshBasicMaterial({ color: 0 }),
          );
          /** Returns the red energy of the complete beam image once its GPU commands are submitted. */
          const capture = async (retain: string) => {
            const { red } = await renderAndSum(renderer, () =>
              pipeline.postProcessing.render(),
            );
            retainCanvas(retain, renderer.domElement);
            return red;
          };
          try {
            batch.update("beam", new T.Object3D(), beam);
            const lit = await capture("lit");
            batch.update("overlapping-beam", new T.Object3D(), beam);
            const overlapping = await capture("overlapping");
            wall.position.z = -0.5;
            camera.add(wall);
            const hidden = await capture("hidden");
            return { lit, overlapping, hidden };
          } finally {
            batch.dispose();
            disposePostProcessing(pipeline);
            wall.geometry.dispose();
            wall.material.dispose();
            renderer.dispose();
          }
        },
        { quality, forceWebGL },
      );
      await expectWithArtifacts(
        testInfo,
        { page, artifacts: { "beam-energy.json": result } },
        () => {
          expect(errors).toEqual([]);
          expect(result.lit).toBeGreaterThan(1000);
          if (quality === "low") {
            expect(
              Math.abs(result.overlapping / result.lit - 1),
            ).toBeLessThanOrEqual(MAX_BLEND_TOLERANCE);
          } else {
            expect(result.overlapping).toBeGreaterThan(result.lit * 1.1);
          }
          expect(result.hidden).toBeLessThan(result.lit * 0.01);
        },
      );
    });
  }
}

for (const forceWebGL of [false, true]) {
  /** Verifies partial pixel coverage for distant LED cells through the production scene pass. */
  test(`distant emitter antialiasing on ${backendLabel(forceWebGL)}`, async ({
    page,
  }, testInfo) => {
    const errors = await openOpticsFixture(page);
    const result = await evaluateOnBackend(
      page,
      async (forceWebGL) => {
        const T = await import("/e2e/fixtures/three-api.ts");
        const { createPostProcessing, disposePostProcessing } = await import(
          "/features/visualizer/rendering/effects/post-processing.ts"
        );
        const { resolveQualityProfile } = await import(
          "/features/visualizer/rendering/quality-profile.ts"
        );
        const { createTestRenderer, readPixels, renderFrames, retainCanvas } =
          await import("/e2e/fixtures/optics-harness.ts");
        const results = [];
        for (const sceneSamples of [0, 4]) {
          const { renderer } = await createTestRenderer({
            forceWebGL,
            width: 400,
            height: 400,
            canvas: document.createElement("canvas"),
            antialias: false,
          });
          const scene = new T.Scene();
          scene.background = new T.Color(0);
          const camera = new T.PerspectiveCamera(45, 1, 0.1, 100);
          camera.position.z = 15;
          const geometry = new T.BoxGeometry(0.085, 0.02, 0.03);
          const material = new T.MeshBasicMaterial({ color: 0xffffff });
          const cells = new T.InstancedMesh(geometry, material, 600);
          const matrix = new T.Matrix4();
          for (let i = 0; i < 600; i++) {
            matrix.makeTranslation(
              ((i % 60) - 30) * 0.1,
              (Math.floor(i / 60) - 5) * 0.5,
              0,
            );
            cells.setMatrixAt(i, matrix);
          }
          cells.rotation.z = 0.13;
          scene.add(cells);
          const pipeline = createPostProcessing(renderer, scene, camera, {
            profile: resolveQualityProfile("medium"),
            sceneSamples,
          });
          try {
            await renderFrames(renderer, 4, () =>
              pipeline.postProcessing.render(),
            );
            retainCanvas(`leds-${sceneSamples}x`, renderer.domElement);
            const pixels = readPixels(renderer.domElement);
            let partial = 0;
            for (let i = 0; i < pixels.length; i += 4)
              if (pixels[i] > 10 && pixels[i] < 245) partial++;
            results.push({ sceneSamples, partial });
          } finally {
            disposePostProcessing(pipeline);
            geometry.dispose();
            material.dispose();
            cells.dispose();
            renderer.dispose();
          }
        }
        return results;
      },
      forceWebGL,
    );
    await expectWithArtifacts(
      testInfo,
      { page, artifacts: { "coverage.json": result } },
      () => {
        expect(errors).toEqual([]);
        const [singleSampled, multisampled] = result;
        expect(multisampled.partial).toBeGreaterThan(
          singleSampled.partial + 100,
        );
      },
    );
  });
}
