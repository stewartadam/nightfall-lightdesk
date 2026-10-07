// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import {
  dockFixturesInMainGrid,
  resetToDefaultLayout,
  waitForDockviewApp,
} from "./showfile-startup";

for (const component of [
  "SequenceList",
  "TimelinesPanel",
  "GroupsPanel",
  "CueList",
  "FxList",
  "ClipList",
  "BlueprintsPanel",
]) {
  /** Checks directional CSS entrances, repeated selection, interruption, and reduced motion on a real panel. */
  test(`${component} slides between list and grid views`, async ({
    page,
  }, testInfo) => {
    await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
    await waitForDockviewApp(page);
    await resetToDefaultLayout(page);
    await dockFixturesInMainGrid(page);
    await page.evaluate((component) => {
      const api = (window as any).appStores.dockApi.get();
      api.addPanel({
        id: "view-animation-check",
        component,
        title: component,
        params: { initialPanelId: "view-animation-check" },
        position: { referencePanel: "panel-FixtureGrid", direction: "within" },
      });
      api.getPanel("view-animation-check").focus();
    }, component);
    const panel = page.locator(
      `[data-component="${component}"][data-panel-id="view-animation-check"]`,
    );
    await panel.getByRole("button", { name: "Switch to grid view" }).click();
    for (const [mode, offset] of [
      ["list", "-100%"],
      ["grid", "100%"],
    ]) {
      // Pause the entrance in the same task as the click; a separate round
      // trip lets the short slide finish first on a loaded machine.
      expect(
        await panel
          .getByRole("button", { name: `Switch to ${mode} view` })
          .evaluate(async (button) => {
            const root = button.closest("[data-panel-id]")!;
            (button as HTMLButtonElement).click();
            let element = root.querySelector(".animate-in");
            while (!element?.getAnimations().length) {
              await new Promise(requestAnimationFrame);
              element = root.querySelector(".animate-in");
            }
            const animation = element.getAnimations()[0];
            animation.pause();
            animation.currentTime = 60;
            return [
              animation instanceof CSSAnimation,
              getComputedStyle(element).getPropertyValue(
                "--tw-enter-translate-x",
              ),
            ];
          }),
      ).toEqual([true, offset]);
      const content = panel.locator(".animate-in");
      await expect(content).toHaveCount(1);
      if (mode === "list")
        await panel.screenshot({
          path: testInfo.outputPath("list-slide.png"),
          animations: "allow",
        });
    }
    await panel
      .locator(".animate-in")
      .evaluate((element) => element.getAnimations()[0].finish());
    await expect(panel.locator(".animate-in")).toHaveCount(0);
    await panel.getByRole("button", { name: "Switch to grid view" }).click();
    await expect(panel.locator(".animate-in")).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await panel.getByRole("button", { name: "Switch to list view" }).click();
    await expect(panel.locator(".animate-in")).toHaveCount(0);
  });
}
