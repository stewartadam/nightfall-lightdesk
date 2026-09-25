// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  backendLabel,
  evaluateOnBackend,
  openOpticsFixture,
} from "./optics-harness";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

for (const forceWebGL of [false, true]) {
  /** Grows the gobo atlas and stack table after their first GPU upload and verifies the renderer samples the new rows and tiles. */
  test(`gobo storage grows after first upload (${backendLabel(forceWebGL)})`, async ({
    page,
  }) => {
    const errors = await openOpticsFixture(page);
    const result = await evaluateOnBackend(
      page,
      async (forceWebGL) => {
        const THREE = await import("/e2e/fixtures/three-api.ts");
        const { GoboAtlas } = await import(
          "/features/visualizer/rendering/effects/gobo-atlas.ts"
        );
        const {
          createTestRenderer,
          maskUrl,
          readPixels,
          renderFrames,
          waitForGoboSlots,
        } = await import("/e2e/fixtures/optics-harness.ts");
        const { renderer } = await createTestRenderer({
          forceWebGL,
          width: 64,
          height: 32,
        });
        const scene = new THREE.Scene();
        const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const atlas = new GoboAtlas();
        const tile = THREE.uniform(0);
        const stride = THREE.uniform(atlas.tilesPerRow);
        const row = THREE.uniform(0);
        // Left half of the canvas samples one atlas tile; right half reads one stack texel.
        const tileUv = THREE.vec2(
          tile.mod(stride).add(THREE.screenUV.x.mul(2)),
          tile.div(stride).floor().add(THREE.screenUV.y),
        ).div(stride);
        const mask = THREE.texture(atlas.texture, tileUv).level(
          THREE.float(0),
        ).r;
        const stack = THREE.textureLoad(
          atlas.stacks.texture,
          THREE.ivec2(1, row.toInt()),
        );
        const material = new THREE.MeshBasicNodeMaterial();
        material.colorNode = THREE.screenUV.x
          .lessThan(0.5)
          .select(
            THREE.vec4(mask, mask, mask, 1),
            THREE.vec4(stack.x.div(10), stack.y, 0, 1),
          );
        scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

        /** Renders one frame and returns the RGB of the left-quarter and right-quarter centers. */
        const sample = async () => {
          await renderFrames(renderer, 1, () => renderer.render(scene, camera));
          /** Reads one pixel on the middle row. */
          const pick = (x: number) =>
            Array.from(
              readPixels(renderer.domElement, {
                x,
                y: 16,
                width: 1,
                height: 1,
              }).slice(0, 3),
            );
          return { left: pick(8), leftDark: pick(24), right: pick(48) };
        };

        try {
          // First upload at the initial sizes: open tile 0 and an empty stack row.
          atlas.stacks.update("first", [{ slot: 3, rotation: 0.25 }]);
          const before = await sample();

          // Grow the stack table past its initial 256 rows and fill a new row.
          for (let i = 0; i < 300; i++) atlas.stacks.reserve(`fixture${i}`);
          const stackRow =
            -atlas.stacks.update("fixture299", [{ slot: 7, rotation: 0.5 }]) -
            1;
          row.value = stackRow;

          // Grow the atlas past its initial 16 tiles; the last tile's left half is opaque.
          const url = maskUrl("black", (context) => {
            context.fillStyle = "white";
            context.fillRect(0, 0, 16, 32);
          });
          const slots = Array.from({ length: 16 }, (_, i) =>
            atlas.load(`${url}#${i}`),
          );
          await waitForGoboSlots(slots);
          tile.value = slots[slots.length - 1].index;
          stride.value = atlas.tilesPerRow;
          const after = await sample();
          return {
            before,
            after,
            tilesPerRow: atlas.tilesPerRow,
            stackRows: atlas.stacks.texture.image.height,
            stackRow,
          };
        } finally {
          atlas.dispose();
          material.dispose();
          renderer.dispose();
        }
      },
      forceWebGL,
    );
    expect(errors).toEqual([]);
    expect(result.tilesPerRow).toBe(8);
    expect(result.stackRows).toBe(512);
    expect(result.stackRow).toBeGreaterThanOrEqual(256);
    // Before growth: tile 0 is fully open.
    expect(result.before.left[0]).toBeGreaterThan(240);
    // After growth: the new tile's left half is opaque, and the new stack row holds slot 7.
    expect(result.after.left[0]).toBeGreaterThan(240);
    expect(result.after.leftDark[0]).toBeLessThan(15);
    expect(result.after.right[0]).toBeGreaterThan(150);
    expect(result.after.right[1]).toBeGreaterThan(90);
  });
}
