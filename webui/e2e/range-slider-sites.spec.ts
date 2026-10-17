// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Locator, Page } from "@playwright/test";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { resetToDefaultLayout, waitForDockviewApp } from "./showfile-startup";

/** Directory that receives review captures; tests fall back to their own output folder. */
const SHOT_DIR = process.env.NIGHTFALL_SLIDER_SHOT_DIR;
/** Prefix distinguishing captures taken before and after a change. */
const SHOT_PREFIX = process.env.NIGHTFALL_SLIDER_SHOT_PREFIX ?? "after";

/** Captures a locator to the review directory and to the test's output folder. */
async function capture(target: Locator, name: string): Promise<void> {
  const file = `${SHOT_PREFIX}-${name}.png`;
  await target.screenshot({
    path: SHOT_DIR ? `${SHOT_DIR}/${file}` : test.info().outputPath(file),
    animations: "disabled",
  });
}

/** Loads the application on the embedded demo engine with the default layout. */
async function openDemoApp(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await resetToDefaultLayout(page);
}

/** Adds and focuses a dock panel by its registered component name, moving an existing copy into the main grid. */
async function addPanel(
  page: Page,
  id: string,
  component: string,
  title: string,
) {
  await page.evaluate(
    ({ id, component, title }) => {
      const api = (window as any).appStores.dockApi.get();
      api.getPanel(id)?.api.close();
      api.addPanel({
        id,
        component,
        title,
        params: {},
        position: { referencePanel: "panel-Groups", direction: "within" },
      });
      api.getPanel(id)?.api.setActive();
    },
    { id, component, title },
  );
}

/** Shows a master level fader and checks it is a named, keyboard-operable slider. */
test("masters level fader", async ({ page }) => {
  test.setTimeout(90_000);
  await openDemoApp(page);
  await addPanel(page, "panel-Masters", "MastersPanel", "Masters");
  const panel = page.locator('[data-panel-id="panel-Masters"]:visible');
  await page.getByRole("button", { name: "New intensity global" }).click();
  const row = panel.locator("[data-master-id]").first();
  await expect(row).toBeVisible();
  const handle = row.getByRole("slider", { name: "Global Master level" });
  await expect(handle).toHaveAttribute("aria-valuenow", "100.0");
  await capture(row, "masters-row");

  const track = (await row.locator(".range-slider").boundingBox())!;
  const start = (await handle.boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  for (const fraction of [0.8, 0.6, 0.4, 0.25]) {
    await page.mouse.move(
      track.x + track.width * fraction,
      track.y + track.height / 2,
      { steps: 3 },
    );
  }
  await capture(row, "masters-row-dragging");
  await page.mouse.up();
  await expect.poll(() => masterLevel(page)).toBeLessThan(40);
  await expect(
    row.getByRole("spinbutton", { name: "Global Master level" }),
  ).toHaveValue(String(await masterLevel(page)));

  // The drag commits once, so a single undo restores the starting level.
  await page.evaluate(() =>
    (window as any).appStores.sendAndAwait({
      module: "UndoCommand",
      command: { type: "Undo", data: {} },
    }),
  );
  await expect.poll(() => masterLevel(page)).toBe(100);
  await expect(handle).toHaveAttribute("aria-valuenow", "100.0");

  await handle.focus();
  await handle.press("ArrowLeft");
  await expect.poll(() => masterLevel(page)).toBe(99);
});

/** Reads the level of the first master in the frontend store. */
async function masterLevel(page: Page): Promise<number | undefined> {
  return page.evaluate(
    () =>
      (
        Object.values((window as any).appStores.masters.get()) as Array<{
          level_percent: number;
        }>
      )[0]?.level_percent,
  );
}

/** Shows the color path timing and midpoint brightness sliders. */
test("color path sliders", async ({ page }) => {
  test.setTimeout(90_000);
  await openDemoApp(page);
  await page.waitForFunction(
    () =>
      Object.keys((window as any).appStores?.colorPaths?.get?.() ?? {}).length >
      0,
  );
  await addPanel(
    page,
    "panel-ColorPathPanel-e2e",
    "ColorPathPanel",
    "Color Paths",
  );
  const timing = page.getByRole("heading", { name: "Timing" }).locator("..");
  await expect(timing).toBeVisible();
  await timing.scrollIntoViewIfNeeded();
  await capture(timing, "color-path-timing");
});

/** Shows the tap pattern detection sliders. */
test("tap pattern sliders", async ({ page }) => {
  test.setTimeout(90_000);
  await openDemoApp(page);
  await addPanel(page, "panel-TapPattern", "TapPattern", "Tap Pattern");
  const panel = page.getByRole("region", { name: "Tap Pattern panel" });
  const settings = panel
    .locator("label", { hasText: "Beats/loop" })
    .locator("..");
  await expect(settings).toBeVisible();
  const granularity = panel.getByRole("slider", { name: "Granularity" });
  await expect(granularity).toHaveAttribute("aria-valuetext", "Balanced");
  await capture(settings, "tap-pattern-settings");
  await granularity.focus();
  await granularity.press("End");
  await expect(granularity).toHaveAttribute("aria-valuetext", "Fine");
  await expect(settings.getByText("Fine", { exact: true })).toBeVisible();
  await capture(settings, "tap-pattern-settings-fine");
});

/** Shows the visualizer darkness slider in Settings. */
test("settings darkness slider", async ({ page }) => {
  test.setTimeout(90_000);
  await openDemoApp(page);
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "Visualizer", exact: true }).click();
  const darkness = dialog.getByRole("slider", { name: "Darkness" });
  await darkness.scrollIntoViewIfNeeded();
  await capture(dialog, "settings-visualizer");
  await expect(darkness).toHaveAccessibleDescription(/visible rig/);
  await darkness.focus();
  await darkness.press("ArrowRight");
  await expect(darkness).toHaveAttribute("aria-valuenow", "51.0");
  await expect(dialog.getByText("Darkness (51%)")).toBeVisible();
  await capture(dialog, "settings-visualizer-darkness-51");
});

/** Shows the Step FX start position and spread sliders. */
test("step fx start position sliders", async ({ page }) => {
  test.setTimeout(120_000);
  await openDemoApp(page);
  await page.getByRole("tab", { name: "Fx" }).click();
  await page.getByRole("button", { name: "Add effect" }).click();
  await page.getByRole("button", { name: "Step FX", exact: true }).click();
  const editor = page.locator("[data-step-fx-editor]");
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "Start position" }).click();
  const menu = page.locator('[data-menu-kind="step-fx-start-position"]');
  await expect(menu).toBeVisible();
  await menu.getByRole("radio", { name: "Spread start position" }).click();
  await capture(menu, "step-fx-start-position");
  const spread = menu.getByRole("slider", { name: "Spread amount slider" });
  await expect(spread).toHaveAttribute("aria-valuenow", "100.0");
  await spread.focus();
  await spread.press("PageDown");
  await expect(
    menu.getByLabel("Spread amount", { exact: true }),
  ).not.toHaveValue("100");
  const start = menu.getByRole("slider", { name: "Start position dial" });
  await start.focus();
  await start.press("ArrowRight");
  await expect(
    menu.getByLabel("Start position value", { exact: true }),
  ).toHaveValue("1");
  await capture(menu, "step-fx-start-position-edited");
});

/** Shows the design lab slider, fader and attribute slider catalogs. */
test("design lab slider catalog", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/design-lab.html");
  const nav = page.getByRole("navigation", { name: "Component index" });
  for (const [button, region, name] of [
    ["Sliders", "Slider examples", "lab-sliders"],
    ["Vertical faders", "Fader examples", "lab-faders"],
    ["Attribute sliders", "Attribute slider examples", "lab-attribute-slider"],
  ] as const) {
    await nav.getByRole("button", { name: new RegExp(button) }).click();
    const panel = page.getByRole("region", { name: region, exact: true });
    await expect(panel).toBeVisible();
    await capture(panel, name);
  }
});
