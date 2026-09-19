// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

/** Checks external manual navigation and captures desktop and mobile rendering. */
test("manual toolbar links to the homepage and GitHub", async ({
  page,
}, testInfo) => {
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(pathToFileURL(resolve("docs/book/index.html")).href);
    const home = page.getByRole("link", {
      name: "Nightfall homepage",
      exact: true,
    });
    const github = page.getByRole("link", {
      name: "Git repository",
      exact: true,
    });
    await expect(home).toBeVisible();
    await expect(home).toHaveAttribute("href", "https://nightfall.live");
    await expect(github).toBeVisible();
    await expect(github).toHaveAttribute(
      "href",
      "https://github.com/stewartadam/nightfall-lightdesk",
    );
    await home.focus();
    await expect(home).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`manual-${width}.png`) });
  }
});
