// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// SPDX-License-Identifier: MPL-2.0

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { resetToDefaultLayout, waitForDockviewApp } from "./showfile-startup";

const panels = [
  {
    component: "Visualizer",
    width: 320,
    selector: '[aria-label="Visualizer toolbar"]',
  },
  { component: "Timeline", width: 480, selector: "[data-timeline-toolbar]" },
  {
    component: "StatusDisplay",
    width: 360,
    selector: '[aria-label="Status display content"] section > div:first-child',
  },
];

for (const panel of panels) {
  /**
   * Checks real docking constraints at the smallest supported panel width:
   * the controls shown keep one row inside the panel, and any that do not fit
   * stay reachable through the toolbar's "More actions" button.
   */
  test(`${panel.component} controls fit at the panel minimum`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
    await waitForDockviewApp(page);
    await resetToDefaultLayout(page);
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
      // Controls folded behind "More actions" are inert and clipped away.
      const bounds = element.getBoundingClientRect();
      const controls = Array.from(
        element.querySelectorAll("button, input, select, h2, [role=switch]"),
      )
        .filter((control) => !control.closest("[inert]"))
        .map((control) => {
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
          .evaluate((element) => element.parentElement!.clientHeight),
      ).toBeLessThanOrEqual(46);
    }
    await page.screenshot({
      path: testInfo.outputPath(`${panel.component}-minimum.png`),
    });

    const more = chrome.locator(
      "xpath=following-sibling::*//button[@data-toolbar-more]",
    );
    if ((await more.count()) === 0) return;
    await more.click();
    await expect(chrome.locator("[inert]")).toHaveCount(0);
    const unfolded = await chrome.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return Array.from(element.querySelectorAll("button, input, select")).map(
        (control) => {
          const rect = control.getBoundingClientRect();
          const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          return {
            left: rect.left,
            right: rect.right,
            boundsLeft: bounds.left,
            boundsRight: bounds.right,
            onTop: hit !== null && (control === hit || control.contains(hit)),
          };
        },
      );
    });
    for (const control of unfolded) {
      expect(control.left).toBeGreaterThanOrEqual(control.boundsLeft);
      expect(control.right).toBeLessThanOrEqual(control.boundsRight);
      // Unfolded rows draw above the panel content they cover.
      expect(control.onTop).toBe(true);
    }
    await page.screenshot({
      path: testInfo.outputPath(`${panel.component}-more-actions.png`),
    });
    await page.keyboard.press("Escape");
    await expect(more).toHaveAttribute("aria-expanded", "false");
  });
}
