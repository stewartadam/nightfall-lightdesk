// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Page } from "@playwright/test";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const DEMO_PATH =
  process.env.NIGHTFALL_PLAYWRIGHT_VITE_MODE === "preview"
    ? "/demo/app/?startup:draftRecovery=false&e2e=1"
    : "/?engine=embedded-demo&startup:draftRecovery=false&e2e=1";

/** Opens the embedded demo at the given viewport width and waits for the docked shell. */
async function openDemoAt(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(DEMO_PATH);
  await waitForDockviewApp(page);
}

/** Verifies the docked header keeps one row and shows the full command input when it fits. */
test("header shows the command input on one row when there is room", async ({
  page,
}, testInfo) => {
  await openDemoAt(page, 1440);
  const nav = page.getByRole("navigation", { name: "Global" });
  await expect(
    nav.getByRole("textbox", { name: "Command input" }),
  ).toBeVisible();
  await expect(nav.getByRole("button", { name: "Open console" })).toHaveCount(
    0,
  );
  await expect(
    nav.getByRole("group", { name: "Layout switcher" }),
  ).toBeVisible();
  const box = await nav.boundingBox();
  expect(box?.height ?? 0).toBeLessThan(48);
  await page
    .locator("header.nf-app-header")
    .screenshot({ path: testInfo.outputPath("header-1440.png") });
});

/**
 * Verifies a narrow docked header collapses the command input to a Console button beside
 * Clear instead of wrapping, and that both the button and Ctrl/Cmd+L reach the Console panel.
 */
test("narrow header collapses the command input to a Console button", async ({
  page,
}, testInfo) => {
  await openDemoAt(page, 680);
  const nav = page.getByRole("navigation", { name: "Global" });
  const openConsole = nav.getByRole("button", { name: "Open console" });
  await expect(openConsole).toBeVisible();
  await expect(nav.getByRole("textbox", { name: "Command input" })).toHaveCount(
    0,
  );
  await expect(
    nav.getByRole("button", { name: "Clear programmer" }),
  ).toBeVisible();
  const box = await nav.boundingBox();
  expect(box?.height ?? 0).toBeLessThan(48);
  await page
    .locator("header.nf-app-header")
    .screenshot({ path: testInfo.outputPath("header-680.png") });

  await page.keyboard.press("ControlOrMeta+l");
  const panelInput = page.getByRole("textbox", { name: "Panel command input" });
  await expect(panelInput).toBeVisible();
  await expect(panelInput).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath("console-opened-680.png"),
  });

  await openConsole.click();
  await expect(panelInput).toBeVisible();
});

/** Verifies widening the window brings the full command input back without a reload. */
test("header restores the command input when the window widens", async ({
  page,
}) => {
  await openDemoAt(page, 680);
  const nav = page.getByRole("navigation", { name: "Global" });
  await expect(nav.getByRole("button", { name: "Open console" })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(
    nav.getByRole("textbox", { name: "Command input" }),
  ).toBeVisible();
  await expect(nav.getByRole("button", { name: "Open console" })).toHaveCount(
    0,
  );
});
