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
  { path: "architecture/system-overview.html", diagrams: 4 },
  { path: "architecture/client-protocol.html", diagrams: 3 },
  { path: "architecture/web-ui.html", diagrams: 5 },
  { path: "architecture/crate-map.html", diagrams: 1 },
  { path: "engine/frame-loop.html", diagrams: 4 },
  { path: "engine/command-path.html", diagrams: 2 },
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
      const rendered = page.locator(".mermaid-diagram");
      for (let index = 0; index < diagrams; index += 1) {
        await rendered.nth(index).screenshot({
          path: testInfo.outputPath(
            `${name}-diagram-${index + 1}-${theme}.png`,
          ),
        });
      }
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

/**
 * Checks that the sidebar highlights the current page when the host serves pages without their
 * `.html` extension, as the Cloudflare preview does. A routed fake host maps each extensionless
 * path back to the built file.
 */
test("developer guide sidebar highlights the current page on extensionless URLs", async ({
  page,
}) => {
  await page.route("http://guide.test/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    let file = pathname.replace(/^\/internal\//, "");
    if (file === "" || file.endsWith("/")) file += "index.html";
    else if (!/\.\w+$/.test(file)) file += ".html";
    await route.fulfill({ path: resolve("docs/internal/book", file) });
  });

  await page.goto("http://guide.test/internal/concepts/priorities-and-merging");
  const active = page.locator("#mdbook-sidebar a.active");
  await expect(active).toHaveCount(1);
  await expect(active).toContainText("Priorities and merging");
  await expect(active).toHaveCSS("font-weight", "600");

  await page.goto("http://guide.test/internal/");
  await expect(active).toHaveCount(1);
  await expect(active).toContainText("Nightfall Developer Guide");
});

/**
 * Checks that clicking a table heading sorts the rows by that column and that a second click
 * reverses the order, using the concept map's terms table.
 */
test("developer guide tables sort by a clicked column", async ({ page }) => {
  await page.goto(guideUrl("concepts/concept-map.html"));
  const table = page.locator("table.sortable").first();
  const firstTerm = table.locator("tbody tr").first().locator("td").first();
  const heading = table.locator("th").first();

  await heading.getByRole("button").click();
  await expect(heading).toHaveAttribute("aria-sort", "ascending");
  await expect(firstTerm).toHaveText("Action");

  await heading.getByRole("button").click();
  await expect(heading).toHaveAttribute("aria-sort", "descending");
  await expect(firstTerm).not.toHaveText("Action");
});

/**
 * Checks that a GitHub-style `[!WARNING]` blockquote renders as a titled callout without the raw
 * marker text.
 */
test("developer guide renders GitHub-style alerts as callouts", async ({
  page,
}) => {
  await page.goto(guideUrl("concepts/priorities-and-merging.html"));
  const callout = page.locator("blockquote.blockquote-tag-warning").first();
  await expect(callout.locator(".blockquote-tag-title")).toHaveText("Warning");
  await expect(callout).not.toContainText("[!WARNING]");
});
