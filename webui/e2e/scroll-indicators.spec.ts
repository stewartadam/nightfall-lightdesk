// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Locator, Page } from "@playwright/test";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Opens the production table and tab controls inside the design lab's resizable workspace. */
async function openTables(page: Page) {
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Data grid/ })
    .click();
  const panel = page.getByRole("region", { name: "Data grid example" });
  await panel.getByRole("tab", { name: "Read-only status" }).click();
  return panel;
}

/** Asserts the affordance is both logically enabled and visibly rendered at the requested edges. */
async function expectEdges(viewport: Locator, visible: string[]) {
  const frame = viewport.locator("..");
  for (const edge of ["top", "bottom", "left", "right"]) {
    await expect(
      frame.locator(`.nf-scroll-edge[data-edge="${edge}"]`),
    ).toHaveCSS("opacity", visible.includes(edge) ? "1" : "0");
  }
}

/** Prevents activation through every blurred edge while retaining wheel scrolling and uncovered clicks. */
test("blurred edges block pointer activation but preserve scrolling", async ({
  page,
}, testInfo) => {
  const panel = await openTables(page);
  const viewport = panel.getByRole("region", {
    name: "Timecode table scroll area",
  });
  await viewport.evaluate((element) => {
    element.scrollTo({ top: 100, left: 40 });
    element.setAttribute("data-pointer-activations", "0");
    for (const type of ["pointerdown", "click", "dblclick", "contextmenu"]) {
      element.addEventListener(type, () => {
        element.setAttribute(
          "data-pointer-activations",
          String(Number(element.getAttribute("data-pointer-activations")) + 1),
        );
      });
    }
  });
  await expectEdges(viewport, ["top", "bottom", "left", "right"]);
  const frame = viewport.locator("..");
  for (const edge of ["top", "bottom", "left", "right"]) {
    const strip = frame.locator(`[data-edge="${edge}"]`);
    const bounds = (await strip.boundingBox())!;
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    await page.mouse.click(x, y);
    await page.mouse.dblclick(x, y);
    await page.mouse.click(x, y, { button: "right" });
    await expect(viewport).toHaveAttribute("data-pointer-activations", "0");
    expect(
      await strip.evaluate(
        (element) => getComputedStyle(element, "::before").backdropFilter,
      ),
    ).toBe("blur(4px)");
  }
  await frame.screenshot({
    path: testInfo.outputPath("stronger-edge-blur.png"),
  });
  const bottom = (await frame.locator('[data-edge="bottom"]').boundingBox())!;
  await page.mouse.move(
    bottom.x + bottom.width / 2,
    bottom.y + bottom.height / 2,
  );
  await page.mouse.wheel(0, 80);
  await expect
    .poll(() => viewport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(100);
  const right = (await frame.locator('[data-edge="right"]').boundingBox())!;
  await page.mouse.move(right.x + right.width / 2, right.y + right.height / 2);
  await page.mouse.wheel(60, 0);
  await expect
    .poll(() => viewport.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(40);
  await expect(viewport).toHaveAttribute("data-pointer-activations", "0");
  const bounds = (await viewport.boundingBox())!;
  await page.mouse.click(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await expect(viewport).toHaveAttribute("data-pointer-activations", "2");
  await viewport.evaluate((element) =>
    element.scrollTo({ top: element.scrollHeight, left: element.scrollWidth }),
  );
  await expectEdges(viewport, ["top", "left"]);
  await page.mouse.click(
    bounds.x + bounds.width - 8,
    bounds.y + bounds.height - 8,
  );
  await expect(viewport).toHaveAttribute("data-pointer-activations", "4");
});

/** Exercises both axes, keyboard scrolling, dynamic content, and fitting content after resize. */
test("table indicators follow hidden content at each edge", async ({
  page,
}, testInfo) => {
  const panel = await openTables(page);
  const viewport = panel.getByRole("region", {
    name: "Timecode table scroll area",
  });
  await expectEdges(viewport, ["bottom", "right"]);
  await expect(
    viewport.locator("..").locator(".nf-scroll-indicators"),
  ).toHaveCSS("pointer-events", "none");
  await page.screenshot({ path: testInfo.outputPath("scroll-start.png") });

  await viewport.evaluate((element) =>
    element.scrollTo({ top: 100, left: 40 }),
  );
  await expectEdges(viewport, ["top", "bottom", "left", "right"]);
  await page.screenshot({ path: testInfo.outputPath("scroll-middle.png") });
  await viewport.evaluate((element) =>
    element.scrollTo({ top: element.scrollHeight, left: element.scrollWidth }),
  );
  await expectEdges(viewport, ["top", "left"]);
  await page.screenshot({ path: testInfo.outputPath("scroll-end.png") });

  await viewport.focus();
  await viewport.press("Home");
  await expect
    .poll(() => viewport.evaluate((element) => element.scrollTop))
    .toBe(0);
  await page.setViewportSize({ width: 2400, height: 1600 });
  await expectEdges(viewport, []);
  await page.setViewportSize({ width: 1000, height: 600 });
  await expectEdges(viewport, ["bottom", "right"]);
  await viewport.locator("table").evaluate((table) => {
    table.style.minWidth = "0";
    table.querySelectorAll("tbody tr").forEach((row) => {
      row.remove();
    });
  });
  await expectEdges(viewport, []);
});

/** Keeps horizontal hints synchronized with keyboard tab navigation and right-to-left scrolling. */
test("tab chevrons follow horizontal scrolling and direction", async ({
  page,
}, testInfo) => {
  const panel = await openTables(page);
  const tabs = panel.getByRole("tablist", { name: "Table variants" });
  await tabs.locator("..").evaluate((frame) => {
    frame.style.width = "180px";
  });
  const first = tabs.getByRole("tab", { name: "Editable cues" });
  await first.focus();
  await expectEdges(tabs, ["right"]);
  await first.press("End");
  await expect(tabs.getByRole("tab", { name: "Progress bars" })).toBeFocused();
  await expectEdges(tabs, ["left"]);
  await panel.screenshot({ path: testInfo.outputPath("tab-chevron.png") });
  await tabs.evaluate((element) => {
    element.setAttribute("dir", "rtl");
    element.scrollLeft = 0;
  });
  await expectEdges(tabs, ["left"]);
  await tabs.evaluate((element) => {
    element.scrollLeft = -element.scrollWidth;
  });
  await expectEdges(tabs, ["right"]);
});
