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

/** Opens Settings through its shortcut and returns the dialog and its search field. */
async function openSettings(page: Page) {
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  const search = dialog.getByRole("searchbox", { name: "Search settings" });
  return { dialog, search };
}

/**
 * Checks that typing filters settings from every tab under their tab names, that query words may
 * be split between a title and its rows, that content outside rows is found by its keywords, that
 * a miss shows the empty state, and that Escape clears the search before it closes the dialog.
 */
test("settings search filters rows across every tab", async ({
  page,
}, testInfo) => {
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  const { dialog, search } = await openSettings(page);
  const tabs = dialog.getByRole("tablist", { name: "Settings categories" });
  await expect(tabs).toBeVisible();
  await expect(search).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("01-settings-open.png") });

  await search.fill("timeline");
  await expect(tabs).toBeHidden();
  const results = dialog.getByRole("region", { name: "Search results" });
  // "Timeline" names a section in Editors and appears in the Audio row's description in General.
  await expect(
    results.getByRole("heading", { name: "Editors", exact: true }),
  ).toBeVisible();
  await expect(
    results.getByRole("heading", { name: "General", exact: true }),
  ).toBeVisible();
  await expect(results.getByText("Insert and paste position")).toBeVisible();
  await expect(results.getByText("Output Device")).toBeVisible();
  await expect(results.getByText("Auto-select on attribute set")).toBeHidden();
  await expect(
    results.getByRole("heading", { name: "Visualizer", exact: true }),
  ).toBeHidden();
  await page.screenshot({
    path: testInfo.outputPath("02-search-timeline.png"),
  });

  await search.fill("dmx rate");
  await expect(results.getByText("DMX output rate (Hz)")).toBeVisible();
  await expect(results.getByText("Input visibility")).toBeHidden();
  await page.screenshot({
    path: testInfo.outputPath("03-search-dmx-rate.png"),
  });

  // Words may be split between a tab or section title and the row beneath it.
  await search.fill("visualizer darkness");
  await expect(results.getByText(/^Darkness/)).toBeVisible();
  await expect(results.getByText("Highlight selection")).toBeHidden();

  await search.fill("accent");
  await expect(
    results.getByRole("button", { name: "Violet accent" }),
  ).toBeVisible();
  await expect(results.getByText("Table gridlines")).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("04-search-accent.png") });

  await search.fill("zzzz");
  await expect(
    results.getByRole("status").filter({ hasText: "No settings match" }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("05-search-empty.png") });

  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(dialog).toBeVisible();
  await expect(tabs).toBeVisible();
  await search.press("Escape");
  await expect(dialog).toBeHidden();
});
