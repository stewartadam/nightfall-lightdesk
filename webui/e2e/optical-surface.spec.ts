// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { PhysicalUnit } from "../types";
import {
  backendLabel,
  evaluateOnBackend,
  expectWithArtifacts,
  openOpticsFixture,
} from "./optics-harness";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/**
 * Relative tolerance for pixel-sum ratios that should be unchanged by a setting that must
 * not affect the optical profile. 8-bit output quantization and driver rounding move sums
 * by well under 0.5%, while the regressions these checks guard against (a clipped footprint
 * or a mis-indexed gobo) change them by tens of percent.
 */
const UNCHANGED_RATIO_TOLERANCE = 0.01;

for (const forceWebGL of [false, true]) {
  const backend = backendLabel(forceWebGL);

  /**
   * Crowded clusters must retain both late sources and the energy of genuinely overlapping
   * beams through the bounded full-cluster fallback.
   */
  test(`crowded optical clusters preserve all contributing sources (${backend})`, async ({
    page,
  }, testInfo) => {
    const errors = await openOpticsFixture(page);
    const result = await evaluateOnBackend(
      page,
      async (forceWebGL) => {
        const THREE = await import("/e2e/fixtures/three-api.ts");
        const { OpticalSurfaceLight, OpticalSurfaceLighting } = await import(
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
        /** Measures the illuminated surface's blue energy after the configuration reaches the GPU. */
        const capture = async (retain?: string) => {
          const { blue } = await renderAndSum(renderer, () =>
            renderer.render(scene, camera),
          );
          if (retain) retainCanvas(retain, renderer.domElement);
          return blue;
        };
        try {
          const crowded = await capture("crowded-clusters");
          for (let i = 0; i < 99; i++) lights[i].visible = false;
          const reference = await capture();
          for (const light of lights) {
            light.visible = true;
            light.apertureForward.set(0, 0, -1);
            light.intensity = 0.001;
          }
          const overlap = await capture("overlap");
          return { crowded, reference, overlap };
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
      { page, artifacts: { "crowded-clusters.json": result } },
      () => {
        expect(errors).toEqual([]);
        expect(result.reference).toBeGreaterThan(10000);
        expect(Math.abs(result.crowded / result.reference - 1)).toBeLessThan(
          0.02,
        );
        expect(Math.abs(result.overlap / result.reference - 1)).toBeLessThan(
          0.02,
        );
      },
    );
  });

  /** Clustered sources illuminate real geometry only inside their optical projection. */
  test(`clustered aperture lights shade surfaces and respect direction (${backend})`, async ({
    page,
  }, testInfo) => {
    const errors = await openOpticsFixture(page);
    const result = await evaluateOnBackend(
      page,
      async (forceWebGL) => {
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
        const {
          createTestRenderer,
          maskUrl,
          renderAndSum,
          retainCanvas,
          waitForGoboSlots,
        } = await import("/e2e/fixtures/optics-harness.ts");
        const { renderer } = await createTestRenderer({
          forceWebGL,
          width: 640,
          height: 480,
        });
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0);
        const camera = new THREE.PerspectiveCamera(45, 640 / 480, 0.1, 100);
        camera.position.z = 4;
        const pipeline = createPostProcessing(renderer, scene, camera);
        const goboAtlas = pipeline.surfaceLighting.goboAtlas!;
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
        /** Reads channel sums after real GPU submissions, retaining the frame for failure diagnostics. */
        const capture = async (retain?: string) => {
          const { red, blue } = await renderAndSum(renderer, () =>
            pipeline.postProcessing.render(),
          );
          if (retain) retainCanvas(retain, renderer.domElement);
          return { red, blue };
        };
        try {
          const lit = await capture("surface-light");
          pipeline.scenePass.setResolutionScale(0.5);
          const reducedResolution = await capture("surface-half-resolution");
          pipeline.scenePass.setResolutionScale(1);
          red.intensity = 0.02;
          const wideBounds = await capture();
          red.distance = 4.5;
          const tightBounds = await capture();
          red.distance = 40;
          red.intensity = 0.1;
          red.secondaryColor.setRGB(0, 0, 1);
          red.splitColor = true;
          const split = await capture("surface-split-color");
          const mask = goboAtlas.load(maskUrl("black", undefined, 256));
          const halfMask = goboAtlas.load(
            maskUrl(
              "black",
              (context) => {
                context.fillStyle = "white";
                context.fillRect(0, 0, 128, 256);
              },
              256,
            ),
          );
          await waitForGoboSlots([mask, halfMask]);
          red.goboSlot = mask.index;
          const blocked = await capture();
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
                GoboRot: number;
              }
          >([
            ["Base", modeValues],
            ["Head", { red: 1, green: 1, blue: 1, intensity: 1, GoboRot: 1 }],
          ]);
          opticalState.update(opticalValues, 0);
          red.goboSlot = halfMask.index;
          red.goboRotation = opticalState.gobos[0].rotation;
          const half = await capture("surface-half-gobo");
          red.focusDistance = 0.2;
          const defocused = await capture("surface-defocused-gobo");
          red.focusDistance = 0;
          modeValues.Control = 1;
          opticalState.update(opticalValues, 1);
          red.goboRotation = opticalState.gobos[0].rotation;
          const rotated = await capture();
          modeValues.Control = 0;
          opticalState.update(opticalValues, 2);
          red.goboRotation = opticalState.gobos[0].rotation;
          const reindexed = await capture();
          red.goboSlot = goboAtlas.stacks.update("surface", [
            { slot: mask.index, rotation: 0 },
            { slot: halfMask.index, rotation: 0 },
          ]);
          const stackBlocked = await capture();
          red.goboSlot = goboAtlas.stacks.update("surface", [
            { slot: halfMask.index, rotation: 0 },
            { slot: halfMask.index, rotation: Math.PI },
          ]);
          const complementary = await capture("surface-complementary-gobos");
          red.goboSlot = 0;
          red.apertureForward.set(0, 0, 1);
          const away = await capture();
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
        } finally {
          disposePostProcessing(pipeline);
          wall.geometry.dispose();
          wall.material.dispose();
          renderer.dispose();
        }
      },
      forceWebGL,
    );
    await expectWithArtifacts(
      testInfo,
      { page, artifacts: { "surface-pixels.json": result } },
      () => {
        expect(errors).toEqual([]);
        expect(result.lit.red).toBeGreaterThan(10000);
        expect(result.lit.blue).toBe(0);
        expect(result.reducedResolution.red / result.lit.red).toBeGreaterThan(
          0.9,
        );
        expect(result.reducedResolution.red / result.lit.red).toBeLessThan(1.1);
        expect(result.reducedResolution.blue).toBe(0);
        // Both spheres contain the wall footprint; only the optical profile sets its brightness.
        expect(result.wideBounds.red).toBeGreaterThan(10000);
        expect(
          Math.abs(result.tightBounds.red / result.wideBounds.red - 1),
        ).toBeLessThan(UNCHANGED_RATIO_TOLERANCE);
        expect(result.split.red).toBeGreaterThan(10000);
        expect(result.split.blue).toBeGreaterThan(10000);
        expect(result.split.red).toBeLessThan(result.lit.red * 0.65);
        expect(result.blocked.red).toBe(0);
        expect(result.blocked.blue).toBe(0);
        expect(result.stackBlocked.red).toBe(0);
        expect(result.stackBlocked.blue).toBe(0);
        expect(
          result.complementary.red + result.complementary.blue,
        ).toBeLessThan((result.half.red + result.half.blue) * 0.1);
        expect(result.half.red).toBeGreaterThan(10000);
        expect(result.half.red).toBeGreaterThan(result.half.blue * 4);
        expect(result.defocused.blue).toBeGreaterThan(result.half.blue * 1.5);
        expect(result.rotated.blue).toBeGreaterThan(10000);
        expect(result.rotated.blue).toBeGreaterThan(result.rotated.red * 4);
        expect(result.reindexed.red).toBeGreaterThan(result.reindexed.blue * 4);
        // Re-selecting the index mode must restore the original orientation exactly.
        expect(
          Math.abs(result.reindexed.red / result.half.red - 1),
        ).toBeLessThan(UNCHANGED_RATIO_TOLERANCE);
        expect(result.away.red).toBe(0);
        expect(result.away.blue).toBe(0);
      },
    );
  });

  /** An all-zero aperture record, like an unwritten texture placeholder, must add no light rather than flood surfaces. */
  test(`degenerate aperture records light nothing (${backend})`, async ({
    page,
  }, testInfo) => {
    const errors = await openOpticsFixture(page);
    const energy = await evaluateOnBackend(
      page,
      async (forceWebGL) => {
        const THREE = await import("/e2e/fixtures/three-api.ts");
        const { OpticalSurfaceLight, OpticalSurfaceLighting } = await import(
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
        const light = new OpticalSurfaceLight({
          shape: "round",
          radius: 0,
          slopeX: 0,
          slopeY: 0,
          halfPowerRatio: 0.5,
          distributionPower: 0,
          lumens: 0,
        });
        light.apertureRight.set(0, 0, 0);
        light.apertureUp.set(0, 0, 0);
        light.apertureForward.set(0, 0, 0);
        light.beamLength = 0;
        light.intensity = 1;
        light.position.z = -2;
        scene.add(light);
        try {
          const sums = await renderAndSum(renderer, () =>
            renderer.render(scene, camera),
          );
          retainCanvas("degenerate-aperture", renderer.domElement);
          return sums.red + sums.green + sums.blue;
        } finally {
          lighting.dispose();
          wall.geometry.dispose();
          wall.material.dispose();
          renderer.dispose();
        }
      },
      forceWebGL,
    );
    await expectWithArtifacts(testInfo, { page }, () => {
      expect(errors).toEqual([]);
      expect(energy).toBe(0);
    });
  });
}
