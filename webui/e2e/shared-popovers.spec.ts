// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Locator, Page } from "@playwright/test";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Budget for the embedded runtime to fetch and apply the demo show. */
const DEMO_SHOW_LOAD_TIMEOUT_MS = 45_000;

test.describe.configure({ timeout: 90_000 });

/** Opens the embedded demo engine and waits until its show has published a timeline. */
async function openDemo(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem("nightfall.currentShowfileName", "local-show");
  });
  await page.goto(
    process.env.NIGHTFALL_PLAYWRIGHT_VITE_MODE === "preview"
      ? "/demo/app/?startup:draftRecovery=false&e2e=1"
      : "/?engine=embedded-demo&startup:draftRecovery=false&e2e=1",
  );
  await waitForDockviewApp(page);
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            Object.keys((window as any).appStores?.timelines?.get?.() ?? {})
              .length,
        ),
      { timeout: DEMO_SHOW_LOAD_TIMEOUT_MS },
    )
    .toBeGreaterThan(0);
}

/** Replaces the workspace with one Dockview panel so tests do not depend on the saved layout. */
async function showOnlyPanel(
  page: Page,
  panel: { id: string; component: string; title: string; params: object },
): Promise<void> {
  await page.evaluate((options) => {
    const api = (window as any).appStores.dockApi.get();
    api.clear();
    api.addPanel(options);
  }, panel);
}

/** Asserts the popover is portaled to the document body, outside any clipping panel. */
async function expectMountedOnBody(popover: Locator): Promise<void> {
  await expect
    .poll(() =>
      popover.evaluate((element) => {
        let node: Element | null = element;
        while (node?.parentElement && node.parentElement !== document.body) {
          node = node.parentElement;
        }
        return node?.parentElement === document.body;
      }),
    )
    .toBe(true);
}

/** Verifies the header notification history opens as an anchored popover and dismisses on Escape. */
test("notification history opens as a shared popover", async ({ page }) => {
  await openDemo(page);
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    stores.clearNotificationHistory();
    stores.pushToast("info", "Desk connected", 100);
    stores.pushToast("warning", "Fixture library changed on disk", 100);
  });
  const bell = page.getByRole("button", {
    name: "Notification history",
    exact: true,
  });
  await bell.click();
  const history = page.getByRole("dialog", { name: "Notification history" });
  await expect(history).toBeVisible();
  await expect(history.locator("tbody tr")).toHaveCount(2);
  await expectMountedOnBody(history);
  await page.screenshot({
    path: test.info().outputPath("notification-history-open.png"),
  });
  await page.keyboard.press("Escape");
  await expect(history).toBeHidden();
  await expect(bell).toBeFocused();
});

/** Verifies the timeline operator lane opens the shared context menu and its actions still run. */
test("timeline operator lane uses the shared context menu", async ({
  page,
}) => {
  await openDemo(page);
  const timelineUid = await page.evaluate(
    () => Object.keys((window as any).appStores.timelines.get())[0],
  );
  await showOnlyPanel(page, {
    id: "popover-timeline",
    component: "Timeline",
    title: "Timeline",
    params: { initialTimelineUid: timelineUid },
  });
  const lane = page
    .locator(
      `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
    )
    .locator('[data-timeline-operator-lane="true"]');
  await expect(lane).toBeVisible();
  // The demo's regions cover the lane, so clear them locally to reach empty lane space.
  await page.evaluate((uid) => {
    const stores = (window as any).appStores;
    const timeline = stores.timelines.get()[uid];
    stores.timelines.setKey(uid, { ...timeline, regions: [] });
  }, timelineUid);
  await expect(page.locator('[data-timeline-region="true"]')).toHaveCount(0);
  const regionsBefore = 0;
  await lane.click({ button: "right", position: { x: 260, y: 20 } });
  const menu = page.locator('[data-menu-kind="context"]');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Add marker",
    "Add region",
    "Set loop range",
  ]);
  await page.screenshot({
    path: test.info().outputPath("timeline-context-menu-open.png"),
  });
  await menu.getByRole("menuitem", { name: "Add region" }).click();
  await expect(menu).toBeHidden();
  await expect(page.locator('[data-timeline-region="true"]')).toHaveCount(
    regionsBefore + 1,
  );
});

/** Verifies the FX attribute picker escapes its panel, stays open while toggling, and closes on Escape. */
test("fx attribute picker opens as a shared popover menu", async ({ page }) => {
  await openDemo(page);
  const fxUid = await page.evaluate(
    () => Object.keys((window as any).appStores.fx.get())[0],
  );
  expect(fxUid).toBeTruthy();
  await showOnlyPanel(page, {
    id: "popover-fx-editor",
    component: "FxEditor",
    title: "FX Editor",
    params: { initialPanelId: "popover-fx-editor", initialFxUid: fxUid },
  });
  const add = page.getByRole("button", { name: "Add attribute" });
  await add.click();
  const menu = page.getByRole("menu", { name: "Attributes" });
  await expect(menu).toBeVisible();
  const popover = page.locator("[data-fx-attribute-picker-menu]");
  await expectMountedOnBody(popover);
  await expect(
    popover.getByRole("searchbox", { name: "Search attributes" }),
  ).toBeFocused();
  const items = menu.getByRole("menuitemcheckbox");
  await expect(items.first()).toBeVisible();
  const first = items.first();
  const wasChecked = await first.getAttribute("aria-checked");
  await first.click();
  await expect(first).not.toHaveAttribute("aria-checked", wasChecked ?? "");
  await expect(menu).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("fx-attribute-picker-open.png"),
  });
  await first.click();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(add).toBeFocused();
});

/** Verifies the controller mapping popover lists choices with descriptions and focuses the suggestion. */
test("mapping popover is built from shared menu components", async ({
  page,
}) => {
  await openDemo(page);
  await page.getByRole("button", { name: "Controller mapping mode" }).click();
  await expect(page.locator("[data-mapping-mode-banner]")).toBeVisible();
  // The demo has no MIDI input, so arm a pad press through the shared module the app uses.
  await page.evaluate(async () => {
    const modulePath = "/features/io/model/mapping-mode.ts";
    const mappingMode = await import(/* @vite-ignore */ modulePath);
    mappingMode.armMidiSource({
      device: "Demo pad",
      channel: 0x90,
      note: 36,
      velocity: 127,
      source: { type: "Note", data: { channel: 0, note: 36 } },
    });
  });
  const overlay = page
    .getByRole("button", { name: /^Map / })
    .and(page.locator('[data-mapping-compatible="true"]'))
    .first();
  const label = (await overlay.getAttribute("aria-label")) ?? "";
  await overlay.click();
  const menu = page.getByRole("menu", { name: `${label} to` });
  await expect(menu).toBeVisible();
  await expectMountedOnBody(menu);
  await expect(menu.locator("[data-recommended]")).toHaveCount(1);
  await expect(menu.locator("[data-recommended]")).toBeFocused();
  await expect(menu.locator("[data-recommended]")).toContainText("Suggested");
  await page.screenshot({
    path: test.info().outputPath("mapping-popover-open.png"),
  });
  await page
    .locator("[data-mapping-mode-banner]")
    .click({ position: { x: 4, y: 4 } });
  await expect(menu).toBeHidden();
});
