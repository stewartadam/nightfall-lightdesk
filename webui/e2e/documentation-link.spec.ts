// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { readFileSync } from "node:fs";
import { documentationUrl } from "../lib/documentation-url";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** The guide address for this build: its stable version's folder on nightfall.live. */
const expectedGuideUrl = (() => {
  const { version } = JSON.parse(
    readFileSync("desktop/app-tauri/tauri.conf.json", "utf8"),
  ) as { version: string };
  const url = documentationUrl(
    "https://nightfall.live/docs/{version}/",
    version,
  );
  if (url.endsWith("/latest/"))
    throw new Error(`The app version ${version} is not semver`);
  return url;
})();

/** The app menu and command palette both open the user guide for the installed version. */
test("documentation opens the guide for this app version", async ({
  page,
  context,
}, testInfo) => {
  // Answer guide requests locally so the test never reaches the public site.
  await context.route("https://nightfall.live/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>Guide</h1>" }),
  );
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);

  await page
    .getByRole("region", { name: "Application status bar" })
    .getByRole("button", { name: "Menu", exact: true })
    .click();
  const item = page.getByRole("button", { name: "Documentation", exact: true });
  await expect(item).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("app-menu-docs.png") });
  const menuPopup = page.waitForEvent("popup");
  await item.click();
  const menuGuide = await menuPopup;
  await expect(menuGuide).toHaveURL(expectedGuideUrl);
  await menuGuide.close();

  await page.keyboard.press("ControlOrMeta+Shift+P");
  const input = page.getByPlaceholder("Type a command or search...");
  await expect(input).toBeFocused();
  await input.fill("Open Documentation");
  await expect(
    page.locator('[data-command-id="app.documentation"]'),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("palette-docs.png") });
  const palettePopup = page.waitForEvent("popup");
  await page.keyboard.press("Enter");
  const paletteGuide = await palettePopup;
  await expect(paletteGuide).toHaveURL(expectedGuideUrl);
});
