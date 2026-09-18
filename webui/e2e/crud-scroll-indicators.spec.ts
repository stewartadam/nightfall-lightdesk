// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const panels = [
  { component: "SequenceList", label: "Sequences", store: "sequences" },
  { component: "TimelinesPanel", label: "Timelines", store: "timelines" },
  { component: "GroupsPanel", label: "Groups", store: "groups" },
  { component: "CueList", label: "Cues", store: "cues" },
  { component: "FxList", label: "FX", store: "fx" },
  { component: "ClipList", label: "Clips", store: "clips" },
];

for (const panel of panels) {
  /** Checks real card panels show hidden content, retain selection, and clear hints when content fits. */
  test(`${panel.label} card viewport indicates overflow`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
    await waitForDockviewApp(page);
    await page.evaluate(({ component, store }) => {
      const stores = (window as any).appStores;
      const sample = Object.values(stores[store].get())[0] as any;
      if (!sample) throw new Error(`Missing demo sample for ${store}`);
      const record = Array.isArray(sample) ? sample[0] : sample;
      stores[store].set(
        Object.fromEntries(
          Array.from({ length: 60 }, (_, index) => {
            const uid = (index + 1000).toString(16).padStart(32, "0");
            const value = {
              ...record,
              identifiers: {
                ...record.identifiers,
                uid,
                id: index + 1000,
                label: `Scroll sample ${index + 1}`,
              },
            };
            return [uid, Array.isArray(sample) ? [value, false] : value];
          }),
        ),
      );
      const api = stores.dockApi.get();
      const id = "card-scroll-check";
      api.addPanel({
        id,
        component,
        title: component,
        params: { initialPanelId: id },
        position: { referencePanel: "panel-FixtureGrid", direction: "within" },
      });
      api.getPanel(id).focus();
    }, panel);
    const panelRoot = page.locator(
      `[data-component="${panel.component}"][data-panel-id="card-scroll-check"]`,
    );
    const viewport = panelRoot.getByRole("region", {
      name: `${panel.label} scroll area`,
      exact: true,
    });
    const frame = viewport.locator("..");
    const bottom = frame.locator('[data-edge="bottom"]');
    const top = frame.locator('[data-edge="top"]');
    const content =
      panel.store === "sequences" || panel.store === "timelines"
        ? viewport.locator(":scope > div").first()
        : viewport;
    await expect(content).toHaveCSS("padding-top", "16px");
    await expect(viewport.locator(".nf-crud-card")).toHaveCount(60);
    await expect(bottom).toHaveCSS("opacity", "1");
    await expect(top).toHaveCSS("opacity", "0");
    await frame.screenshot({ path: testInfo.outputPath("cards-start.png") });
    await viewport.hover();
    await page.mouse.wheel(0, 250);
    await expect(top).toHaveCSS("opacity", "1");
    await expect(bottom).toHaveCSS("opacity", "1");
    await viewport.focus();
    await viewport.press("End");
    await expect(bottom).toHaveCSS("opacity", "0");
    await expect(top).toHaveCSS("opacity", "1");
    await frame.screenshot({ path: testInfo.outputPath("cards-end.png") });
    await page.evaluate((store) => {
      const atom = (window as any).appStores[store];
      atom.set(Object.fromEntries(Object.entries(atom.get()).slice(0, 1)));
    }, panel.store);
    await expect(viewport.locator(".nf-crud-card")).toHaveCount(1);
    await expect(top).toHaveCSS("opacity", "0");
    await expect(bottom).toHaveCSS("opacity", "0");
    const card = viewport.locator(".nf-crud-card");
    await panelRoot
      .getByRole("button", { name: "Toggle selection mode" })
      .click();
    await card.click();
    await expect(card).toHaveClass(/nf-crud-card-selected/);
    await panelRoot
      .getByRole("button", { name: "Switch to list view" })
      .click();
    await expect(content).toHaveCSS("padding-top", "0px");
    await expect(viewport.getByRole("grid")).toBeVisible();
    await expect(bottom).toHaveCSS("opacity", "0");
    await panelRoot
      .getByRole("button", { name: "Switch to grid view" })
      .click();
    await expect(card).toBeVisible();
    await expect(bottom).toHaveCSS("opacity", "0");
  });
}
