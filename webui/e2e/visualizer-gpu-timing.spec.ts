// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** The real inspector must expose completed elapsed samples through the production render loop. */
test("developer inspector supplies frame-specific elapsed GPU timing", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/e2e/fixtures/optics.html?visualizer:inspector=true");
  const result = await page.evaluate(async () => {
    const { initFeatureFlags } = await import("/lib/feature-flags.ts");
    const { initRenderer, startRenderLoop, stopRenderLoop, disposeRenderer } =
      await import("/features/visualizer/rendering/renderer.ts");
    initFeatureFlags();
    const canvas = document.querySelector("canvas")!;
    canvas.style.width = "400px";
    canvas.style.height = "300px";
    const state = await initRenderer(canvas);
    state.renderer.setSize(400, 300);
    const samples = new Map<number, number>();
    let frames = 0;
    try {
      await new Promise<void>((resolve) => {
        startRenderLoop(state, {
          /** Collects completed asynchronous samples without introducing competing GPU readbacks. */
          onFrame(metrics) {
            if (metrics.gpu)
              samples.set(metrics.gpu.id, metrics.gpu.milliseconds);
            if (++frames === 90) {
              stopRenderLoop(state);
              resolve();
            }
          },
        });
      });
      return {
        inspector: Boolean(state.inspector),
        samples: [...samples.values()],
      };
    } finally {
      await disposeRenderer(state);
    }
  });
  expect(errors).toEqual([]);
  expect(result.inspector).toBe(true);
  expect(result.samples.length).toBeGreaterThan(3);
  expect(
    result.samples.every(
      (milliseconds) => Number.isFinite(milliseconds) && milliseconds >= 0,
    ),
  ).toBe(true);
  expect(Math.max(...result.samples)).toBeGreaterThan(0);
});
