// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  DmxValueResolution,
  type GetFixtureProfileResponse,
  MergeStrategy,
  ParameterValuePolarity,
} from "../types/index";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

const OWNED_FIXTURE_PROFILE = {
  info: {
    make: "E2E Lighting",
    model: "Mode Probe",
    modes: ["Default", "Extended"],
    source_format: "GDTF",
    asset_etag: "mode-probe-v1",
  },
  requested_mode: "Extended",
  fixture: {
    identifiers: {
      id: 0,
      uid: "fixture-library-mode-probe",
      label: "Mode Probe",
    },
    make: "E2E Lighting",
    model: "Mode Probe",
    mode: "Extended",
    elements: [
      {
        label: "Head",
        parameters: [
          {
            resolution: DmxValueResolution.Coarse,
            attribute: { type: "Intensity" },
            value_polarity: ParameterValuePolarity.Unsigned,
            min: 0,
            max: 255,
            offset: { type: "Absolute", data: { value: 0 } },
            is_inverted: false,
            is_snap: false,
            merge_type: MergeStrategy.HTP,
            use_grandmaster: true,
          },
          {
            resolution: DmxValueResolution.Fine,
            attribute: { type: "Pan" },
            value_polarity: ParameterValuePolarity.Signed,
            min: 0,
            max: 65535,
            offset: { type: "Relative", data: { offset: -12 } },
            is_inverted: true,
            is_snap: false,
            merge_type: MergeStrategy.LTP,
            use_grandmaster: false,
          },
        ],
      },
      {
        label: "Cell",
        parameters: [
          {
            resolution: DmxValueResolution.Coarse,
            attribute: { type: "VirtualIntensity" },
            value_polarity: ParameterValuePolarity.Unsigned,
            min: 0,
            max: 255,
            offset: { type: "Absolute", data: { value: 0 } },
            is_inverted: false,
            is_snap: false,
            merge_type: MergeStrategy.HTP,
            use_grandmaster: true,
          },
          {
            resolution: DmxValueResolution.Coarse,
            attribute: { type: "Red" },
            value_polarity: ParameterValuePolarity.Unsigned,
            min: 0,
            max: 255,
            offset: { type: "AbsolutePercent", data: { value: 0.1 } },
            is_inverted: false,
            is_snap: true,
            merge_type: MergeStrategy.LTP,
            use_grandmaster: false,
          },
        ],
      },
    ],
  },
  geometry: undefined,
} satisfies GetFixtureProfileResponse;

/**
 * Opens the app with a clean persisted layout for deterministic panel placement.
 */
async function openApp(page: Page) {
  await page.setViewportSize({ width: 1800, height: 1100 });
  await page.addInitScript(() => {
    window.localStorage.removeItem("nightfall-ui-layouts");
  });
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await prepareStoreSeededTestApp(page);
}

/**
 * Waits for the Dockview API bridge exposed in E2E mode.
 */
async function waitForDockApi(page: Page) {
  await page.waitForFunction(() =>
    Boolean((window as any).appStores?.dockApi?.get?.()),
  );
}

/**
 * Adds a Dockview panel and makes it active before returning.
 */
async function addPanel(
  page: Page,
  panel: {
    id: string;
    component: string;
    title: string;
    params?: Record<string, unknown>;
    position?: Record<string, unknown>;
  },
) {
  await waitForDockApi(page);
  await page.evaluate((panel) => {
    const api = (window as any).appStores.dockApi.get();
    const existingPanel = api.getPanel(panel.id);
    if (existingPanel) {
      existingPanel.api.close();
    }
    const nextPanel = api.addPanel({
      id: panel.id,
      component: panel.component,
      title: panel.title,
      params: panel.params ?? {},
      position: panel.position ?? {
        referencePanel: "panel-FixtureGrid",
        direction: "within",
      },
    });
    nextPanel.api.setActive();
    nextPanel.focus();
  }, panel);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.dockApi.get().activePanel?.id,
      ),
    )
    .toBe(panel.id);
}

/**
 * Finds the TanStack grid containing the fixture-library seeded row text.
 */
function gridContaining(page: Page, text: string | RegExp): Locator {
  return page
    .locator('[data-grid-kind="tanstack"]')
    .filter({ hasText: text })
    .last();
}

/**
 * Seeds one fixture-library entry with multiple modes for properties-panel selection.
 */
async function seedFixtureLibrary(page: Page) {
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    stores.fixtureLibrary.set([
      {
        make: "E2E Lighting",
        model: "Mode Probe",
        modes: ["Default", "Extended"],
        source_format: "GDTF",
        asset_etag: "mode-probe-v1",
      },
      {
        make: "E2E Lighting",
        model: "Mode Switch",
        modes: ["5 channel", "308 Channel"],
        source_format: "GDTF",
        asset_etag: "mode-switch-v1",
      },
    ]);
  });
}

/**
 * Seeds the parsed fixture profile returned for the selected fixture-library mode.
 */
async function seedFixtureProfile(page: Page) {
  await page.evaluate(async (profile) => {
    const { fixtureProfile } = await import(
      /* @vite-ignore */ "/state/appStores.ts"
    );
    fixtureProfile.set(profile);
  }, OWNED_FIXTURE_PROFILE);
}

/**
 * Seeds a completed profile response without parsed fixture data.
 */
async function seedNullFixtureProfile(page: Page) {
  await page.evaluate(async () => {
    const { fixtureProfile } = await import(
      /* @vite-ignore */ "/state/appStores.ts"
    );
    fixtureProfile.set({
      info: {
        make: "E2E Lighting",
        model: "Mode Probe",
        modes: ["Default", "Extended"],
        source_format: "GDTF",
        asset_etag: "mode-probe-v1",
      },
      requested_mode: "Extended",
      fixture: undefined,
      geometry: undefined,
    });
  });
}

/**
 * Opens Fixture Library beside Properties, selects the seeded row, and returns the mode selector.
 */
async function openFixtureLibraryProperties(page: Page): Promise<Locator> {
  await openApp(page);
  await seedFixtureLibrary(page);

  await addPanel(page, {
    id: "panel-FixtureLibrary-mode-parameters",
    component: "FixtureLibrary",
    title: "Fixture Library",
    params: { initialPanelId: "panel-FixtureLibrary-mode-parameters" },
  });
  await addPanel(page, {
    id: "panel-PropertiesInspector",
    component: "PropertiesInspector",
    title: "Properties",
    position: {
      referencePanel: "panel-FixtureLibrary-mode-parameters",
      direction: "right",
    },
  });

  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-FixtureLibrary-mode-parameters")?.focus();
  });

  const fixtureLibraryGrid = gridContaining(page, "E2E Lighting");
  await expect(fixtureLibraryGrid).toBeVisible();
  await fixtureLibraryGrid.locator("#tanstack-cell-0-0").click();
  await page.evaluate(() => {
    const propertiesPanel = (window as any).appStores.dockApi
      .get()
      .getPanel("panel-PropertiesInspector");
    propertiesPanel?.api.setActive();
    propertiesPanel?.focus();
  });

  const modeSelect = page.getByLabel("Mode", { exact: true });
  await expect(modeSelect).toBeVisible();
  return modeSelect;
}

/**
 * Verifies the Fixture Library properties panel renders selected-mode parameter metadata.
 */
test("fixture library properties inspect selected mode parameters", async ({
  page,
}) => {
  const modeSelect = await openFixtureLibraryProperties(page);
  await modeSelect.selectOption("Extended");
  await seedFixtureProfile(page);

  await expect(page.getByText("Mode Parameters")).toBeVisible();
  await expect(page.getByText("Extended").last()).toBeVisible();
  await expect(page.getByText("4 ch")).toBeVisible();
  await expect(page.getByText("Head #1")).toBeVisible();
  await expect(page.getByText("Cell #2")).toBeVisible();
  await expect(page.getByRole("cell", { name: "Pan" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "2-3" })).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Virtual", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Offset -12")).toBeVisible();
  await expect(page.getByText("Inverted")).toBeVisible();
  await expect(page.getByText("Snap", { exact: true })).toBeVisible();

  await modeSelect.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath("fixture-library-mode-parameters.png"),
    fullPage: true,
  });
});

/**
 * Verifies completed profile responses without fixture data leave loading state.
 */
test("fixture library properties show empty state for null profile fixture", async ({
  page,
}) => {
  const modeSelect = await openFixtureLibraryProperties(page);
  await modeSelect.selectOption("Extended");
  await seedNullFixtureProfile(page);

  await expect(
    page.getByText("This mode has no parsed parameter configuration."),
  ).toBeVisible();
  await expect(
    page.getByText("Loading mode parameter configuration"),
  ).toHaveCount(0);
  await expect(page.getByText("E2E Lighting Mode Probe").last()).toBeVisible();
  await expect(page.getByText("DMX footprint")).toHaveCount(0);
});

/**
 * Verifies selecting a different fixture resets both mode state and select UI.
 */
test("fixture library properties reset selected mode for new fixtures", async ({
  page,
}) => {
  const modeSelect = await openFixtureLibraryProperties(page);
  await modeSelect.selectOption("Extended");
  await expect(modeSelect).toHaveValue("Extended");

  const fixtureLibraryGrid = gridContaining(page, "Mode Switch");
  await expect(fixtureLibraryGrid.locator("#tanstack-cell-1-1")).toHaveText(
    "Mode Switch",
  );
  await fixtureLibraryGrid.locator("#tanstack-cell-1-1").click();

  await expect(modeSelect).toHaveValue("5 channel");
  await expect(page.getByTestId("fixture-library-selected-mode")).toHaveText(
    "5 channel",
  );
});
