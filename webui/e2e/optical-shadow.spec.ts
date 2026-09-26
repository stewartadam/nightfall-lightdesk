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

for (const forceWebGL of [false, true]) {
  const backend = backendLabel(forceWebGL);

  /** A bounded projector map must block receiving light and release stale or removed sources on either backend. */
  test(`optical shadow maps project occluders and expire without refresh (${backend})`, async ({
    page,
  }, testInfo) => {
    const errors = await openOpticsFixture(page);
    const result = await evaluateOnBackend(
      page,
      async (forceWebGL) => {
        const T = await import("/e2e/fixtures/three-api.ts");
        const { OpticalSurfaceLight, OpticalSurfaceLighting } = await import(
          "/features/visualizer/rendering/effects/optical-surface-lighting.ts"
        );
        const { createUniformEmitterVolume } = await import(
          "/e2e/fixtures/emitter-volume-uniforms.ts"
        );
        const {
          channelSums,
          createTestRenderer,
          readPixels,
          renderFrames,
          retainCanvas,
        } = await import("/e2e/fixtures/optics-harness.ts");
        const { renderer } = await createTestRenderer({
          forceWebGL,
          width: 320,
          height: 320,
        });
        const lighting = new OpticalSurfaceLighting({
          gobos: true,
          shadows: true,
        });
        renderer.lighting = lighting;
        const pool = lighting.shadows!;
        await pool.prepare(renderer);
        const scene = new T.Scene();
        const camera = new T.PerspectiveCamera(60, 1, 0.1, 20);
        const source = new OpticalSurfaceLight({
          shape: "round",
          radius: 0.01,
          slopeX: 0.4,
          slopeY: 0.4,
          halfPowerRatio: 0.5,
          distributionPower: 4,
          lumens: 1000,
        });
        source.beamLength = 8;
        scene.add(source);
        pool.register(source);
        const material = new T.MeshBasicNodeMaterial();
        const visibility = pool.sample(
          T.positionWorld,
          T.float(source.shadowKey),
        );
        material.fragmentNode = T.vec4(visibility, visibility, visibility, 1);
        const wall = new T.Mesh(new T.PlaneGeometry(6, 6), material);
        wall.position.z = -4;
        scene.add(wall);
        const blocker = new T.Mesh(
          new T.BoxGeometry(0.6, 0.6, 0.2),
          new T.MeshStandardNodeMaterial(),
        );
        blocker.position.set(0.3, 0.3, -2);
        scene.add(blocker);
        const volume = createUniformEmitterVolume({ shadows: pool });
        const beam = new T.Mesh(new T.BoxGeometry(5, 5, 8), volume.material);

        /** Waits for GPU submission, then samples the receiver at the expected shadow and a lit patch. */
        const capture = async (retain?: string) => {
          await renderFrames(renderer, 3, () => renderer.render(scene, camera));
          if (retain) retainCanvas(retain, renderer.domElement);
          /** Averages the red channel of a 7×7 patch to avoid sampling raster boundaries. */
          const patch = (x: number, y: number) =>
            channelSums(
              readPixels(renderer.domElement, {
                x: x - 3,
                y: y - 3,
                width: 7,
                height: 7,
              }),
            ).red / 49;
          return {
            shadow: patch(202, 118),
            clear: patch(118, 202),
            energy: channelSums(readPixels(renderer.domElement)).red,
          };
        };

        try {
          // A 60ms cadence with two maps lets a map miss five cycles: it expires after 600ms.
          const interval = 60;
          const refreshes = pool.update(
            renderer,
            scene,
            camera,
            0,
            true,
            interval,
          );
          blocker.visible = false;
          const blocked = await capture("projected-shadow");
          // Moving sources keep sampling their slightly stale map until refreshed.
          source.position.x = 0.05;
          const keptWhileMoving = pool.update(
            renderer,
            scene,
            camera,
            1,
            false,
            interval,
          );
          const moved = await capture();
          source.position.x = 0;
          blocker.visible = true;
          pool.update(renderer, scene, camera, 2, true, interval);
          blocker.visible = false;
          pool.update(renderer, scene, camera, 500, false, interval);
          const aged = await capture();
          const denied = pool.update(
            renderer,
            scene,
            camera,
            603,
            false,
            interval,
          );
          const expired = await capture();
          blocker.visible = true;
          pool.update(renderer, scene, camera, 604, true, interval);
          blocker.visible = false;
          pool.unregister(source);
          const removed = await capture();
          pool.register(source);
          volume.optics.value.set(0.15, 0.15, 0.01, 4);
          volume.radiance.value.set(10, 10, 10);
          volume.beamLength.value = 8;
          volume.sourceId.value = source.shadowKey;
          beam.position.z = -4;
          scene.remove(wall);
          scene.add(beam);
          camera.position.set(5, 0, 1);
          camera.lookAt(0, 0, -4);
          pool.update(renderer, scene, camera, 605, true, interval);
          const clearFog = await capture();
          blocker.position.set(0, 0, -2);
          blocker.scale.set(20, 20, 1);
          blocker.visible = true;
          pool.update(renderer, scene, camera, 606, true, interval);
          blocker.visible = false;
          const blockedFog = await capture("fog-light-occlusion");
          return {
            refreshes,
            denied,
            keptWhileMoving,
            blocked,
            moved,
            aged,
            expired,
            removed,
            clearFog,
            blockedFog,
          };
        } finally {
          beam.geometry.dispose();
          volume.material.dispose();
          lighting.dispose();
          wall.geometry.dispose();
          material.dispose();
          blocker.geometry.dispose();
          blocker.material.dispose();
          renderer.dispose();
        }
      },
      forceWebGL,
    );
    await expectWithArtifacts(
      testInfo,
      { page, artifacts: { "shadow-samples.json": result } },
      () => {
        expect(errors).toEqual([]);
        expect(result.refreshes).toBe(1);
        expect(result.denied).toBe(0);
        expect(result.keptWhileMoving).toBe(0);
        expect(result.blocked.shadow).toBeLessThan(20);
        expect(result.blocked.clear).toBeGreaterThan(230);
        expect(result.moved.shadow).toBeLessThan(20);
        expect(result.aged.shadow).toBeLessThan(20);
        expect(result.expired.shadow).toBeGreaterThan(230);
        expect(result.removed.shadow).toBeGreaterThan(230);
        expect(result.clearFog.energy).toBeGreaterThan(1000);
        expect(result.blockedFog.energy).toBeLessThan(
          result.clearFog.energy * 0.8,
        );
      },
    );
  });

  /**
   * At stage throws the projector's non-linear depth compresses: a light 10m from the floor
   * and an occluder 1.5m above it differ by ~0.0003 in depth-buffer units. The occluder must
   * still cast a shadow, and the receiving surface must not shadow itself.
   */
  test(`optical shadows resolve occluders near a distant receiver (${backend})`, async ({
    page,
  }, testInfo) => {
    const errors = await openOpticsFixture(page);
    const result = await evaluateOnBackend(
      page,
      async (forceWebGL) => {
        const T = await import("/e2e/fixtures/three-api.ts");
        const { OpticalSurfaceLight, OpticalSurfaceLighting } = await import(
          "/features/visualizer/rendering/effects/optical-surface-lighting.ts"
        );
        const {
          channelSums,
          createTestRenderer,
          readPixels,
          renderFrames,
          retainCanvas,
        } = await import("/e2e/fixtures/optics-harness.ts");
        const { renderer } = await createTestRenderer({
          forceWebGL,
          width: 320,
          height: 320,
        });
        const lighting = new OpticalSurfaceLighting({
          gobos: false,
          shadows: true,
        });
        renderer.lighting = lighting;
        const pool = lighting.shadows!;
        await pool.prepare(renderer);
        const scene = new T.Scene();
        // Look along the beam from the fixture so the receiver fills the frame.
        const camera = new T.PerspectiveCamera(40, 1, 0.1, 30);
        const source = new OpticalSurfaceLight({
          shape: "round",
          radius: 0.01,
          slopeX: 0.1,
          slopeY: 0.1,
          halfPowerRatio: 0.5,
          distributionPower: 4,
          lumens: 1000,
        });
        source.beamLength = 12;
        scene.add(source);
        pool.register(source);
        const material = new T.MeshBasicNodeMaterial();
        const visibility = pool.sample(
          T.positionWorld,
          T.float(source.shadowKey),
        );
        material.fragmentNode = T.vec4(visibility, visibility, visibility, 1);
        const floor = new T.Mesh(new T.PlaneGeometry(12, 12), material);
        floor.position.z = -10;
        scene.add(floor);
        const blocker = new T.Mesh(
          new T.BoxGeometry(1, 1, 0.2),
          new T.MeshStandardNodeMaterial(),
        );
        blocker.position.set(0.6, 0.6, -8.5);
        scene.add(blocker);

        /** Averages the red channel of a 7×7 patch centred on a pixel. */
        const patch = (x: number, y: number) =>
          channelSums(
            readPixels(renderer.domElement, {
              x: x - 3,
              y: y - 3,
              width: 7,
              height: 7,
            }),
          ).red / 49;

        try {
          const refreshes = pool.update(renderer, scene, camera, 0, true, 60);
          blocker.visible = false;
          await renderFrames(renderer, 3, () => renderer.render(scene, camera));
          retainCanvas("stage-throw-shadow", renderer.domElement);
          // The blocker's shadow centres near (0.7, 0.7) on the floor; the clear patch mirrors it.
          return {
            refreshes,
            shadow: patch(191, 129),
            clear: patch(129, 191),
          };
        } finally {
          lighting.dispose();
          floor.geometry.dispose();
          material.dispose();
          blocker.geometry.dispose();
          blocker.material.dispose();
          renderer.dispose();
        }
      },
      forceWebGL,
    );
    await expectWithArtifacts(
      testInfo,
      { page, artifacts: { "stage-throw-shadow.json": result } },
      () => {
        expect(errors).toEqual([]);
        expect(result.refreshes).toBe(1);
        expect(result.shadow).toBeLessThan(20);
        expect(result.clear).toBeGreaterThan(230);
      },
    );
  });

  /**
   * Drives the real refresh budget without GPU timestamps (as on WebGL or browsers without
   * timestamp queries) for several seconds while the source drifts, and verifies the shadow
   * appears promptly and never flickers off.
   */
  test(`optical shadows stay visible over time without GPU timing (${backend})`, async ({
    page,
  }, testInfo) => {
    const errors = await openOpticsFixture(page);
    const result = await evaluateOnBackend(
      page,
      async (forceWebGL) => {
        const T = await import("/e2e/fixtures/three-api.ts");
        const { OpticalSurfaceLight, OpticalSurfaceLighting } = await import(
          "/features/visualizer/rendering/effects/optical-surface-lighting.ts"
        );
        const { GpuBudget } = await import(
          "/features/visualizer/rendering/effects/gpu-budget.ts"
        );
        const { channelSums, createTestRenderer, readPixels, retainCanvas } =
          await import("/e2e/fixtures/optics-harness.ts");
        const { renderer } = await createTestRenderer({
          forceWebGL,
          width: 320,
          height: 320,
        });
        const lighting = new OpticalSurfaceLighting({
          gobos: true,
          shadows: true,
        });
        renderer.lighting = lighting;
        const pool = lighting.shadows!;
        await pool.prepare(renderer);
        const scene = new T.Scene();
        const camera = new T.PerspectiveCamera(60, 1, 0.1, 20);
        const source = new OpticalSurfaceLight({
          shape: "round",
          radius: 0.01,
          slopeX: 0.4,
          slopeY: 0.4,
          halfPowerRatio: 0.5,
          distributionPower: 4,
          lumens: 1000,
        });
        source.beamLength = 8;
        scene.add(source);
        pool.register(source);
        const material = new T.MeshBasicNodeMaterial();
        const visibility = pool.sample(
          T.positionWorld,
          T.float(source.shadowKey),
        );
        material.fragmentNode = T.vec4(visibility, visibility, visibility, 1);
        const wall = new T.Mesh(new T.PlaneGeometry(6, 6), material);
        wall.position.z = -4;
        scene.add(wall);
        const blocker = new T.Mesh(
          new T.BoxGeometry(0.6, 0.6, 0.2),
          new T.MeshStandardNodeMaterial(),
        );
        blocker.position.set(0.3, 0.3, -2);
        blocker.visible = false;
        scene.add(blocker);
        const budget = new GpuBudget();
        /** Averages the red channel of a small patch at the expected shadow. */
        const shadowPatch = () =>
          channelSums(
            readPixels(renderer.domElement, {
              x: 199,
              y: 115,
              width: 7,
              height: 7,
            }),
          ).red / 49;
        const started = performance.now();
        let firstValid: number | undefined;
        let lapses = 0;
        let refreshes = 0;
        const patches: number[] = [];
        try {
          await new Promise<void>((resolve, reject) => {
            renderer.setAnimationLoop(() => {
              try {
                const now = performance.now();
                const elapsed = now - started;
                // A slowly drifting source exercises the moving-source path.
                source.position.x = 0.02 * Math.sin(elapsed / 300);
                budget.observe(undefined, now);
                const allow = budget.canRefreshShadows(0, now);
                blocker.visible = true;
                refreshes += pool.update(
                  renderer,
                  scene,
                  camera,
                  now,
                  allow,
                  budget.shadowRefreshIntervalMs,
                );
                blocker.visible = false;
                renderer.render(scene, camera);
                budget.recordRender(performance.now() - now, 0);
                if (pool.hasValidMap(source)) firstValid ??= elapsed;
                else if (firstValid !== undefined) lapses++;
                if (firstValid !== undefined && elapsed > 1000) {
                  patches.push(shadowPatch());
                  if (patches.length === 1)
                    retainCanvas("shadow-over-time", renderer.domElement);
                }
                if (elapsed > 3000) {
                  renderer.setAnimationLoop(null);
                  resolve();
                }
              } catch (error) {
                renderer.setAnimationLoop(null);
                reject(error);
              }
            });
          });
          return {
            firstValid,
            lapses,
            refreshes,
            brightestPatch: Math.max(...patches),
            patchCount: patches.length,
          };
        } finally {
          lighting.dispose();
          wall.geometry.dispose();
          material.dispose();
          blocker.geometry.dispose();
          blocker.material.dispose();
          renderer.dispose();
        }
      },
      forceWebGL,
    );
    await expectWithArtifacts(
      testInfo,
      { page, artifacts: { "shadow-over-time.json": result } },
      () => {
        expect(errors).toEqual([]);
        expect(result.firstValid).toBeLessThan(1000);
        expect(result.lapses).toBe(0);
        expect(result.refreshes).toBeGreaterThan(3);
        expect(result.patchCount).toBeGreaterThan(10);
        expect(result.brightestPatch).toBeLessThan(20);
      },
    );
  });
}
