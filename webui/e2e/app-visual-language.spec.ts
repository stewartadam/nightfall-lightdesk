// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Exercises production shell styling, portal dialogs, and card/list workflows with the embedded engine. */
test("application shares the design lab visual language", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await expect(page.locator("body")).toHaveCSS("color-scheme", "dark");
  await expect(
    page.locator(".dockview-theme-nightfall-graphite"),
  ).toBeVisible();
  await expect(page.locator(".nf-app-header")).toHaveCSS(
    "background-color",
    "rgb(16, 17, 18)",
  );
  await expect(page.locator(".nf-status-bar")).toHaveCSS(
    "background-color",
    "rgb(16, 17, 18)",
  );
  await page.screenshot({ path: testInfo.outputPath("app-shell.png") });

  await page
    .getByRole("button", { name: "Open command palette", exact: true })
    .click();
  const palette = page.locator('[data-dialog-kind="command-palette"]');
  await expect(palette.locator(":scope > div")).toHaveCSS(
    "background-color",
    "rgb(25, 27, 29)",
  );
  await palette.getByPlaceholder("Type a command or search...").fill("groups");
  await page.screenshot({
    path: testInfo.outputPath("app-command-palette.png"),
  });
  await page.locator('[data-command-id="panel-Groups"]').click();
  await page.getByRole("button", { name: "Add group", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Create group", exact: true });
  await expect(modal).toBeVisible();
  await expect(modal.locator(".nightfall-modal-surface")).toHaveCSS(
    "background-color",
    "rgb(25, 27, 29)",
  );
  await page.screenshot({ path: testInfo.outputPath("app-group-dialog.png") });
  await modal.getByRole("button", { name: "Cancel", exact: true }).click();
  const card = page.locator(".nf-crud-card:visible").first();
  await expect(card).toBeVisible();
  await page
    .getByRole("button", { name: "Toggle selection mode", exact: true })
    .click();
  await card.click();
  await expect(
    page.locator(".nf-crud-card-selected:visible").first(),
  ).toHaveCSS("border-top-color", "rgb(84, 213, 180)");
  await card.click({ button: "right" });
  await expect(page.locator('[data-menu-kind^="context"]')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("app-group-context-menu.png"),
  });
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Switch to list view", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page.locator('[role="grid"]:visible').first()).toHaveCSS(
    "background-color",
    "rgb(25, 27, 29)",
  );
  await page.screenshot({ path: testInfo.outputPath("app-group-list.png") });
  await page.setViewportSize({ width: 900, height: 700 });
  await expect(
    page.getByRole("button", { name: "Open command palette", exact: true }),
  ).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("app-narrow.png") });
});
