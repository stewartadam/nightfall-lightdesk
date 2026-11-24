// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../../../webui/e2e/playwright-fixtures";
import { openDesktop, Take } from "../../record/take";

/** What the reel types into the library filter and GDTF Share's search. */
const QUERY = "spiider";
/** The Spiider mode the reel patches in: its wash mode keeps the patch to 27 channels a head. */
const MODE = "Mode 5 - Wash";
/** How many fixtures the reel patches. */
const QUANTITY = "8";

/**
 * Types `text` into `field` one key at a time, as a person would, so the take
 * shows the words appear.
 */
async function typeSlowly(field: Locator, text: string): Promise<void> {
  await field.click();
  await field.pressSequentially(text, { delay: 90 });
}

/** Docks a single Patch panel filling the portrait frame. */
async function stagePatch(page: Page): Promise<Locator> {
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.clear();
    api.addPanel({
      id: "promo-patch",
      component: "PatchEditor",
      title: "Patch",
      params: { initialPanelId: "promo-patch" },
    });
  });
  const patch = page.locator(
    '[data-component="PatchEditor"][data-panel-id="promo-patch"]',
  );
  await expect(patch).toBeVisible();
  return patch;
}

/**
 * Records the GDTF Share reel against the desktop backend, signed in to GDTF
 * Share through the GDTF_SHARE_USER and GDTF_SHARE_PASSWORD variables the
 * backend reads: the library has no Spiider, so the wizard searches GDTF
 * Share, installs the fixture, and patches eight of them.
 */
test("record the GDTF Share reel", async ({ page, backendSlot }) => {
  test.setTimeout(240_000);
  if (!process.env.GDTF_SHARE_USER || !process.env.GDTF_SHARE_PASSWORD) {
    throw new Error("Set GDTF_SHARE_USER and GDTF_SHARE_PASSWORD to record");
  }
  await openDesktop(page, backendSlot.backendPort);
  const patch = await stagePatch(page);
  await page.waitForTimeout(2_000);

  const take = new Take(page, "gdtf-share");
  await take.start();
  await page.waitForTimeout(900);
  await take.mark("begin");

  const addFixture = patch.getByRole("button", {
    name: "Add fixture",
    exact: true,
  });
  await take.glideAndClick(addFixture);
  const dialog = page.getByRole("dialog", { name: "Patch Wizard" });
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(500);

  const filter = dialog.getByLabel("Filter fixtures");
  await take.glideTo(filter);
  await typeSlowly(filter, QUERY);
  await expect(dialog.getByText("No fixtures match your search")).toBeVisible();
  await take.mark("no-match", dialog.locator(".nf-dialog-surface"));
  await page.waitForTimeout(1_200);

  await take.glideAndClick(dialog.getByTestId("patch-wizard-search-online"));
  const browser = dialog.getByTestId("gdtf-share-browser");
  const firstResult = browser.getByRole("row").nth(1);
  await expect(firstResult).toBeVisible({ timeout: 30_000 });
  await take.mark("results", browser);
  await page.waitForTimeout(1_500);

  await take.glideAndClick(firstResult);
  const selected = browser.getByTestId("gdtf-share-selected");
  await expect(selected).toBeVisible();
  await page.waitForTimeout(1_200);
  const install = selected.getByTestId("gdtf-share-install");
  await take.glideAndClick(install);
  await take.mark("install", install);
  await expect(
    dialog.getByRole("region", { name: "Fixture preview" }).locator("canvas"),
  ).toBeVisible({ timeout: 90_000 });
  await take.mark("installed", dialog.locator(".nf-dialog-surface"));
  await page.waitForTimeout(2_000);

  const next = dialog.getByRole("button", { name: "Next", exact: true });
  await take.glideAndClick(next);
  await page.waitForTimeout(800);
  const mode = dialog
    .getByLabel("Fixture modes")
    .getByRole("button")
    .filter({ hasText: MODE });
  await take.glideAndClick(mode);
  await take.mark("mode", mode);
  await page.waitForTimeout(600);
  await take.glideAndClick(next);
  await page.waitForTimeout(800);

  const quantity = dialog.getByRole("spinbutton", { name: "Quantity" });
  await take.glideTo(quantity);
  await quantity.fill("");
  await typeSlowly(quantity, QUANTITY);
  await take.mark("quantity", quantity);
  await page.waitForTimeout(1_000);
  await take.glideAndClick(next);
  await page.waitForTimeout(800);
  await take.glideAndClick(
    dialog.getByRole("button", { name: "Finish", exact: true }),
  );
  await expect(dialog).toBeHidden();
  await take.mark("patched", patch);
  await page.waitForTimeout(3_000);
  await take.mark("finish");
  await page.waitForTimeout(500);
  await take.finish();
});
