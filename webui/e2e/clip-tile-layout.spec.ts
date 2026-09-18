// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Checks fixed clip geometry, header alignment, and reflow across panel widths. */
test("clip tiles keep uniform geometry with mixed badges", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.getByRole("tab", { name: "Clips", exact: true }).click();
  await page.waitForFunction(
    () => Object.keys((window as any).appStores?.clips?.get() ?? {}).length > 0,
  );
  const clips = await page.evaluate(() => {
    const stores = (window as any).appStores;
    const entries = Object.values(stores.clips.get()) as any[];
    const seeded = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => {
        const sourceType = index < 4 ? "Sequence" : "Fx";
        const entry = entries.find(
          ([clip]) => clip.source?.type === sourceType,
        );
        if (!entry) throw new Error(`Missing ${sourceType} sample clip`);
        const [template] = entry;
        const uid = crypto.randomUUID().replaceAll("-", "");
        const clip = {
          ...template,
          identifiers: {
            ...template.identifiers,
            uid,
            id: index + 10,
            label:
              index === 6
                ? "Claps (Strobes and full-stage wash)"
                : `Tile ${index + 10}`,
          },
          options: {
            ...template.options,
            auto_release: Boolean(index & 1),
            deactivate_on_sequence_end: Boolean(index & 2),
          },
        };
        return [uid, [clip, index === 7]];
      }),
    );
    stores.clips.set(seeded);
    return Object.entries(seeded).map(([uid, [clip]]) => ({
      uid,
      ...clip.identifiers,
    }));
  });

  for (const clip of clips) {
    const card = page.locator(`[data-crud-select-id="${clip.uid}"]`);
    await expect(card).toBeVisible();
    await expect(card).toHaveCSS("width", "140px");
    await expect(card).toHaveCSS("height", "60px");
    const badges = card.locator(".nf-tile-badge");
    await expect(badges).toHaveCount(
      1 + ((clip.id - 10) & 1) + (((clip.id - 10) >> 1) & 1),
    );
    const geometry = await card.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const badges = Array.from(element.querySelectorAll(".nf-tile-badge"));
      return {
        overflowing:
          element.scrollHeight > element.clientHeight ||
          element.scrollWidth > element.clientWidth,
        badgeRows: new Set(
          badges.map((badge) => badge.getBoundingClientRect().y),
        ).size,
        contained: badges.every((badge) => {
          const rect = badge.getBoundingClientRect();
          return (
            rect.left >= bounds.left &&
            rect.right <= bounds.right &&
            rect.bottom <= bounds.bottom
          );
        }),
      };
    });
    expect(geometry).toEqual({
      overflowing: false,
      badgeRows: 1,
      contained: true,
    });
    await expect(badges.first()).toHaveCSS("font-size", "8px");
    const title = await card
      .locator(":scope > div:first-child > div:first-child")
      .boundingBox();
    const icon = await card
      .getByRole("button", { name: `Inspect clip ${clip.id}`, exact: true })
      .locator("svg")
      .boundingBox();
    expect(title).not.toBeNull();
    expect(icon).not.toBeNull();
    expect(
      Math.abs(title!.y + title!.height / 2 - icon!.y - icon!.height / 2),
    ).toBeLessThanOrEqual(1);
    expect(icon!.height).toBe(title!.height);
  }
  const last = page.locator(`[data-crud-select-id="${clips[7].uid}"]`);
  await last
    .locator("..")
    .screenshot({ path: testInfo.outputPath("uniform-clip-tiles.png") });

  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-ClipList").api.moveTo({
      group: api.getPanel("panel-FixtureGrid").api.group,
      position: "right",
    });
  });
  const cards = page
    .locator(".nf-crud-card")
    .filter({ has: page.getByRole("button", { name: /Inspect clip/ }) });
  for (const width of [360, 220, 120]) {
    await page.evaluate((width) => {
      (window as any).appStores.dockApi
        .get()
        .getPanel("panel-ClipList")
        .api.setSize({ width });
    }, width);
    await expect
      .poll(async () => {
        const boxes = await cards.evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return { width: rect.width, height: rect.height, y: rect.y };
          }),
        );
        return {
          fixedSize: boxes.every(
            (box) => box.width === 140 && box.height === 60,
          ),
          firstRowCount: boxes.filter((box) => box.y === boxes[0].y).length,
        };
      })
      .toEqual({ fixedSize: true, firstRowCount: width === 360 ? 2 : 1 });
    await page.screenshot({
      path: testInfo.outputPath(`clip-panel-${width}.png`),
    });
  }
  await page.evaluate(() => {
    (window as any).appStores.dockApi
      .get()
      .getPanel("panel-ClipList")
      .api.setSize({ width: 360 });
  });
  await page
    .getByRole("button", { name: "Inspect clip 16", exact: true })
    .click();
  await expect(page.getByLabel("Clip label", { exact: true })).toHaveValue(
    clips[6].label,
  );
});
