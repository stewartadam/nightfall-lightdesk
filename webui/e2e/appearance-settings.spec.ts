// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  expect,
  type Page,
  frontendOnlyTest as test,
} from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Opens appearance preferences through the registered application shortcut. */
async function openAppearance(page: Page) {
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "Appearance", exact: true }).click();
  return dialog;
}

/** Reads actual group positions, excluding the structural edge drawers. */
async function workspacePositions(page: Page) {
  return page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    return api.groups
      .filter((group: any) => group.api.location.type !== "edge")
      .map((group: any) => group.api.getHeaderPosition());
  });
}

/** Checks live preferences, unchanged panel identity, new/restored groups, and reload persistence. */
test("appearance settings update panels and portals and survive reload", async ({
  page,
}, testInfo) => {
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    (window as any).appearanceOriginalPanel = api.getPanel("panel-FixtureGrid");
    (window as any).appearanceOriginalLayout = api.toJSON();
  });
  const dialog = await openAppearance(page);
  await expect(dialog.getByRole("button", { name: / accent$/ })).toHaveCount(
    12,
  );
  await expect(
    dialog.getByRole("button", { name: "Mint accent" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByLabel("Table gridlines")).not.toBeChecked();
  await expect(dialog.getByLabel("Panel tab position")).toHaveValue("top");
  await expect(dialog.getByLabel("Tab alignment")).toHaveValue("justify");
  await expect(dialog.getByLabel("Reduced motion")).toHaveValue("auto");
  await dialog.getByRole("button", { name: "Violet accent" }).click();
  await dialog.getByLabel("Table gridlines").check();
  await dialog.getByLabel("Panel tab position").selectOption("bottom");
  await expect(dialog.getByLabel("Table gridlines")).toHaveCSS(
    "accent-color",
    "rgb(176, 128, 255)",
  );
  await expect
    .poll(() => workspacePositions(page))
    .toEqual(["bottom", "bottom"]);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const api = (window as any).appStores.dockApi.get();
        return (
          api.getPanel("panel-FixtureGrid") ===
          (window as any).appearanceOriginalPanel
        );
      }),
    )
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("appearance-settings.png"),
  });
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Groups", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Add group", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Switch to list view", exact: true })
    .filter({ visible: true })
    .click();
  const cell = page.locator('[role="gridcell"]:visible').first();
  await expect(cell).toHaveCSS(
    "border-right-color",
    "rgba(255, 255, 255, 0.094)",
  );
  const groupTab = page.getByRole("tab", { name: "Groups", exact: true });
  await expect
    .poll(async () => (await groupTab.boundingBox())!.y)
    .toBeGreaterThan((await cell.boundingBox())!.y);
  await expect(groupTab).toHaveCSS("border-top-color", "rgb(176, 128, 255)");
  await page.screenshot({
    path: testInfo.outputPath("bottom-tabs-gridlines.png"),
  });

  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.addPanel({
      id: "appearance-new-group",
      component: "GroupsPanel",
      title: "Extra groups",
      position: { direction: "right" },
    });
  });
  await expect
    .poll(() => workspacePositions(page))
    .toEqual(["bottom", "bottom", "bottom"]);
  await page.evaluate(() => {
    (window as any).appStores.dockApi
      .get()
      .fromJSON((window as any).appearanceOriginalLayout);
  });
  await expect
    .poll(() => workspacePositions(page))
    .toEqual(["bottom", "bottom"]);
  await page.reload();
  await waitForDockviewApp(page);
  const restoredDialog = await openAppearance(page);
  await expect(
    restoredDialog.getByRole("button", { name: "Violet accent" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(restoredDialog.getByLabel("Table gridlines")).toBeChecked();
  await expect(restoredDialog.getByLabel("Panel tab position")).toHaveValue(
    "bottom",
  );
  await expect
    .poll(() => workspacePositions(page))
    .toEqual(["bottom", "bottom"]);
  await restoredDialog.getByLabel("Panel tab position").selectOption("top");
  await restoredDialog.getByLabel("Table gridlines").uncheck();
  await expect.poll(() => workspacePositions(page)).toEqual(["top", "top"]);
  await page.setViewportSize({ width: 390, height: 780 });
  await expect(
    restoredDialog.getByRole("button", { name: "Magenta accent" }),
  ).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("appearance-narrow.png") });
});

/** Defaults malformed persisted data without blocking the application startup or settings controls. */
test("appearance settings recover from invalid stored preferences", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "nightfall-appearance",
      JSON.stringify({
        reducedMotion: "invalid",
        accent: "invalid",
        gridlines: "false",
        tabPosition: "left",
        tabAlignment: "invalid",
        muteUnfocusedAccents: "true",
      }),
    );
  });
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  const dialog = await openAppearance(page);
  await expect(
    dialog.getByRole("button", { name: "Mint accent" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByLabel("Table gridlines")).not.toBeChecked();
  await expect(dialog.getByLabel("Panel tab position")).toHaveValue("top");
  await expect(dialog.getByLabel("Tab alignment")).toHaveValue("justify");
  await expect(dialog.getByLabel("Reduced motion")).toHaveValue("auto");
  await expect(
    dialog.getByLabel("Mute accents in unfocused panels"),
  ).not.toBeChecked();
});

/** Verifies live system tracking, explicit overrides, CSS feedback, and saved motion choices. */
test("reduced motion supports Auto, On, and Off", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  const dialog = await openAppearance(page);
  const select = dialog.getByLabel("Reduced motion", { exact: true });
  const root = page.locator("html");
  const button = dialog.getByRole("button", { name: "Mint accent" });
  await expect(select).toHaveValue("auto");
  await expect(root).toHaveAttribute("data-reduced-motion", "false");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(root).toHaveAttribute("data-reduced-motion", "true");
  await expect(button).toHaveCSS("transition-duration", "0s");
  await select.selectOption("off");
  await expect(root).toHaveAttribute("data-reduced-motion", "false");
  await expect(button).not.toHaveCSS("transition-duration", "0s");
  await select.selectOption("on");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(root).toHaveAttribute("data-reduced-motion", "true");
  await expect(button).toHaveCSS("transition-duration", "0s");
  await page.screenshot({
    path: testInfo.outputPath("reduced-motion-settings.png"),
  });
  await page.reload();
  await waitForDockviewApp(page);
  const restoredDialog = await openAppearance(page);
  await expect(
    restoredDialog.getByLabel("Reduced motion", { exact: true }),
  ).toHaveValue("on");
  await expect(root).toHaveAttribute("data-reduced-motion", "true");
  await restoredDialog
    .getByLabel("Reduced motion", { exact: true })
    .selectOption("auto");
  await expect(root).toHaveAttribute("data-reduced-motion", "false");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(root).toHaveAttribute("data-reduced-motion", "true");
});

for (const preference of ["on", "off"] as const) {
  /** Verifies saved overrides take effect even before the application module loads. */
  test(`bootstrap splash honors reduced motion ${preference}`, async ({
    page,
  }) => {
    await page.emulateMedia({
      reducedMotion: preference === "on" ? "no-preference" : "reduce",
    });
    await page.addInitScript((reducedMotion) => {
      localStorage.setItem(
        "nightfall-appearance",
        JSON.stringify({ reducedMotion }),
      );
    }, preference);
    await page.route("**/main.tsx", (route) => route.abort());
    await page.goto("/");
    await expect(page.locator("#bootstrap-splash")).toBeVisible();
    const fader = page.locator(".bootstrap-fader").first();
    if (preference === "on") {
      await expect(fader).toHaveCSS("animation-name", "none");
    } else {
      await expect(fader).not.toHaveCSS("animation-name", "none");
    }
  });
}
