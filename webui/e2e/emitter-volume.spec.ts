// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { PhysicalUnit } from "../types";
import {
  annotateBackend,
  backendLabel,
  evaluateOnBackend,
  expectWithArtifacts,
  openOpticsFixture,
} from "./optics-harness";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Decodes owned PNG masks and verifies atlas growth preserves existing patterns and shared slots. */
test("gobo atlas decodes and grows without losing masks", async ({ page }) => {
  const errors = await openOpticsFixture(page);
  const result = await page.evaluate(async () => {
    const { GoboAtlas } = await import(
      "/features/visualizer/rendering/effects/gobo-atlas.ts"
    );
    const { maskUrl, waitForGoboSlots } = await import(
      "/e2e/fixtures/optics-harness.ts"
    );
    const url = maskUrl("black", (context) => {
      context.fillStyle = "white";
      context.fillRect(0, 0, 16, 32);
    });
    const atlas = new GoboAtlas();
    try {
      const first = atlas.load(url);
      const shared = atlas.load(url) === first;
      const slots = [
        first,
        ...Array.from({ length: 16 }, (_, i) => atlas.load(`${url}#${i}`)),
      ];
      await waitForGoboSlots(slots);
      const image = atlas.texture.image;
      const stride = atlas.tilesPerRow;
      const samples = slots.map((slot) => {
        const x = (slot.index % stride) * 256;
        const y = Math.floor(slot.index / stride) * 256 + 128;
        return [
          image.data![y * image.width + x + 64],
          image.data![y * image.width + x + 192],
        ];
      });
      return { shared, width: image.width, samples };
    } finally {
      atlas.dispose();
    }
  });
  expect(errors).toEqual([]);
  expect(result.shared).toBe(true);
  expect(result.width).toBe(2048);
  expect(
    result.samples.every(([white, black]) => white === 255 && black === 0),
  ).toBe(true);
});

for (const forceWebGL of [false, true]) {
  const backend = backendLabel(forceWebGL);

  /** Grows the instance buffer to 300 emitters in one draw, then swaps, clears and re-adds sources live. */
  test(`batched emitters grow, update live and black out (${backend})`, async ({
    page,
  }, testInfo) => {
    const errors = await openOpticsFixture(page);
    const result = await evaluateOnBackend(
      page,
      async (forceWebGL) => {
        const { createBatchScene, BATCH_OPTICS, BATCH_RED } = await import(
          "/e2e/fixtures/emitter-batch-scene.ts"
        );
        const s = await createBatchScene(forceWebGL);
        try {
          const blue = { red: 0, green: 0, blue: 1, intensity: 0.1 };
          for (let i = 0; i < 300; i++) {
            s.parent.position.x = ((i % 60) - 29.5) * 0.025;
            s.batch.update(`fixture:${i}`, s.parent, {
              optics: BATCH_OPTICS,
              color: blue,
            });
          }
          const lit = await s.capture("instanced");
          const draws = s.context.scene.children.length;
          for (let i = 0; i < 300; i++) s.batch.remove(`fixture:${i}`);
          s.parent.position.x = 0;
          s.batch.update("fixture:red", s.parent, {
            optics: BATCH_OPTICS,
            color: BATCH_RED,
          });
          const updated = await s.capture("updated");
          s.batch.clear();
          const blackout = await s.capture();
          s.batch.update("fixture:red", s.parent, {
            optics: BATCH_OPTICS,
            color: BATCH_RED,
          });
          const relit = await s.capture();
          return { draws, lit, updated, blackout, relit };
        } finally {
          s.dispose();
        }
      },
      forceWebGL,
    );
    await expectWithArtifacts(
      testInfo,
      { page, artifacts: { "batch-pixels.json": result } },
      () => {
        expect(errors).toEqual([]);
        expect(result.draws).toBe(1);
        expect(result.lit.blue).toBeGreaterThan(10000);
        expect(result.updated.red).toBeGreaterThan(10000);
        expect(result.updated.blue).toBe(0);
        expect(result.blackout.red).toBe(0);
        expect(result.relit.red).toBeGreaterThan(10000);
      },
    );
  });

  /** Split colors and single or stacked prism wheels expand one emitter into the expected facet instances. */
  test(`batched emitters split colors and prism facets (${backend})`, async ({
    page,
  }, testInfo) => {
    const errors = await openOpticsFixture(page);
    const result = await evaluateOnBackend(
      page,
      async (forceWebGL) => {
        const { createBatchScene, BATCH_OPTICS, BATCH_RED } = await import(
          "/e2e/fixtures/emitter-batch-scene.ts"
        );
        const { compilePrismFacet } = await import(
          "/features/visualizer/rendering/effects/prism-optics.ts"
        );
        const { EmitterOpticalState } = await import(
          "/features/visualizer/rendering/effects/emitter-optical-state.ts"
        );
        const THREE = await import("/e2e/fixtures/three-api.ts");
        const s = await createBatchScene(forceWebGL);
        /** Returns the instance count of the batch's single instanced draw. */
        const instances = () =>
          (
            s.context.scene.children[0] as InstanceType<
              typeof THREE.InstancedMesh
            >
          ).count;
        try {
          s.batch.update("fixture:red", s.parent, {
            optics: BATCH_OPTICS,
            color: BATCH_RED,
          });
          const single = await s.capture();
          s.batch.update("fixture:red", s.parent, {
            optics: BATCH_OPTICS,
            color: {
              ...BATCH_RED,
              secondaryRed: 0,
              secondaryGreen: 0,
              secondaryBlue: 1,
            },
          });
          const splitColor = await s.capture("split-color");
          const facets = [-6, 0, 6].map(
            (x) =>
              compilePrismFacet({
                transform: [1, 0, 0, 0, 1, 0, x, 0, 1],
                colorCie: [0.3127, 0.329, 100],
              })!,
          );
          s.batch.update("fixture:red", s.parent, {
            optics: BATCH_OPTICS,
            color: BATCH_RED,
            facets,
          });
          const prism = await s.capture("prism");
          const prismCount = instances();
          const stackState = new EmitterOpticalState(
            {
              mesh: new THREE.Mesh(),
              controlledElement: "Head",
              opticalWheels: [2, 3].map((count, index) => ({
                name: `Wheel${index}`,
                slots: [
                  {
                    facets: Array.from({ length: count }, (_, i) => ({
                      transform: [
                        1,
                        0,
                        0,
                        0,
                        1,
                        0,
                        index === 0 ? (i - 0.5) * 6 : 0,
                        index === 1 ? (i - 1) * 6 : 0,
                        1,
                      ],
                      colorCie: [0.3127, 0.329, 100],
                    })),
                  },
                ],
              })),
              opticalChannels: [0, 1].map((i) => ({
                geometry: "Head",
                attribute: `Prism${i + 1}`,
                parameterKey: `Prism${i + 1}`,
                dmxMax: 255,
                functions: [
                  {
                    attribute: `Prism${i + 1}`,
                    physicalUnit: "None" as PhysicalUnit,
                    profile: { type: "Linear" as const },
                    modeMaster: { type: "None" as const },
                    wheel: `Wheel${i}`,
                    dmxFrom: 0,
                    dmxTo: 255,
                    physicalFrom: 0,
                    physicalTo: 1,
                    sets: [
                      {
                        dmxFrom: 0,
                        dmxTo: 255,
                        physicalFrom: 0,
                        physicalTo: 1,
                        wheelSlot: 1,
                      },
                    ],
                  },
                ],
              })),
            },
            () => {
              throw new Error("Prisms must not request images");
            },
          );
          stackState.update(
            new Map([
              [
                "Head",
                {
                  red: 1,
                  green: 0,
                  blue: 0,
                  intensity: 10,
                  Prism1: 1,
                  Prism2: 1,
                },
              ],
            ]),
          );
          s.batch.reserve("fixture:red", stackState.maxFacetCount);
          s.batch.update("fixture:red", s.parent, {
            optics: BATCH_OPTICS,
            color: BATCH_RED,
            facets: stackState.prism,
            prismRotation: stackState.prismRotation,
          });
          const stacked = await s.capture("stacked-prism");
          const stackedCount = instances();
          return {
            single,
            splitColor,
            prism,
            prismCount,
            stacked,
            stackedCount,
          };
        } finally {
          s.dispose();
        }
      },
      forceWebGL,
    );
    await expectWithArtifacts(
      testInfo,
      { page, artifacts: { "prism-pixels.json": result } },
      () => {
        expect(errors).toEqual([]);
        expect(result.splitColor.red).toBeGreaterThan(1000);
        expect(result.splitColor.blue).toBeGreaterThan(1000);
        expect(result.prismCount).toBe(3);
        expect(result.prism.red).toBeGreaterThan(10000);
        expect(result.prism.red).not.toBe(result.single.red);
        expect(result.stackedCount).toBe(6);
        expect(result.stacked.red).toBeGreaterThan(1000);
        expect(result.stacked.red).not.toBe(result.prism.red);
      },
    );
  });

  /** Opaque, stacked and crossed gobo masks attenuate the volume by the product of their transmission. */
  test(`batched emitters apply gobo masks (${backend})`, async ({
    page,
  }, testInfo) => {
    const errors = await openOpticsFixture(page);
    const result = await evaluateOnBackend(
      page,
      async (forceWebGL) => {
        const { createBatchScene, BATCH_OPTICS, BATCH_RED } = await import(
          "/e2e/fixtures/emitter-batch-scene.ts"
        );
        const { maskUrl, waitForGoboSlots } = await import(
          "/e2e/fixtures/optics-harness.ts"
        );
        const s = await createBatchScene(forceWebGL);
        try {
          const atlas = s.batch.goboAtlas!;
          const blocked = atlas.load(maskUrl("black"));
          const stripes = atlas.load(
            maskUrl("black", (context) => {
              context.fillStyle = "white";
              for (let x = 0; x < 32; x += 4) context.fillRect(x, 0, 2, 32);
            }),
          );
          await waitForGoboSlots([blocked, stripes]);
          /** Renders the red emitter through the given gobo stack. */
          const withGobos = (
            gobos: { slot: number; rotation: number }[],
            retain?: string,
          ) => {
            s.batch.update("fixture:red", s.parent, {
              optics: BATCH_OPTICS,
              color: BATCH_RED,
              gobos,
            });
            return s.capture(retain);
          };
          const goboBlocked = await withGobos([
            { slot: blocked.index, rotation: 0 },
          ]);
          const striped = await withGobos(
            [{ slot: stripes.index, rotation: 0 }],
            "striped",
          );
          const stackedBlocked = await withGobos([
            { slot: blocked.index, rotation: 0 },
            { slot: stripes.index, rotation: Math.PI / 2 },
          ]);
          const crossed = await withGobos(
            [
              { slot: stripes.index, rotation: 0 },
              { slot: stripes.index, rotation: Math.PI / 2 },
            ],
            "crossed",
          );
          return { goboBlocked, striped, stackedBlocked, crossed };
        } finally {
          s.dispose();
        }
      },
      forceWebGL,
    );
    await expectWithArtifacts(
      testInfo,
      { page, artifacts: { "gobo-pixels.json": result } },
      () => {
        expect(errors).toEqual([]);
        expect(result.goboBlocked.red).toBe(0);
        expect(result.stackedBlocked.red).toBe(0);
        expect(result.striped.red).toBeGreaterThan(1000);
        expect(result.crossed.red).toBeGreaterThan(0);
        expect(result.crossed.red).toBeLessThan(result.striped.red);
      },
    );
  });

  /** Defocus and frost both soften a striped gobo's projected edges relative to a sharp focus. */
  test(`batched emitters soften gobos with focus and frost (${backend})`, async ({
    page,
  }, testInfo) => {
    const errors = await openOpticsFixture(page);
    const result = await evaluateOnBackend(
      page,
      async (forceWebGL) => {
        const { createBatchScene, BATCH_OPTICS, BATCH_RED } = await import(
          "/e2e/fixtures/emitter-batch-scene.ts"
        );
        const { maskUrl, waitForGoboSlots } = await import(
          "/e2e/fixtures/optics-harness.ts"
        );
        const s = await createBatchScene(forceWebGL);
        try {
          const stripes = s.batch.goboAtlas!.load(
            maskUrl("black", (context) => {
              context.fillStyle = "white";
              for (let x = 0; x < 32; x += 4) context.fillRect(x, 0, 2, 32);
            }),
          );
          await waitForGoboSlots([stripes]);
          const gobos = [{ slot: stripes.index, rotation: 0 }];
          s.batch.update("fixture:red", s.parent, {
            optics: BATCH_OPTICS,
            color: BATCH_RED,
            gobos,
          });
          const sharp = await s.capture("sharp");
          s.batch.update("fixture:red", s.parent, {
            optics: BATCH_OPTICS,
            color: BATCH_RED,
            gobos,
            focusDistance: 0.1,
          });
          const defocused = await s.capture("defocused");
          s.batch.update("fixture:red", s.parent, {
            optics: BATCH_OPTICS,
            color: { ...BATCH_RED, frost: 1 },
            gobos,
          });
          const frosted = await s.capture("frosted");
          return { sharp, defocused, frosted };
        } finally {
          s.dispose();
        }
      },
      forceWebGL,
    );
    await expectWithArtifacts(
      testInfo,
      { page, artifacts: { "focus-pixels.json": result } },
      () => {
        expect(errors).toEqual([]);
        expect(result.sharp.red).toBeGreaterThan(1000);
        expect(result.defocused.red).toBeGreaterThan(1000);
        expect(result.frosted.red).toBeGreaterThan(1000);
        const sharpness = result.sharp.edgeEnergy / result.sharp.red;
        expect(result.frosted.edgeEnergy / result.frosted.red).toBeLessThan(
          sharpness,
        );
        expect(result.defocused.edgeEnergy / result.defocused.red).toBeLessThan(
          sharpness,
        );
      },
    );
  });

  /** An opaque wall in front of the camera hides the atmosphere through the opaque pass's depth. */
  test(`batched emitters respect opaque depth (${backend})`, async ({
    page,
  }, testInfo) => {
    const errors = await openOpticsFixture(page);
    const result = await evaluateOnBackend(
      page,
      async (forceWebGL) => {
        const { createBatchScene, BATCH_OPTICS, BATCH_RED } = await import(
          "/e2e/fixtures/emitter-batch-scene.ts"
        );
        const THREE = await import("/e2e/fixtures/three-api.ts");
        const s = await createBatchScene(forceWebGL);
        const wall = new THREE.Mesh(
          new THREE.PlaneGeometry(100, 100),
          new THREE.MeshBasicNodeMaterial({ color: 0 }),
        );
        try {
          s.batch.update("fixture:red", s.parent, {
            optics: BATCH_OPTICS,
            color: BATCH_RED,
          });
          const visible = await s.capture();
          wall.position
            .copy(s.camera.position)
            .addScaledVector(
              s.camera.getWorldDirection(new THREE.Vector3()),
              0.5,
            );
          wall.quaternion.copy(s.camera.quaternion);
          s.scene.add(wall);
          const occluded = await s.capture("occluded");
          return { visible, occluded };
        } finally {
          wall.geometry.dispose();
          wall.material.dispose();
          s.dispose();
        }
      },
      forceWebGL,
    );
    await expectWithArtifacts(
      testInfo,
      { page, artifacts: { "occlusion-pixels.json": result } },
      () => {
        expect(errors).toEqual([]);
        expect(result.visible.red).toBeGreaterThan(10000);
        expect(result.occluded.red).toBe(0);
      },
    );
  });
}

/** Compiles the optical integrator on a real device and checks the rectangular distribution reaches the canvas. */
test("resolved rectangular emitter renders a volumetric distribution", async ({
  page,
}, testInfo) => {
  const errors = await openOpticsFixture(page);
  const result = await page.evaluate(async () => {
    const THREE = await import("/e2e/fixtures/three-api.ts");
    const { BeamType } = await import("/types/index.ts");
    const { createUniformEmitterVolume } = await import(
      "/e2e/fixtures/emitter-volume-uniforms.ts"
    );
    const { resolveEmitterOptics } = await import(
      "/features/visualizer/rendering/effects/emitter-optics.ts"
    );
    const { createTestRenderer, readPixels, renderFrames, retainCanvas } =
      await import("/e2e/fixtures/optics-harness.ts");
    const { renderer, backend } = await createTestRenderer({
      forceWebGL: undefined,
      width: 800,
      height: 600,
    });
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.01, 100);
    camera.position.set(4, 2, 4);
    camera.lookAt(0, 0, -8);
    const optics = resolveEmitterOptics({
      radius: 0.02,
      throwRatio: 2,
      rectangleRatio: 8,
      physical: {
        beamType: BeamType.Rectangle,
        beamAngle: 4,
        fieldAngle: 8,
        lumens: 1000,
      },
    })!;
    const volume = createUniformEmitterVolume();
    volume.setOptics(optics);
    volume.radiance.value.set(0.2, 0.7, 1);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      volume.material,
    );
    mesh.position.z = -15;
    mesh.scale.set(
      4 * (optics.radius + 30 * optics.slopeX),
      4 * (optics.radius + 30 * optics.slopeY),
      30,
    );
    scene.add(mesh);
    try {
      await renderer.compileAsync(scene, camera);
      await renderFrames(renderer, 20, () => renderer.render(scene, camera));
      retainCanvas("rectangular-volume", renderer.domElement);
      const pixels = readPixels(renderer.domElement);
      let maxBlue = 0;
      for (let index = 2; index < pixels.length; index += 4)
        maxBlue = Math.max(maxBlue, pixels[index]);
      return {
        backend,
        maxBlue,
        shaders: await renderer.debug.getShaderAsync(scene, camera, mesh),
      };
    } finally {
      mesh.geometry.dispose();
      volume.material.dispose();
      renderer.dispose();
    }
  });
  annotateBackend(testInfo, result.backend);
  await expectWithArtifacts(
    testInfo,
    { page, artifacts: { "volume-shader.json": result.shaders } },
    () => {
      expect(errors).toEqual([]);
      expect(result.maxBlue).toBeGreaterThan(1);
    },
  );
});
