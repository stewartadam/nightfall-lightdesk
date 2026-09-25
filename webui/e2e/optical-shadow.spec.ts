// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

for (const forceWebGL of [false, true]) {
  /** A bounded projector map must block receiving light and release stale or removed sources on either backend. */
  test(`optical shadow maps project occluders and expire without refresh (${forceWebGL ? "WebGL" : "WebGPU"})`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.route("**/__optical-shadow__", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<canvas></canvas>",
      }),
    );
    await page.goto("/__optical-shadow__");
    const result = await page.evaluate(async (forceWebGL) => {
      const T = await import("/e2e/fixtures/three-api.ts");
      const { OpticalSurfaceLight, OpticalSurfaceLighting } = await import(
        "/features/visualizer/rendering/effects/optical-surface-lighting.ts"
      );
      const renderer = new T.WebGPURenderer({
        canvas: document.querySelector("canvas")!,
        forceWebGL,
      });
      renderer.setSize(320, 320);
      await renderer.init();
      const lighting = new OpticalSurfaceLighting();
      renderer.lighting = lighting;
      const pool = lighting.shadows;
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
      const visibility = pool.sample(T.positionWorld, T.float(source.id));
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
      const refreshes = pool.update(renderer, scene, camera, 0, true);
      blocker.visible = false;
      /** Waits for GPU submission before copying the receiver image and sampling its expected shadow. */
      const capture = async () => {
        await new Promise<void>((resolve) => {
          let frames = 0;
          renderer.setAnimationLoop(() => {
            renderer.render(scene, camera);
            if (++frames === 3) {
              renderer.setAnimationLoop(null);
              resolve();
            }
          });
        });
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 320;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(renderer.domElement, 0, 0);
        const pixels = ctx.getImageData(0, 0, 320, 320).data;
        /** Averages a small patch to avoid sampling raster boundaries. */
        const patch = (x: number, y: number) => {
          let total = 0;
          for (let dy = -3; dy <= 3; dy++)
            for (let dx = -3; dx <= 3; dx++)
              total += pixels[((y + dy) * 320 + x + dx) * 4];
          return total / 49;
        };
        return {
          shadow: patch(202, 118),
          clear: patch(118, 202),
          energy: pixels.reduce(
            (sum, value, index) => sum + (index % 4 === 0 ? value : 0),
            0,
          ),
          image: canvas.toDataURL(),
        };
      };
      const blocked = await capture();
      source.position.x = 1;
      pool.update(renderer, scene, camera, 1, false);
      const moved = await capture();
      source.position.x = 0;
      blocker.visible = true;
      pool.update(renderer, scene, camera, 2, true);
      blocker.visible = false;
      const denied = pool.update(renderer, scene, camera, 300, false);
      const expired = await capture();
      blocker.visible = true;
      pool.update(renderer, scene, camera, 301, true);
      blocker.visible = false;
      pool.unregister(source);
      const removed = await capture();
      const { createEmitterVolumeMaterial } = await import(
        "/features/visualizer/rendering/effects/emitter-volume-material.ts"
      );
      const volume = createEmitterVolumeMaterial({ shadows: pool });
      volume.optics.value.set(0.15, 0.15, 0.01, 4);
      volume.radiance.value.set(10, 10, 10);
      volume.beamLength.value = 8;
      volume.sourceId.value = source.id;
      const beam = new T.Mesh(new T.BoxGeometry(5, 5, 8), volume.material);
      beam.position.z = -4;
      scene.remove(wall);
      scene.add(beam);
      camera.position.set(5, 0, 1);
      camera.lookAt(0, 0, -4);
      pool.register(source);
      pool.update(renderer, scene, camera, 302, true);
      const clearFog = await capture();
      blocker.position.set(0, 0, -2);
      blocker.scale.set(20, 20, 1);
      blocker.visible = true;
      pool.update(renderer, scene, camera, 303, true);
      blocker.visible = false;
      const blockedFog = await capture();
      beam.geometry.dispose();
      volume.material.dispose();
      lighting.dispose();
      wall.geometry.dispose();
      material.dispose();
      blocker.geometry.dispose();
      blocker.material.dispose();
      renderer.dispose();
      return {
        refreshes,
        denied,
        blocked,
        moved,
        expired,
        removed,
        clearFog,
        blockedFog,
      };
    }, forceWebGL);
    await testInfo.attach("projected-shadow.png", {
      body: Buffer.from(result.blocked.image.split(",")[1], "base64"),
      contentType: "image/png",
    });
    expect(errors).toEqual([]);
    expect(result.refreshes).toBe(1);
    expect(result.denied).toBe(0);
    expect(result.blocked.shadow).toBeLessThan(20);
    expect(result.blocked.clear).toBeGreaterThan(230);
    expect(result.expired.shadow).toBeGreaterThan(230);
    expect(result.moved.shadow).toBeGreaterThan(230);
    expect(result.removed.shadow).toBeGreaterThan(230);
    expect(result.clearFog.energy).toBeGreaterThan(1000);
    expect(result.blockedFog.energy).toBeLessThan(result.clearFog.energy * 0.8);
    await testInfo.attach("fog-light-occlusion.png", {
      body: Buffer.from(result.blockedFog.image.split(",")[1], "base64"),
      contentType: "image/png",
    });
  });
}
