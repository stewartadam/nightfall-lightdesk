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
  { path: "architecture/client-protocol.html", diagrams: 4 },
  { path: "architecture/web-ui.html", diagrams: 5 },
  { path: "architecture/crate-map.html", diagrams: 1 },
  { path: "architecture/showfiles.html", diagrams: 3 },
  { path: "engine/frame-loop.html", diagrams: 4 },
  { path: "engine/command-path.html", diagrams: 2 },
  { path: "domains/fixtures-and-output.html", diagrams: 6 },
  { path: "domains/programmer.html", diagrams: 4 },
  { path: "domains/cues-and-sequences.html", diagrams: 4 },
  { path: "domains/timing.html", diagrams: 1 },
  { path: "contributing/testing.html", diagrams: 1 },
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

for (const { path, diagrams } of DIAGRAM_PAGES) {
  /**
   * Checks that one Developer Guide page renders every Mermaid block as an SVG diagram in the
   * light and navy themes, and captures the page and each diagram for visual review. Requires
   * `mdbook build docs/internal` and network access to the Mermaid CDN.
   */
  test(`developer guide renders Mermaid diagrams on ${path}`, async ({
    browser,
  }, testInfo) => {
    const name = path.replace(/\W+/g, "-");
    for (const [theme, mermaidTheme] of [
      ["light", "default"],
      ["navy", "dark"],
    ]) {
      const context = await browser.newContext();
      try {
        await context.addInitScript((value) => {
          localStorage.setItem("mdbook-theme", value);
        }, theme);
        const page = await context.newPage();
        await page.goto(guideUrl(path));
        await expect(
          page.locator(`.mermaid-diagram[data-rendered="${mermaidTheme}"] svg`),
        ).toHaveCount(diagrams);
        await expect(page.locator("code.language-mermaid")).toHaveCount(0);
        await expect(
          page.locator(".mermaid-diagram svg .error-icon"),
        ).toHaveCount(0);
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
      } finally {
        await context.close();
      }
    }
  });
}

/**
 * Checks that switching the book theme re-renders diagrams with the matching Mermaid theme, so
 * node colors change between the light and navy themes.
 */
test("developer guide diagrams follow book theme changes", async ({ page }) => {
  await page.goto(guideUrl("concepts/show-to-light.html"));
  await expect(
    page.locator('.mermaid-diagram[data-rendered="default"] svg'),
  ).toHaveCount(3);
  const lightFill = await firstNodeFill(page);

  await page.evaluate(() => {
    document.documentElement.classList.remove("light");
    document.documentElement.classList.add("navy");
  });
  await expect(
    page.locator('.mermaid-diagram[data-rendered="dark"] svg'),
  ).toHaveCount(3);
  expect(await firstNodeFill(page)).not.toBe(lightFill);
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
 * Checks that the outbox step list becomes a step-through animation: the keyframe chip moves
 * into the queue and the deltas disappear as the reader steps forward, the caption follows the
 * step, and Back returns to the previous state. Captures each step for visual review.
 */
test("developer guide queue steps walk through outbox replacement", async ({
  page,
}, testInfo) => {
  await page.goto(guideUrl("architecture/client-protocol.html"));
  const widget = page.locator(".queue-steps-widget");
  const next = widget.getByRole("button", { name: "Next step" });
  const back = widget.getByRole("button", { name: "Back" });
  const keyframe = widget.locator(".queue-steps-frame", {
    hasText: "Keyframe 14",
  });
  const delta = widget.locator(".queue-steps-frame", {
    hasText: "Delta seq 11",
  });

  await expect(page.locator(".queue-steps ol")).toBeHidden();
  await expect(widget.locator(".queue-steps-count")).toHaveText("Step 1 of 6");
  await expect(back).toBeDisabled();
  await expect(keyframe).toHaveClass(/gone/);
  await widget.scrollIntoViewIfNeeded();

  for (let step = 1; step <= 6; step += 1) {
    if (step > 1) await next.click();
    await page.waitForTimeout(700);
    await widget.screenshot({
      path: testInfo.outputPath(`queue-step-${step}.png`),
    });
    if (step === 4) {
      await expect(widget.locator(".queue-steps-caption")).toContainText(
        "The keyframe takes the oldest place.",
      );
      await expect(delta).toHaveClass(/gone/);
      await expect(keyframe).not.toHaveClass(/gone/);
      await expect(keyframe).toHaveCSS("left", "278px");
    }
  }
  await expect(next).toBeDisabled();

  await back.click();
  await back.click();
  await expect(widget.locator(".queue-steps-count")).toHaveText("Step 4 of 6");
  await expect(keyframe).toHaveCSS("left", "278px");
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
