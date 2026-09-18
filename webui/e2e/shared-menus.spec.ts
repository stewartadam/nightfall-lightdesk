// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  expect,
  type Locator,
  frontendOnlyTest as test,
} from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Captures the visible surface, row and icon treatment independently of menu behavior. */
async function menuAppearance(menu: Locator) {
  return menu.evaluate((element) => {
    const surface = getComputedStyle(element);
    const row = getComputedStyle(element.querySelector("button")!);
    const icon = getComputedStyle(element.querySelector("button > span")!);
    return {
      background: surface.backgroundColor,
      border: surface.border,
      radius: surface.borderRadius,
      shadow: surface.boxShadow,
      padding: surface.padding,
      color: row.color,
      font: row.font,
      rowPadding: row.padding,
      rowHeight: row.height,
      gap: row.gap,
      iconWidth: icon.width,
      iconHeight: icon.height,
    };
  });
}

/** Compares real application entry points and exercises settings and timeline actions. */
test("settings, tile and timeline menus share their visual treatment", async ({
  page,
}, testInfo) => {
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.locator('[title="Menu"]').click();
  const dropdown = page.locator('[data-menu-kind="dropdown"]');
  await expect(dropdown).toBeVisible();
  const appearance = await menuAppearance(dropdown);
  const troubleshooting = dropdown.getByRole("button", {
    name: "Troubleshooting",
    exact: true,
  });
  await troubleshooting.hover();
  const submenu = page.locator('[data-menu-kind="dropdown-submenu"]');
  await expect(submenu).toBeVisible();
  expect(await menuAppearance(submenu)).toEqual(appearance);
  await expect(troubleshooting).toHaveCSS("font", appearance.font);
  await expect(troubleshooting).toHaveCSS("padding", appearance.rowPadding);
  await expect(troubleshooting).toHaveCSS("height", appearance.rowHeight);
  await page.screenshot({
    path: testInfo.outputPath("troubleshooting-menu.png"),
  });
  await dropdown.getByRole("button", { name: /Settings/ }).hover();
  await page.screenshot({ path: testInfo.outputPath("settings-menu.png") });
  await dropdown.getByRole("button", { name: /Settings/ }).click();
  await expect(
    page.getByRole("dialog", { name: "Settings", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("tab", { name: "Groups", exact: true }).click();
  const tile = page.locator(".nf-crud-card:visible").first();
  await expect(tile).toBeVisible();
  await tile.click({ button: "right" });
  const context = page.locator('[data-menu-kind="context"]');
  await expect(context).toBeVisible();
  expect(await menuAppearance(context)).toEqual(appearance);
  await page.screenshot({ path: testInfo.outputPath("tile-menu.png") });
  await page.keyboard.press("Escape");

  await page.evaluate(() => {
    const stores = (window as any).appStores;
    const timeline = Object.values(stores.timelines.get())[0] as any;
    stores.dockApi.get().addPanel({
      id: "shared-menu-timeline",
      component: "Timeline",
      title: "Timeline menu check",
      params: { initialTimelineUid: timeline.identifiers.uid },
      position: { referencePanel: "panel-FixtureGrid", direction: "within" },
    });
  });
  const track = page
    .locator('[data-timeline-track-header="true"]:visible')
    .first();
  await expect(track).toBeVisible();
  await track.locator("[data-track-header-handle]").click({ button: "right" });
  await expect(context).toBeVisible();
  expect(await menuAppearance(context)).toEqual(appearance);
  const mute = context.getByRole("menuitem", {
    name: "Mute Track M",
    exact: true,
  });
  const previouslyChecked = await mute.locator("svg").count();
  await context
    .getByRole("menuitem", { name: "Remove Track", exact: true })
    .hover();
  await page.screenshot({ path: testInfo.outputPath("timeline-menu.png") });
  await mute.click();
  await expect(context).toBeHidden();
  await track.locator("[data-track-header-handle]").click({ button: "right" });
  await expect(mute.locator("svg")).toHaveCount(previouslyChecked ? 0 : 1);
  await page.keyboard.press("Escape");
});

/** Exercises checked, disabled, destructive and keyboard states in the shared lab dropdown. */
test("lab dropdown uses the context-menu primitives and action states", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Context menus/ })
    .click();
  const panel = page.getByRole("region", { name: "Context menu examples" });
  await panel
    .getByRole("button", { name: "Object actions", exact: true })
    .click();
  const context = page.locator('[data-menu-kind="context"]');
  await expect(context).toBeVisible();
  const appearance = await menuAppearance(context);
  await page.keyboard.press("Escape");
  const trigger = panel.getByRole("button", {
    name: "Menu actions",
    exact: true,
  });
  await trigger.click();
  const dropdown = page.locator('[data-menu-kind="dropdown"]');
  await expect(dropdown).toBeVisible();
  expect(await menuAppearance(dropdown)).toEqual(appearance);
  await expect(
    dropdown.getByRole("button", { name: "Unavailable action" }),
  ).toBeDisabled();
  const details = dropdown.getByRole("button", { name: "Show details" });
  await expect(details.locator("svg")).toHaveCount(1);
  await details.click();
  await expect(dropdown).toBeHidden();
  await trigger.click();
  await expect(details.locator("svg")).toHaveCount(0);
  const open = dropdown.getByRole("button", { name: /Open selection/ });
  await trigger.focus();
  await trigger.press("Tab");
  await expect(open).toBeFocused();
  await expect(open).not.toHaveCSS("box-shadow", "none");
  await page.screenshot({ path: testInfo.outputPath("lab-dropdown.png") });
  await open.press("Enter");
  await expect(dropdown).toBeHidden();
  await expect(panel.getByRole("status")).toHaveText("Opened selection");
  await trigger.click();
  await dropdown.getByRole("button", { name: "Remove selection" }).click();
  await expect(panel.getByRole("status")).toHaveText("Removed selection");
  await expect(dropdown).toBeHidden();
});
