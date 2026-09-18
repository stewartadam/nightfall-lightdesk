// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

const TRACKING_CUE_UID = "71717171717171717171717171717171";

/**
 * Reads a CSS z-index value, treating non-numeric stacking as the default layer.
 */
function numericZIndex(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Returns the highest numeric z-index used by Dockview splitter sashes.
 */
async function highestDockviewSashZIndex(page: Page): Promise<number> {
  return page.locator(".dv-sash").evaluateAll((sashes) =>
    sashes.reduce((highest, sash) => {
      const zIndex = Number.parseInt(getComputedStyle(sash).zIndex, 10);
      return Number.isFinite(zIndex) ? Math.max(highest, zIndex) : highest;
    }, 0),
  );
}

/**
 * Reads the z-index for a global layer class without requiring a live overlay.
 */
async function layerClassZIndex(
  page: Page,
  className: string,
): Promise<number> {
  return page.evaluate((targetClassName) => {
    const element = document.createElement("div");
    element.className = targetClassName;
    element.style.position = "fixed";
    document.body.append(element);
    const zIndex = Number.parseInt(getComputedStyle(element).zIndex, 10);
    element.remove();
    return Number.isFinite(zIndex) ? zIndex : 0;
  }, className);
}

/**
 * Opens a cue with editable tracking flags in the Properties panel.
 */
async function openCueTrackingProperties(page: Page): Promise<void> {
  await page.evaluate((cueUid) => {
    const stores = (window as any).appStores;
    const fixtureUid = "72727272727272727272727272727272";
    const trackingFlags = { __Composed__: 1 };
    stores.attributeMetadata.set([
      {
        key: "Intensity",
        attribute: { type: "Intensity" },
        label: "Intensity",
        category: "Dimmer",
        sort_order: 0,
      },
    ]);
    stores.fixtures.set({
      [fixtureUid]: {
        identifiers: {
          id: 201,
          uid: fixtureUid,
          label: "Tracking Fixture",
        },
        make: "E2E",
        model: "Tracking",
        mode: "Default",
        elements: [
          {
            label: "Main",
            parameters: [
              {
                resolution: "Coarse",
                attribute: { type: "Intensity" },
                value_polarity: "Unsigned",
                min: 0,
                max: 255,
                offset: { type: "Absolute", data: { value: 0 } },
                is_inverted: false,
                is_snap: false,
                merge_type: "HTP",
                use_grandmaster: true,
              },
            ],
          },
        ],
      },
    });
    stores.parameters.set(
      new Map([
        [
          fixtureUid,
          {
            uid: fixtureUid,
            color: "rgb(0, 0, 0)",
            raw: { Intensity: 128 },
            relative: {},
            conflicts: new Set(),
            elements: [
              {
                elementIndex: 1,
                color: "rgb(0, 0, 0)",
                raw: { Intensity: 128 },
                relative: {},
              },
            ],
          },
        ],
      ]),
    );
    stores.cues.set({
      [cueUid]: {
        identifiers: {
          id: 101,
          uid: cueUid,
          label: "Tracking Dropdown Layering E2E",
        },
        trigger: { type: "Manual" },
        transitions: {},
        transitions_by_attribute: {},
        instructions: [
          {
            selection: {
              source: {
                type: "Resolved",
                data: [{ fixture_uid: fixtureUid, index: null }],
              },
              clauses: [],
            },
            cue_instruction: {
              values: {
                Intensity: {
                  type: "Inline",
                  data: {
                    type: "AbsolutePercent",
                    data: { value: 0.5 },
                  },
                },
              },
              transitions: {},
              transitions_by_attribute: {},
              transitions_by_fixture_attribute: [],
            },
          },
        ],
        parts: [],
        tracking_flags: trackingFlags,
        tracking_mode: { type: "Flags", data: trackingFlags },
      },
    });
    stores.cueDefinitionsLoaded.set(true);

    const api = stores.dockApi.get();
    if (!api.getPanel("panel-PropertiesInspector")) {
      api.addPanel({
        id: "panel-PropertiesInspector",
        component: "PropertiesInspector",
        title: "Properties",
        params: {},
      });
    }
    api.getPanel("panel-CueEditor-tracking-dropdown-layering-e2e")?.api.close();
    api.addPanel({
      id: "panel-CueEditor-tracking-dropdown-layering-e2e",
      component: "CueEditor",
      title: "Tracking Dropdown E2E",
      position: {
        referencePanel: "panel-FixtureGrid",
        direction: "within",
      },
      params: {
        initialPanelId: "panel-CueEditor-tracking-dropdown-layering-e2e",
        initialCueUid: cueUid,
      },
    });
    const cuePanel = api.getPanel(
      "panel-CueEditor-tracking-dropdown-layering-e2e",
    );
    cuePanel?.api.setActive();
    cuePanel?.focus();
  }, TRACKING_CUE_UID);

  await page.evaluate(() => {
    const panel = (window as any).appStores.dockApi
      .get()
      .getPanel("panel-CueEditor-tracking-dropdown-layering-e2e");
    panel?.api.setActive();
    panel?.focus();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.dockApi.get().activePanel?.id,
      ),
    )
    .toBe("panel-CueEditor-tracking-dropdown-layering-e2e");
  await expect(
    page.locator(
      '[data-panel-id="panel-CueEditor-tracking-dropdown-layering-e2e"] [data-grid-owner="cue-editor"]',
    ),
  ).toBeVisible();
  await page.evaluate(async () => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-PropertiesInspector")?.api.setActive();
    api.setEdgeGroupVisible("right", true);
    api.getEdgeGroup("right")?.expand();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        const cuePanel = api.getPanel(
          "panel-CueEditor-tracking-dropdown-layering-e2e",
        );
        cuePanel?.api.setActive();
        cuePanel?.focus();
        resolve();
      });
    });
  });
  await expect(
    page
      .locator('[data-panel-id="panel-PropertiesInspector"]:visible')
      .locator("h4")
      .filter({ hasText: "Tracking" }),
  ).toBeVisible();
}

/**
 * Verifies tracking option menus render above Dockview group dividers.
 */
test("tracking dropdown renders above dockview sashes", async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await prepareStoreSeededTestApp(page);

  await openCueTrackingProperties(page);

  const propertiesPanel = page.locator(
    '[data-panel-id="panel-PropertiesInspector"]:visible',
  );
  const trackingToggle = propertiesPanel
    .getByRole("button", { name: "Intensity" })
    .first();
  await expect(trackingToggle).toBeVisible();
  await trackingToggle.click();

  const dropdown = page.locator("[data-hs-select-dropdown].opened");
  await expect(dropdown).toBeVisible();
  await expect(dropdown).toHaveClass(/nightfall-popover-layer/);

  const dropdownZIndex = await dropdown.evaluate(
    (element) => getComputedStyle(element).zIndex,
  );
  expect(numericZIndex(dropdownZIndex)).toBeGreaterThan(
    await highestDockviewSashZIndex(page),
  );
  expect(numericZIndex(dropdownZIndex)).toBeLessThan(
    await layerClassZIndex(page, "z-[1200]"),
  );
  expect(numericZIndex(dropdownZIndex)).toBeLessThan(
    await layerClassZIndex(page, "nightfall-top-layer"),
  );
});
