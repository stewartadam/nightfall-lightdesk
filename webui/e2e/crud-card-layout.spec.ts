// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Page } from "@playwright/test";
import type { Sequence, Timeline } from "../types";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Activates a dedicated list panel in the main dock group for visual checks. */
async function openCardPanel(page: Page, component: string) {
  await page.evaluate((componentName) => {
    const api = (window as any).appStores.dockApi.get();
    const id = `panel-${componentName}-card-layout`;
    api.addPanel({
      id,
      component: componentName,
      title: componentName,
      params: { initialPanelId: id },
      position: { referencePanel: "panel-FixtureGrid", direction: "within" },
    });
    api.getPanel(id).focus();
  }, component);
}

/** Exercises long card content, selection, rename sizing, and matching status/control footprints. */
test("timeline cards stay aligned and sequence loop tags match clip gears", async ({
  page,
}, testInfo) => {
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    const timeline = Object.values(stores.timelines.get())[0] as Timeline;
    const labels = [
      "Cruise",
      "TENDR",
      "Demo track (An extended live recording)",
      "What a Fool Believes — extended version",
    ];
    stores.timelines.set(
      Object.fromEntries(
        labels.map((label, index) => {
          const uid = `0000000000000000000000000000000${index + 1}`;
          return [
            uid,
            {
              ...timeline,
              identifiers: { uid, id: index === 3 ? 999999 : index + 1, label },
              audio_path:
                index === 1
                  ? ""
                  : `${index === 0 ? "demo-audio" : "demo-extended-live-recording"}.mp3`,
              tracks: index === 1 ? [] : timeline.tracks,
            },
          ];
        }),
      ),
    );
    const sequence = Object.values(stores.sequences.get())[0] as Sequence;
    stores.sequences.set({
      [sequence.identifiers.uid]: { ...sequence, wrap: true },
    });
  });

  await openCardPanel(page, "TimelinesPanel");
  const panel = page.locator('[data-panel-kind="timeline-list"]');
  const cards = panel.locator(".nf-crud-card");
  await expect(cards).toHaveCount(4);
  const longTitle = cards.nth(2).locator(".nf-timeline-card-title");
  await expect(longTitle).toHaveAttribute(
    "title",
    "Demo track (An extended live recording)",
  );
  await expect(cards.nth(1)).toContainText("No audio");
  await expect(cards.nth(1)).toContainText("0 tracks");
  for (const card of await cards.all()) {
    const bounds = (await card.boundingBox())!;
    expect(bounds.height).toBe(60);
    for (const child of await card.locator(":scope > div").all()) {
      const childBounds = (await child.boundingBox())!;
      expect(childBounds.y + childBounds.height).toBeLessThanOrEqual(
        bounds.y + bounds.height,
      );
      expect(childBounds.x + childBounds.width).toBeLessThanOrEqual(
        bounds.x + bounds.width,
      );
    }
    await expect(card.locator(".nf-timeline-card-title")).toHaveCSS(
      "height",
      "12px",
    );
  }
  await panel.getByRole("button", { name: "Toggle selection mode" }).click();
  await cards.first().click();
  await expect(cards.first()).toHaveAttribute("aria-pressed", "true");
  await panel.screenshot({ path: testInfo.outputPath("timeline-cards.png") });
  await cards.nth(2).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const editor = page.getByLabel("Timeline card label");
  await expect(editor).toBeFocused();
  const editorBounds = (await editor.boundingBox())!;
  const cardBounds = (await cards.nth(2).boundingBox())!;
  expect(editorBounds.x + editorBounds.width).toBeLessThanOrEqual(
    cardBounds.x + cardBounds.width,
  );
  await editor.press("Escape");

  await openCardPanel(page, "ClipList");
  const gear = page.getByRole("button", { name: /^Inspect clip / }).first();
  await expect(gear).toBeVisible();
  const gearBounds = (await gear.boundingBox())!;
  const gearIconBounds = (await gear.locator("svg").boundingBox())!;
  await openCardPanel(page, "SequenceList");
  const loop = page.locator('[data-sequence-tag="wrap"]:visible').first();
  await expect(loop).toBeVisible();
  const loopBounds = (await loop.boundingBox())!;
  const loopIconBounds = (await loop.locator("svg").boundingBox())!;
  expect(loopBounds.width).toBe(gearBounds.width);
  expect(loopBounds.height).toBe(gearBounds.height);
  expect(loopIconBounds.width).toBe(gearIconBounds.width);
  expect(loopIconBounds.height).toBe(gearIconBounds.height);
  await loop.locator("xpath=ancestor::button[1]").screenshot({
    path: testInfo.outputPath("sequence-loop-card.png"),
  });
});
