// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { writeFile } from "node:fs/promises";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Measures distant LED stability during subpixel motion and checks that filtering leaves no blackout history. */
for (const forceWebGL of [false, true]) {
  for (const pixelRatio of [1, 2]) {
    for (const quality of ["low", "medium", "high"] as const) {
      test(`HDR LED subpixel motion and blackout ${forceWebGL ? "WebGL" : "WebGPU"} ${quality} DPR ${pixelRatio}`, async ({
        page,
      }, testInfo) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        await page.goto("/e2e/fixtures/optics.html");
        const result = await page.evaluate(
          async ({ forceWebGL, quality, pixelRatio }) => {
            const T = await import("/e2e/fixtures/three-api.ts");
            const { createPostProcessing, disposePostProcessing } =
              await import(
                "/features/visualizer/rendering/effects/post-processing.ts"
              );
            const renderer = new T.WebGPURenderer({
              canvas: document.querySelector("canvas")!,
              forceWebGL,
            });
            renderer.setPixelRatio(pixelRatio);
            renderer.setSize(600, 400);
            renderer.toneMapping = T.ACESFilmicToneMapping;
            await renderer.init();
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
            const { FilteredEmitterRow } = await import(
              "/features/visualizer/rendering/effects/filtered-emitter-row.ts"
            );
            const row = new FilteredEmitterRow(60, 1 / 60, 0.01, 0.02, 0.03);
            scene.add(row.mesh);
            const { resolveQualityProfile } = await import(
              "/features/visualizer/rendering/quality-profile.ts"
            );
            const pipeline = createPostProcessing(renderer, scene, camera, {
              profile: resolveQualityProfile(quality),
              configOverrides: { bloomStrength: 0 },
            });
            const filtered =
              quality === "high"
                ? pipeline.postProcessing.outputNode
                : T.renderOutput(
                    pipeline.postProcessing.outputNode,
                    renderer.toneMapping,
                    renderer.outputColorSpace,
                  );
            pipeline.postProcessing.outputColorTransform = false;
            const copy = document.createElement("canvas");
            copy.width = 600 * pixelRatio;
            copy.height = 400 * pixelRatio;
            const context = copy.getContext("2d")!;
            /** Reads a submitted frame without temporal accumulation or previous-frame blending. */
            const capture = async () => {
              await new Promise<void>((resolve) =>
                renderer.setAnimationLoop(() => {
                  pipeline.postProcessing.render();
                  renderer.setAnimationLoop(null);
                  resolve();
                }),
              );
              context.drawImage(renderer.domElement, 0, 0);
              const pixels = context.getImageData(
                0,
                0,
                copy.width,
                copy.height,
              ).data;
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
                      image: renderer.domElement.toDataURL(),
                    });
                  }
            }
            material.color.setScalar(0);
            row.update(new Float32Array(180));
            const blackout = await capture();
            const wall = new T.Mesh(
              new T.PlaneGeometry(2, 2),
              new T.MeshBasicMaterial({ color: 0 }),
            );
            wall.position.z = 0.1;
            scene.add(wall);
            row.update(new Float32Array(180).fill(radiance));
            const occluded = await capture();
            disposePostProcessing(pipeline);
            row.dispose();
            geometry.dispose();
            material.dispose();
            mesh.dispose();
            wall.geometry.dispose();
            wall.material.dispose();
            renderer.dispose();
            return { measurements, blackout, occluded };
          },
          { forceWebGL, quality, pixelRatio },
        );
        await writeFile(
          testInfo.outputPath("motion.json"),
          JSON.stringify(
            {
              ...result,
              measurements: result.measurements.map(
                ({ image: _image, ...measurement }) => measurement,
              ),
            },
            null,
            2,
          ),
        );
        for (const measurement of result.measurements) {
          await writeFile(
            testInfo.outputPath(
              `row-${measurement.distance}-${measurement.angle}-${measurement.alternating}-${measurement.antialiased}.png`,
            ),
            Buffer.from(measurement.image.split(",")[1], "base64"),
          );
        }
        expect(result.blackout).toEqual([0, 0, 0]);
        expect(result.occluded).toEqual([0, 0, 0]);
        expect(errors).toEqual([]);
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
      });
    }
  }
}

/** Separates HDR coverage, bloom downsampling, and atmospheric integration at a fixed camera. */
for (const forceWebGL of [false, true]) {
  for (const pixelRatio of [1, 2]) {
    test(`HDR LED stage diagnostics ${forceWebGL ? "WebGL" : "WebGPU"} DPR ${pixelRatio}`, async ({
      page,
    }, testInfo) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.goto("/e2e/fixtures/optics.html");
      const captures = await page.evaluate(
        async ({ forceWebGL, pixelRatio }) => {
          const T = await import("/e2e/fixtures/three-api.ts");
          const { createPostProcessing, disposePostProcessing } = await import(
            "/features/visualizer/rendering/effects/post-processing.ts"
          );
          const { EmitterVolumeBatch } = await import(
            "/features/visualizer/rendering/effects/emitter-volume-batch.ts"
          );
          const renderer = new T.WebGPURenderer({
            canvas: document.querySelector("canvas")!,
            forceWebGL,
          });
          renderer.setPixelRatio(pixelRatio);
          renderer.setSize(600, 400);
          renderer.toneMapping = T.ACESFilmicToneMapping;
          await renderer.init();
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
            batch.update(
              String(i),
              anchor,
              {
                shape: "round",
                radius: 0.005,
                slopeX: 1,
                slopeY: 1,
                halfPowerRatio: 0.5,
                distributionPower: 2,
                lumens: 20,
              },
              { red: 1, green: 0.5, blue: 0.1, intensity: 1 },
            );
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
              if (stage === "display-antialias") {
                pipeline.displayMaterial!.fragmentNode = T.renderOutput(
                  pipeline.scenePass.getTextureNode("output"),
                  renderer.toneMapping,
                  renderer.outputColorSpace,
                );
              } else {
                pipeline.displayMaterial!.fragmentNode = originalDisplay;
              }
              pipeline.displayMaterial!.needsUpdate = true;
              if (stage === "original-bloom")
                pipeline.postProcessing.outputNode = originalBloom;
              await new Promise<void>((resolve) => {
                let frame = 0;
                renderer.setAnimationLoop(() => {
                  pipeline.postProcessing.render();
                  if (++frame === 3) {
                    renderer.setAnimationLoop(null);
                    resolve();
                  }
                });
              });
              const copy = document.createElement("canvas");
              copy.width = 600 * pixelRatio;
              copy.height = 400 * pixelRatio;
              const context = copy.getContext("2d")!;
              context.drawImage(renderer.domElement, 0, 0);
              const pixels = context.getImageData(
                0,
                0,
                copy.width,
                copy.height,
              ).data;
              const columns: number[] = [];
              let partial = 0;
              let energy = 0;
              for (let x = 260 * pixelRatio; x < 340 * pixelRatio; x++) {
                let column = 0;
                for (let y = 247 * pixelRatio; y < 280 * pixelRatio; y++) {
                  const value = pixels[(y * copy.width + x) * 4];
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
              output.push({
                name: `${stage}-${scale}`,
                image: renderer.domElement.toDataURL(),
                partial,
                energy,
                ripple,
              });
            }
          }
          batch.dispose();
          originalBloom.dispose();
          disposePostProcessing(pipeline);
          geometry.dispose();
          material.dispose();
          cells.dispose();
          renderer.dispose();
          return output;
        },
        { forceWebGL, pixelRatio },
      );
      for (const capture of captures) {
        await writeFile(
          testInfo.outputPath(`${capture.name}.png`),
          Buffer.from(capture.image.split(",")[1], "base64"),
        );
      }
      await testInfo.attach("HDR metrics", {
        body: JSON.stringify(
          captures.map(({ image: _image, ...metrics }) => metrics),
        ),
        contentType: "application/json",
      });
      await writeFile(
        testInfo.outputPath("metrics.json"),
        JSON.stringify(
          captures.map(({ image: _image, ...metrics }) => metrics),
          null,
          2,
        ),
      );
      expect(captures).toHaveLength(18);
      expect(errors).toEqual([]);
      for (const scale of [0.5, 0.25]) {
        const raw = captures.find(
          (capture) => capture.name === `scene-${scale}`,
        )!;
        const antialiased = captures.find(
          (capture) => capture.name === `display-antialias-${scale}`,
        )!;
        expect(antialiased.ripple).toBeLessThan(raw.ripple * 0.8);
        expect(antialiased.energy).toBeGreaterThan(raw.energy * 0.8);
        expect(antialiased.energy).toBeLessThan(raw.energy * 1.1);
      }
      const originalBloom = captures.find(
        (capture) => capture.name === "original-bloom-0.25",
      )!;
      const filteredBloom = captures.find(
        (capture) => capture.name === "bloom-0.25",
      )!;
      // At DPR 1 the quarter-resolution footprint reproduces visible periodic blobs.
      // At DPR 2 quantization dominates this second-difference metric; bound absolute ripple instead.
      if (pixelRatio === 1)
        expect(filteredBloom.ripple).toBeLessThan(originalBloom.ripple);
      expect(filteredBloom.ripple / filteredBloom.energy).toBeLessThan(0.001);
      // The aliased reference can overestimate brightness; filtering must retain the luminous appearance.
      expect(filteredBloom.energy).toBeGreaterThan(originalBloom.energy * 0.85);
      expect(filteredBloom.energy).toBeLessThan(originalBloom.energy * 1.15);
    });
  }
}

for (const quality of ["low", "medium"] as const) {
  for (const forceWebGL of [false, true]) {
    /** Checks preset-specific overlap blending and opaque occlusion in both backends. */
    test(`${quality} geometry beams respect opaque depth on ${forceWebGL ? "WebGL" : "WebGPU"}`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.goto("/e2e/fixtures/optics.html");
      const result = await page.evaluate(
        async ({ quality, forceWebGL }) => {
          const T = await import("/e2e/fixtures/three-api.ts");
          const { createPostProcessing, disposePostProcessing } = await import(
            "/features/visualizer/rendering/effects/post-processing.ts"
          );
          const { EmitterVolumeBatch } = await import(
            "/features/visualizer/rendering/effects/emitter-volume-batch.ts"
          );
          const renderer = new T.WebGPURenderer({
            canvas: document.querySelector("canvas")!,
            forceWebGL,
          });
          renderer.setSize(400, 300);
          await renderer.init();
          const scene = new T.Scene();
          scene.background = new T.Color(0);
          const camera = new T.PerspectiveCamera(50, 4 / 3, 0.1, 100);
          camera.position.set(4, 2, 4);
          camera.lookAt(0, 0, -8);
          scene.add(camera);
          const { resolveQualityProfile } = await import(
            "/features/visualizer/rendering/quality-profile.ts"
          );
          const pipeline = createPostProcessing(renderer, scene, camera, {
            profile: resolveQualityProfile(quality),
          });
          const batch = new EmitterVolumeBatch(scene);
          batch.update(
            "beam",
            new T.Object3D(),
            {
              shape: "round",
              radius: 0.02,
              slopeX: 0.08,
              slopeY: 0.08,
              halfPowerRatio: 0.5,
              distributionPower: 4,
              lumens: 1000,
            },
            { red: 1, green: 0, blue: 0, intensity: 0.5 },
          );
          /** Reads the complete beam image after its GPU commands have been submitted. */
          const capture = async () => {
            await new Promise<void>((resolve) => {
              let frames = 0;
              renderer.setAnimationLoop(() => {
                pipeline.postProcessing.render();
                if (++frames === 4) {
                  renderer.setAnimationLoop(null);
                  resolve();
                }
              });
            });
            const copy = document.createElement("canvas");
            copy.width = 400;
            copy.height = 300;
            const context = copy.getContext("2d")!;
            context.drawImage(renderer.domElement, 0, 0);
            const pixels = context.getImageData(0, 0, 400, 300).data;
            let red = 0;
            for (let i = 0; i < pixels.length; i += 4) red += pixels[i];
            return red;
          };
          const lit = await capture();
          batch.update(
            "overlapping-beam",
            new T.Object3D(),
            {
              shape: "round",
              radius: 0.02,
              slopeX: 0.08,
              slopeY: 0.08,
              halfPowerRatio: 0.5,
              distributionPower: 4,
              lumens: 1000,
            },
            { red: 1, green: 0, blue: 0, intensity: 0.5 },
          );
          const overlapping = await capture();
          const wall = new T.Mesh(
            new T.PlaneGeometry(2, 2),
            new T.MeshBasicMaterial({ color: 0 }),
          );
          wall.position.z = -0.5;
          camera.add(wall);
          const hidden = await capture();
          batch.dispose();
          disposePostProcessing(pipeline);
          wall.geometry.dispose();
          wall.material.dispose();
          renderer.dispose();
          return { lit, overlapping, hidden };
        },
        { quality, forceWebGL },
      );
      expect(result.lit).toBeGreaterThan(1000);
      if (quality === "low") {
        expect(result.overlapping).toBe(result.lit);
      } else {
        expect(result.overlapping).toBeGreaterThan(result.lit * 1.1);
      }
      expect(result.hidden).toBeLessThan(result.lit * 0.01);
      expect(errors).toEqual([]);
    });
  }
}

for (const forceWebGL of [false, true]) {
  /** Verifies partial pixel coverage for distant LED cells through the production scene pass. */
  test(`distant emitter antialiasing on ${forceWebGL ? "WebGL" : "WebGPU"}`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto("/e2e/fixtures/optics.html");
    const result = await page.evaluate(async (forceWebGL) => {
      const T = await import("/e2e/fixtures/three-api.ts");
      const { createPostProcessing, disposePostProcessing } = await import(
        "/features/visualizer/rendering/effects/post-processing.ts"
      );
      const results = [];
      for (const multisampled of [false, true]) {
        const renderer = new T.WebGPURenderer({
          canvas: document.createElement("canvas"),
          antialias: false,
          forceWebGL,
        });
        renderer.setSize(400, 400);
        await renderer.init();
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
        const { resolveQualityProfile } = await import(
          "/features/visualizer/rendering/quality-profile.ts"
        );
        const pipeline = createPostProcessing(renderer, scene, camera, {
          profile: resolveQualityProfile("medium"),
        });
        if (!multisampled)
          Object.assign(pipeline.scenePass, { options: { samples: 0 } });
        await new Promise<void>((resolve) => {
          let frames = 0;
          renderer.setAnimationLoop(() => {
            pipeline.postProcessing.render();
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
        let partial = 0;
        for (let i = 0; i < pixels.length; i += 4)
          if (pixels[i] > 10 && pixels[i] < 245) partial++;
        results.push({ partial, image: copy.toDataURL("image/png") });
        disposePostProcessing(pipeline);
        geometry.dispose();
        material.dispose();
        cells.dispose();
        renderer.dispose();
      }
      return results;
    }, forceWebGL);
    for (const [i, capture] of result.entries()) {
      await writeFile(
        testInfo.outputPath(
          i ? "antialiased-leds.png" : "single-sample-leds.png",
        ),
        Buffer.from(capture.image.split(",")[1], "base64"),
      );
      await testInfo.attach(i ? "antialiased-leds" : "single-sample-leds", {
        body: Buffer.from(capture.image.split(",")[1], "base64"),
        contentType: "image/png",
      });
    }
    expect(result[1].partial).toBeGreaterThan(result[0].partial + 100);
    expect(errors).toEqual([]);
  });
}
