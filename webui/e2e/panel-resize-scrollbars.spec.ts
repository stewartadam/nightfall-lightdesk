// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

// Headless Chromium hides scrollbars; Windows-style classic scrollbars take layout space.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

/**
 * Shrinks the window one frame at a time and checks that no panel viewport gains and loses a
 * scrollbar on the way. Content that briefly overflows a panel while it resizes shows as
 * flickering scrollbars with classic (non-overlay) scrollbars, and every flip resizes the panel
 * content again.
 */
test("panels do not flash scrollbars while the window shrinks", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  // The demo layout puts the Groups panel, which flickered, in the main grid.
  await expect(page.getByText("Pixel Tapes Left").first()).toBeVisible({
    timeout: 45_000,
  });

  await page.evaluate(() => {
    const flips = new Map<HTMLElement, number>();
    const states = new Map<HTMLElement, string>();
    (window as any).__scrollbarFlips = flips;
    /** Records every change in which scrollbars a visible panel viewport shows. */
    const sample = () => {
      for (const viewport of document.querySelectorAll<HTMLElement>(
        ".nf-scroll-viewport",
      )) {
        if (viewport.offsetWidth === 0) continue;
        const state = `${viewport.offsetWidth > viewport.clientWidth}:${viewport.offsetHeight > viewport.clientHeight}`;
        const previous = states.get(viewport);
        states.set(viewport, state);
        if (previous === undefined || previous === state) continue;
        flips.set(viewport, (flips.get(viewport) ?? 0) + 1);
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  for (let width = 1600; width >= 1000; width -= 15) {
    await page.setViewportSize({ width, height: 1000 - (1600 - width) / 3 });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(resolve)),
    );
  }

  const flips = await page.evaluate(() =>
    [...(window as any).__scrollbarFlips].map(
      ([viewport, count]: [HTMLElement, number]) => [
        viewport.firstElementChild?.className ?? viewport.className,
        count,
      ],
    ),
  );
  // A panel whose content stops fitting may gain a scrollbar once; flickering flips many times.
  for (const [panel, count] of flips) {
    expect(count, `${panel} scrollbar flips`).toBeLessThanOrEqual(1);
  }
});
