// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// SPDX-License-Identifier: MPL-2.0

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const panels = [
  {
    component: "Visualizer",
    width: 420,
    selector: '[aria-label="Visualizer toolbar"]',
  },
  { component: "Timeline", width: 640, selector: "[data-timeline-toolbar]" },
  {
    component: "StatusDisplay",
    width: 360,
    selector: '[aria-label="Status display content"] section > div:first-child',
  },
];

for (const panel of panels) {
  /** Checks real docking constraints and visible controls at the smallest supported panel width. */
  test(`${panel.component} controls fit at the panel minimum`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
    await waitForDockviewApp(page);
    await expect
      .poll(() =>
        page.evaluate(
          () => Object.keys((window as any).appStores.timelines.get()).length,
        ),
      )
      .toBeGreaterThan(0);
    await page.evaluate(({ component }) => {
      const stores = (window as any).appStores;
      const api = stores.dockApi.get();
      const uid = Object.keys(stores.timelines.get())[0];
      api.clear();
      api.addPanel({
        id: "minimum-width-target",
        component,
        title: component,
        params: { initialTimelineUid: uid },
      });
      api.addPanel({
        id: "minimum-width-neighbor",
        component: "FixtureGrid",
        title: "Fixtures",
        position: {
          referencePanel: "minimum-width-target",
          direction: "right",
        },
      });
      api.getPanel("minimum-width-target").api.setSize({ width: 80 });
    }, panel);
    const chrome = page.locator(panel.selector).first();
    await expect(chrome).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).appStores.dockApi
              .get()
              .getPanel("minimum-width-target").api.width,
        ),
      )
      .toBeGreaterThanOrEqual(panel.width);
    const renderedWidth = await chrome.evaluate(
      (element) => element.getBoundingClientRect().width,
    );
    expect(renderedWidth).toBeLessThanOrEqual(panel.width + 16);

    const geometry = await chrome.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const controls = Array.from(
        element.querySelectorAll("button, input, select, h2, [role=switch]"),
      ).map((control) => {
        const rect = control.getBoundingClientRect();
        return {
          label: control.getAttribute("aria-label") ?? control.textContent,
          left: rect.left,
          right: rect.right,
          centerY: rect.top + rect.height / 2,
        };
      });
      return {
        left: bounds.left,
        right: bounds.right,
        height: bounds.height,
        controls,
      };
    });
    expect(geometry.controls.length).toBeGreaterThan(2);
    for (const control of geometry.controls) {
      expect(control.left, control.label ?? "control").toBeGreaterThanOrEqual(
        geometry.left,
      );
      expect(control.right, control.label ?? "control").toBeLessThanOrEqual(
        geometry.right,
      );
      expect(
        Math.abs(control.centerY - geometry.controls[0].centerY),
        control.label ?? "control",
      ).toBeLessThan(4);
    }
    if (panel.component === "Timeline") {
      expect(
        await page
          .locator("[data-timeline-footer-toolbar]")
          .evaluate((element) => element.clientHeight),
      ).toBeLessThanOrEqual(46);
    }
    await page.screenshot({
      path: testInfo.outputPath(`${panel.component}-minimum.png`),
    });
  });
}
