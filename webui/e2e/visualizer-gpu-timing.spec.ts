// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { annotateBackend, openOpticsFixture } from "./optics-harness";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** The real inspector must expose completed elapsed samples through the production render loop. */
test("developer inspector supplies frame-specific elapsed GPU timing", async ({
  page,
}, testInfo) => {
  const errors = await openOpticsFixture(page, "?visualizer:inspector=true");
  const result = await page.evaluate(async () => {
    const { initFeatureFlags } = await import("/lib/feature-flags.ts");
    const { initRenderer, startRenderLoop, stopRenderLoop, disposeRenderer } =
      await import("/features/visualizer/rendering/renderer.ts");
    const { rendererBackend } = await import("/e2e/fixtures/optics-harness.ts");
    initFeatureFlags();
    const canvas = document.querySelector("canvas")!;
    canvas.style.width = "400px";
    canvas.style.height = "300px";
    const state = await initRenderer(canvas);
    const backend = rendererBackend(state.renderer);
    try {
      // Elapsed samples come only from timestamp queries; devices without them cannot report any.
      if (!state.renderer.hasFeature("timestamp-query"))
        return { backend, timestampQuery: false as const };
      state.renderer.setSize(400, 300);
      const samples = new Map<number, number>();
      let frames = 0;
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
        backend,
        timestampQuery: true as const,
        inspector: Boolean(state.inspector),
        samples: [...samples.values()],
      };
    } finally {
      await disposeRenderer(state);
    }
  });
  annotateBackend(testInfo, result.backend);
  test.skip(
    !result.timestampQuery,
    "The GPU device does not support the timestamp-query feature",
  );
  if (!result.timestampQuery) return;
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
