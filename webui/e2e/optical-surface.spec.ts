// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { PhysicalUnit } from "../types";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Crowded clusters must retain both late sources and the energy of genuinely overlapping beams. */
test("crowded optical clusters preserve all contributing sources", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/e2e/fixtures/optics.html");
  const result = await page.evaluate(async () => {
    const THREE = await import("/e2e/fixtures/three-api.ts");
    const { OpticalSurfaceLight, OpticalSurfaceLighting } = await import(
      "/features/visualizer/rendering/effects/optical-surface-lighting.ts"
    );
    const renderer = new THREE.WebGPURenderer({
      canvas: document.querySelector("canvas")!,
    });
    renderer.setSize(400, 400);
    await renderer.init();
    const lighting = new OpticalSurfaceLighting();
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
    const optics = {
      shape: "round" as const,
      radius: 0.02,
      slopeX: 0.15,
      slopeY: 0.15,
      halfPowerRatio: 0.5,
      distributionPower: 8,
      lumens: 1000,
    };
    const lights = Array.from({ length: 100 }, () => {
      const light = new OpticalSurfaceLight(optics);
      light.color.setRGB(0, 0, 1);
      light.intensity = 0.1;
      light.apertureForward.set(0, 0, 1);
      scene.add(light);
      return light;
    });
    lights[99].apertureForward.set(0, 0, -1);
    /** Measures the same illuminated surface after each light configuration reaches the GPU. */
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
      let blue = 0;
      for (let i = 2; i < pixels.length; i += 4) blue += pixels[i];
      return { blue, image: copy.toDataURL("image/png") };
    };
    try {
      const crowded = await capture();
      for (let i = 0; i < 99; i++) lights[i].visible = false;
      const reference = await capture();
      for (const light of lights) {
        light.visible = true;
        light.apertureForward.set(0, 0, -1);
        light.intensity = 0.001;
      }
      const overlap = await capture();
      return { crowded, reference, overlap };
    } finally {
      lighting.dispose();
      wall.geometry.dispose();
      wall.material.dispose();
      renderer.dispose();
    }
  });
  await testInfo.attach("crowded-clusters.json", {
    body: JSON.stringify({
      crowded: result.crowded.blue,
      reference: result.reference.blue,
      overlap: result.overlap.blue,
    }),
    contentType: "application/json",
  });
  await testInfo.attach("crowded-clusters.png", {
    body: Buffer.from(result.crowded.image.split(",")[1], "base64"),
    contentType: "image/png",
  });
  expect(errors).toEqual([]);
  expect(result.reference.blue).toBeGreaterThan(10000);
  expect(
    Math.abs(result.crowded.blue / result.reference.blue - 1),
  ).toBeLessThan(0.02);
  expect(
    Math.abs(result.overlap.blue / result.reference.blue - 1),
  ).toBeLessThan(0.02);
});

for (const forceWebGL of [false, true]) {
  /** Clustered sources illuminate real geometry only inside their optical projection on both backends. */
  test(`clustered aperture lights shade surfaces and respect direction (${forceWebGL ? "WebGL" : "WebGPU"})`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.route("**/__optical-surface__", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<canvas width="640" height="480"></canvas>',
      }),
    );
    await page.goto("/__optical-surface__");
    const result = await page.evaluate(async (forceWebGL) => {
      const THREE = await import("/e2e/fixtures/three-api.ts");
      const { OpticalSurfaceLight } = await import(
        "/features/visualizer/rendering/effects/optical-surface-lighting.ts"
      );
      const { createPostProcessing, disposePostProcessing } = await import(
        "/features/visualizer/rendering/effects/post-processing.ts"
      );
      const { EmitterOpticalState } = await import(
        "/features/visualizer/rendering/effects/emitter-optical-state.ts"
      );
      const renderer = new THREE.WebGPURenderer({
        canvas: document.querySelector("canvas")!,
        forceWebGL,
      });
      renderer.setSize(640, 480);
      await renderer.init();
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0);
      const camera = new THREE.PerspectiveCamera(45, 640 / 480, 0.1, 100);
      camera.position.z = 4;
      const pipeline = createPostProcessing(renderer, scene, camera);
      const lighting = pipeline.surfaceLighting;
      if (!lighting)
        throw new Error("Production optical lighting is unavailable");
      const wall = new THREE.Mesh(
        new THREE.PlaneGeometry(8, 6),
        new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1 }),
      );
      wall.position.z = -4;
      scene.add(wall);
      const optics = {
        shape: "round" as const,
        radius: 0.02,
        slopeX: 0.15,
        slopeY: 0.15,
        halfPowerRatio: 0.5,
        distributionPower: 8,
        lumens: 1000,
      };
      const red = new OpticalSurfaceLight(optics);
      red.color.setRGB(1, 0, 0);
      red.intensity = 0.1;
      scene.add(red);
      const blue = new OpticalSurfaceLight(optics);
      blue.position.z = 1;
      blue.color.setRGB(0, 0, 1);
      blue.intensity = 0.1;
      blue.apertureForward.set(0, 0, 1);
      scene.add(blue);
      for (let i = 0; i < 300; i++) {
        const light = new THREE.PointLight(0xffffff, 1, 1);
        light.position.set(50 + i, 0, -2);
        scene.add(light);
      }
      /** Reads pixels after real GPU submissions, retaining the image for visual verification. */
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
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 480;
        const context = canvas.getContext("2d")!;
        context.drawImage(renderer.domElement, 0, 0);
        const pixels = context.getImageData(0, 0, 640, 480).data;
        let red = 0,
          blue = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          red += pixels[i];
          blue += pixels[i + 2];
        }
        return { red, blue, image: canvas.toDataURL("image/png") };
      };
      const lit = await capture();
      pipeline.scenePass.setResolutionScale(0.5);
      const reducedResolution = await capture();
      pipeline.scenePass.setResolutionScale(1);
      red.intensity = 0.02;
      const wideBounds = await capture();
      red.distance = 4.5;
      const tightBounds = await capture();
      red.distance = 40;
      red.intensity = 0.1;
      red.secondaryColor.setRGB(0, 0, 1);
      red.splitColor = true;
      const split = await capture();
      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = maskCanvas.height = 256;
      const maskContext = maskCanvas.getContext("2d")!;
      maskContext.fillStyle = "black";
      maskContext.fillRect(0, 0, 256, 256);
      const mask = lighting.goboAtlas.load(maskCanvas.toDataURL("image/png"));
      while (mask.status === "loading")
        await new Promise((resolve) => setTimeout(resolve, 10));
      if (mask.status !== "ready")
        throw new Error("Gobo mask failed to decode");
      red.goboSlot = mask.index;
      const blocked = await capture();
      maskContext.fillStyle = "white";
      maskContext.fillRect(0, 0, 128, 256);
      const halfMask = lighting.goboAtlas.load(
        maskCanvas.toDataURL("image/png"),
      );
      while (halfMask.status === "loading")
        await new Promise((resolve) => setTimeout(resolve, 10));
      if (halfMask.status !== "ready")
        throw new Error("Half gobo failed to decode");
      const opticalState = new EmitterOpticalState(
        {
          mesh: wall,
          controlledElement: "Head",
          opticalChannels: [
            {
              geometry: "Head",
              attribute: "Gobo1Pos",
              parameterKey: "GoboRot",
              dmxMax: 255,
              functions: [
                {
                  attribute: "Gobo1Pos",
                  dmxFrom: 0,
                  dmxTo: 255,
                  physicalFrom: 0,
                  physicalTo: 0,
                  sets: [],
                  physicalUnit: "Angle" as PhysicalUnit,
                  profile: { type: "Linear" },
                  modeMaster: {
                    type: "Resolved",
                    data: [
                      {
                        geometry: "Base",
                        parameterKey: "Control",
                        dmxMax: 255,
                        dmxFrom: 0,
                        dmxTo: 127,
                      },
                    ],
                  },
                },
                {
                  attribute: "Gobo1PosRotate",
                  dmxFrom: 0,
                  dmxTo: 255,
                  physicalFrom: 180,
                  physicalTo: 180,
                  sets: [],
                  physicalUnit: "AngularSpeed" as PhysicalUnit,
                  profile: { type: "Linear" },
                  modeMaster: {
                    type: "Resolved",
                    data: [
                      {
                        geometry: "Base",
                        parameterKey: "Control",
                        dmxMax: 255,
                        dmxFrom: 128,
                        dmxTo: 255,
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
        () => {
          throw new Error("Rotation must not request wheel media");
        },
      );
      const modeValues = {
        red: 1,
        green: 1,
        blue: 1,
        intensity: 1,
        Control: 0,
      };
      const opticalValues = new Map<
        string,
        | typeof modeValues
        | {
            red: number;
            green: number;
            blue: number;
            intensity: number;
            "optical:GoboRot": number;
          }
      >([
        ["Base", modeValues],
        [
          "Head",
          { red: 1, green: 1, blue: 1, intensity: 1, "optical:GoboRot": 1 },
        ],
      ]);
      opticalState.update(opticalValues, 0);
      red.goboSlot = halfMask.index;
      red.goboRotation = opticalState.goboRotation;
      const half = await capture();
      red.focusDistance = 0.2;
      const defocused = await capture();
      red.focusDistance = 0;
      modeValues.Control = 1;
      opticalState.update(opticalValues, 1);
      red.goboRotation = opticalState.goboRotation;
      const rotated = await capture();
      modeValues.Control = 0;
      opticalState.update(opticalValues, 2);
      red.goboRotation = opticalState.goboRotation;
      const reindexed = await capture();
      red.goboSlot = lighting.goboAtlas.stacks.update("surface", [
        { slot: mask.index, rotation: 0 },
        { slot: halfMask.index, rotation: 0 },
      ]);
      const stackBlocked = await capture();
      red.goboSlot = lighting.goboAtlas.stacks.update("surface", [
        { slot: halfMask.index, rotation: 0 },
        { slot: halfMask.index, rotation: Math.PI },
      ]);
      const complementary = await capture();
      red.goboSlot = 0;
      red.apertureForward.set(0, 0, 1);
      const away = await capture();
      disposePostProcessing(pipeline);
      wall.geometry.dispose();
      wall.material.dispose();
      renderer.dispose();
      return {
        lit,
        reducedResolution,
        wideBounds,
        tightBounds,
        split,
        blocked,
        half,
        defocused,
        rotated,
        reindexed,
        stackBlocked,
        complementary,
        away,
      };
    }, forceWebGL);
    await testInfo.attach("surface-light.png", {
      body: Buffer.from(result.lit.image.split(",")[1], "base64"),
      contentType: "image/png",
    });
    expect(errors).toEqual([]);
    expect(result.lit.red).toBeGreaterThan(10000);
    expect(result.lit.blue).toBe(0);
    expect(result.reducedResolution.red / result.lit.red).toBeGreaterThan(0.9);
    expect(result.reducedResolution.red / result.lit.red).toBeLessThan(1.1);
    expect(result.reducedResolution.blue).toBe(0);
    await testInfo.attach("surface-half-resolution.png", {
      body: Buffer.from(result.reducedResolution.image.split(",")[1], "base64"),
      contentType: "image/png",
    });
    // Both spheres contain the wall footprint; only the optical profile sets its brightness.
    expect(result.wideBounds.red).toBeGreaterThan(10000);
    expect(result.tightBounds.red / result.wideBounds.red).toBeCloseTo(1, 3);
    expect(result.split.red).toBeGreaterThan(10000);
    expect(result.split.blue).toBeGreaterThan(10000);
    expect(result.split.red).toBeLessThan(result.lit.red * 0.65);
    expect(result.blocked.red).toBe(0);
    expect(result.blocked.blue).toBe(0);
    expect(result.stackBlocked.red).toBe(0);
    expect(result.stackBlocked.blue).toBe(0);
    expect(result.complementary.red + result.complementary.blue).toBeLessThan(
      (result.half.red + result.half.blue) * 0.1,
    );
    await testInfo.attach("surface-complementary-gobos.png", {
      body: Buffer.from(result.complementary.image.split(",")[1], "base64"),
      contentType: "image/png",
    });
    expect(result.half.red).toBeGreaterThan(10000);
    expect(result.half.red).toBeGreaterThan(result.half.blue * 4);
    expect(result.defocused.blue).toBeGreaterThan(result.half.blue * 1.5);
    expect(result.rotated.blue).toBeGreaterThan(10000);
    expect(result.rotated.blue).toBeGreaterThan(result.rotated.red * 4);
    expect(result.reindexed.red).toBeGreaterThan(result.reindexed.blue * 4);
    expect(result.reindexed.red / result.half.red).toBeCloseTo(1, 3);
    await testInfo.attach("surface-half-gobo.png", {
      body: Buffer.from(result.half.image.split(",")[1], "base64"),
      contentType: "image/png",
    });
    await testInfo.attach("surface-split-color.png", {
      body: Buffer.from(result.split.image.split(",")[1], "base64"),
      contentType: "image/png",
    });
    await testInfo.attach("surface-defocused-gobo.png", {
      body: Buffer.from(result.defocused.image.split(",")[1], "base64"),
      contentType: "image/png",
    });
    expect(result.away.red).toBe(0);
    expect(result.away.blue).toBe(0);
  });
}
