// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

for (const side of ["right", "bottom"] as const) {
  /** Keeps grid and edge splitters visible and usable when their panels cannot shrink further. */
  test(`splitter grip stays visible at ${side === "right" ? "width" : "height"} boundaries`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
    await waitForDockviewApp(page);
    await page.evaluate((side) => {
      const api = (window as any).appStores.dockApi.get();
      if (side === "right") {
        api.clear();
        api.addPanel({
          id: "grip-first",
          component: "SequenceList",
          title: "First panel",
        });
        api.addPanel({
          id: "grip-second",
          component: "SequenceList",
          title: "Second panel",
          position: { referencePanel: "grip-first", direction: "right" },
        });
      } else {
        api.getEdgeGroup(side).expand();
      }
    }, side);
    const horizontal = side === "right";
    const sash = horizontal
      ? page
          .locator(
            ".dv-horizontal > .dv-sash-container > .dv-sash:not(.dv-disabled)",
          )
          .filter({ visible: true })
      : page
          .locator(".dv-vertical > .dv-sash-container > .dv-sash")
          .filter({ visible: true });
    if (!horizontal) {
      const edge = page.getByTestId("dv-edge-group-edge-Console");
      await expect(edge).toBeVisible();
      const box = (await edge.boundingBox())!;
      await sash.evaluateAll((elements, y) => {
        for (const element of elements) {
          const rect = element.getBoundingClientRect();
          if (rect.width > 1000 && Math.abs(rect.y + rect.height / 2 - y) < 16)
            element.setAttribute("data-grip-under-test", "true");
        }
      }, box.y);
    }
    const target = horizontal
      ? sash
      : page.locator('[data-grip-under-test="true"]');
    await expect(target).toHaveCount(1);
    const start = (await target.boundingBox())!;
    await page.mouse.move(
      start.x + start.width / 2,
      start.y + start.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      horizontal ? 1420 : start.x + start.width / 2,
      horizontal ? start.y + start.height / 2 : 980,
      { steps: 10 },
    );
    await page.mouse.up();
    await expect(target).toHaveClass(/dv-maximum/);
    expect(
      await target.evaluate((element) => {
        const grip = getComputedStyle(element, "::after");
        return {
          content: grip.content,
          width: grip.width,
          height: grip.height,
          repeat: grip.backgroundRepeat,
        };
      }),
    ).toEqual({
      content: '""',
      width: horizontal ? "8px" : "28px",
      height: horizontal ? "28px" : "8px",
      repeat: horizontal ? "repeat-y" : "repeat-x",
    });
    await page.screenshot({
      path: testInfo.outputPath("grip-at-panel-minimum.png"),
    });
    const end = (await target.boundingBox())!;
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      horizontal ? end.x - 100 : end.x + end.width / 2,
      horizontal ? end.y + end.height / 2 : end.y - 100,
      { steps: 5 },
    );
    await page.mouse.up();
    await expect(target).toHaveClass(/dv-enabled/);
  });
}
