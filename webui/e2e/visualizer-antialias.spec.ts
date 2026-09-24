// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { writeFile } from "node:fs/promises";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

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
          const pipeline = createPostProcessing(renderer, scene, camera, {
            quality,
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
        const pipeline = createPostProcessing(renderer, scene, camera, {
          quality: "medium",
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
