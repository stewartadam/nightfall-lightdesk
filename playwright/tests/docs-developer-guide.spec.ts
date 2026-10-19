// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, type Page, test } from "@playwright/test";

/** Pages whose Mermaid diagrams must render, with the number of diagrams each contains. */
const DIAGRAM_PAGES = [
  { path: "concepts/show-to-light.html", diagrams: 3 },
  { path: "concepts/priorities-and-merging.html", diagrams: 2 },
  { path: "concepts/concept-map.html", diagrams: 3 },
  { path: "contributing/writing-style.html", diagrams: 1 },
];

/** Returns the URL of a page in the built Developer Guide. */
function guideUrl(path: string): string {
  return pathToFileURL(resolve("docs/internal/book", path)).href;
}

/** Returns the fill color of the first flowchart node shape on the page. */
async function firstNodeFill(page: Page): Promise<string> {
  return page
    .locator(".mermaid-diagram svg .node")
    .first()
    .locator("rect, circle, polygon, path")
    .first()
    .evaluate((shape) => getComputedStyle(shape).fill);
}

/**
 * Checks that the built Developer Guide renders every Mermaid block as an SVG diagram in the
 * light and navy themes, and captures each page for visual review. Requires
 * `mdbook build docs/internal` and network access to the Mermaid CDN.
 */
test("developer guide renders Mermaid diagrams in light and dark themes", async ({
  browser,
}, testInfo) => {
  for (const theme of ["light", "navy"]) {
    const context = await browser.newContext();
    await context.addInitScript((value) => {
      localStorage.setItem("mdbook-theme", value);
    }, theme);
    const page = await context.newPage();
    for (const { path, diagrams } of DIAGRAM_PAGES) {
      await page.goto(guideUrl(path));
      await expect(page.locator(".mermaid-diagram svg")).toHaveCount(diagrams);
      await expect(page.locator("code.language-mermaid")).toHaveCount(0);
      const name = path.replace(/\W+/g, "-");
      await page.screenshot({
        path: testInfo.outputPath(`${name}-${theme}.png`),
        fullPage: true,
      });
    }
    await context.close();
  }
});

/**
 * Checks that switching the book theme re-renders diagrams with the matching Mermaid theme, so
 * node colors change between the light and navy themes.
 */
test("developer guide diagrams follow book theme changes", async ({ page }) => {
  await page.goto(guideUrl("concepts/show-to-light.html"));
  await expect(page.locator(".mermaid-diagram svg")).toHaveCount(3);
  const lightFill = await firstNodeFill(page);

  await page.evaluate(() => {
    document.documentElement.classList.remove("light");
    document.documentElement.classList.add("navy");
  });
  await expect.poll(() => firstNodeFill(page)).not.toBe(lightFill);
});
