// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Locator } from "@playwright/test";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Checks actual tab geometry along the header's horizontal or vertical axis. */
async function expectAlignment(header: Locator, alignment: string) {
  const geometry = await header.evaluate((element) => {
    const strip = element.querySelector(".dv-tabs-container")!;
    const vertical = strip.classList.contains("dv-tabs-container-vertical");
    const bounds = strip.getBoundingClientRect();
    const tabs = Array.from(strip.querySelectorAll(":scope > .dv-tab"));
    const first = tabs[0].getBoundingClientRect();
    const last = tabs[tabs.length - 1].getBoundingClientRect();
    return {
      thickness: vertical ? bounds.width : bounds.height,
      leading: vertical ? first.top - bounds.top : first.left - bounds.left,
      trailing: vertical
        ? bounds.bottom - last.bottom
        : bounds.right - last.right,
      sizes: tabs.map((tab) => {
        const rect = tab.getBoundingClientRect();
        return vertical ? rect.height : rect.width;
      }),
    };
  });
  expect(geometry.thickness).toBe(34);
  if (alignment === "center") {
    expect(geometry.leading).toBeGreaterThan(5);
    expect(Math.abs(geometry.leading - geometry.trailing)).toBeLessThan(2);
  } else {
    if (alignment !== "end") expect(Math.abs(geometry.leading)).toBeLessThan(2);
    if (alignment !== "start")
      expect(Math.abs(geometry.trailing)).toBeLessThan(2);
    if (alignment === "justify")
      expect(
        Math.max(...geometry.sizes) - Math.min(...geometry.sizes),
      ).toBeLessThan(2);
  }
}

/** Applies all alignments to regular and edge groups, then restores the saved preference. */
test("app tab alignment covers regular and edge groups and persists", async ({
  page,
}, testInfo) => {
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await expect(page.locator("body")).toHaveAttribute(
    "data-tab-alignment",
    "justify",
  );
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    for (const group of api.groups) {
      if (group.api.location.type !== "edge") {
        for (const panel of group.panels.slice(2)) panel.api.close();
      }
    }
    for (const edge of ["left", "right", "bottom"]) {
      const group = api.getEdgeGroup(edge);
      api.addPanel({
        id: `alignment-${edge}`,
        component: "GroupsPanel",
        title: "Extra",
        position: { referenceGroup: group.id, direction: "within" },
        inactive: true,
      });
    }
  });
  for (const alignment of ["start", "center", "justify", "end"]) {
    await page.keyboard.press("ControlOrMeta+,");
    const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
    await dialog.getByRole("tab", { name: "Appearance", exact: true }).click();
    await dialog.getByLabel("Tab alignment").selectOption(alignment);
    await page.keyboard.press("Escape");
    const headers = page.locator(
      '[data-testid="dockview-host"] .dv-tabs-and-actions-container:visible',
    );
    expect(await headers.count()).toBeGreaterThanOrEqual(5);
    for (const header of await headers.all())
      await expectAlignment(header, alignment);
    await page.screenshot({
      path: testInfo.outputPath(`app-${alignment}.png`),
    });
  }
  await page.reload();
  await waitForDockviewApp(page);
  await expect(page.locator("body")).toHaveAttribute(
    "data-tab-alignment",
    "end",
  );
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("tab", { name: "Appearance", exact: true }).click();
  await expect(dialog.getByLabel("Tab alignment")).toHaveValue("end");
});

/** Exercises the lab control with both tab positions and verifies overflowing tabs remain reachable. */
test("design lab previews every tab alignment and preserves overflow", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/design-lab.html");
  const index = page.getByRole("navigation", { name: "Component index" });
  await index.getByRole("button", { name: /Docking/ }).click();
  const demo = page.getByRole("region", { name: "Docking examples" });
  await expect(demo.getByLabel("Tab alignment")).toHaveValue("justify");
  for (const position of ["Top", "Bottom"]) {
    await demo
      .getByRole("button", { name: `${position} tabs`, exact: true })
      .click();
    for (const alignment of ["start", "center", "justify", "end"]) {
      await demo.getByLabel("Tab alignment").selectOption(alignment);
      for (const header of await page
        .locator(".workspace .dv-tabs-and-actions-container:visible")
        .all())
        await expectAlignment(header, alignment);
      await page.screenshot({
        path: testInfo.outputPath(`lab-${position}-${alignment}.png`),
      });
    }
  }
  for (const name of [
    /Buttons/,
    /Toolbars/,
    /Input forms/,
    /Sliders/,
    /Color picker/,
  ])
    await index.getByRole("button", { name }).click();
  await index.getByRole("button", { name: /Docking/ }).click();
  await page.setViewportSize({ width: 1000, height: 700 });
  for (const alignment of ["center", "end", "justify"]) {
    await demo.getByLabel("Tab alignment").selectOption(alignment);
    const strip = page
      .locator(".dv-tabs-container")
      .filter({ has: page.getByRole("tab", { name: "Docking", exact: true }) });
    await strip.evaluate((element) => {
      element.scrollLeft = 0;
    });
    const first = strip.getByRole("tab").first();
    await expect(first).toBeInViewport();
    await first.click();
    await expect(
      page.getByRole("region", { name: "Group library" }),
    ).toBeVisible();
    await index.getByRole("button", { name: /Docking/ }).click();
  }
});
