// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.setTimeout(120_000);

type TrackingFlagsSeed = {
  cueId: number;
  cueUid: string;
  fixtureId: number;
  fixtureUid: string;
  sequenceId: number;
  sequenceUid: string;
};

/** Verifies an affordance fills its grid cell without inherited wrapper padding. */
async function expectAffordanceFillsCell(cell: Locator): Promise<void> {
  const affordance = cell.locator('[data-grid-dropdown-affordance="true"]');
  await expect(affordance).toHaveCount(1);
  await expect
    .poll(async () => {
      const cellBox = await cell.boundingBox();
      const affordanceBox = await affordance.boundingBox();
      if (!cellBox || !affordanceBox) return false;
      return (
        Math.abs(cellBox.x - affordanceBox.x) < 2 &&
        Math.abs(cellBox.y - affordanceBox.y) < 2 &&
        Math.abs(cellBox.width - affordanceBox.width) < 2 &&
        Math.abs(cellBox.height - affordanceBox.height) < 2
      );
    })
    .toBe(true);
}

/** Scrolls the sequence grid horizontally until the Tracking cells are rendered. */
async function scrollTrackingColumnIntoView(table: Locator): Promise<void> {
  await table.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
}

/** Focuses a Dockview panel by stable panel id rather than displayed tab title. */
async function focusDockPanel(page: Page, panelId: string): Promise<void> {
  await page.evaluate((targetPanelId) => {
    const api = (window as any).appStores.dockApi.get();
    const panel = api.getPanel(targetPanelId);
    if (!panel) {
      throw new Error(`Expected Dockview panel ${targetPanelId}`);
    }
    panel.api.setActive();
    panel.focus();
  }, panelId);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.dockApi.get().activePanel?.id,
      ),
    )
    .toBe(panelId);
  if (panelId === "panel-CueEditor-tracking-flags-e2e") {
    await expect(
      page.locator(
        `[data-panel-id="${panelId}"] [data-grid-owner="cue-editor"]`,
      ),
    ).toBeVisible();
  }
}

/** Expands the properties edge group while preserving the inspected editor. */
async function expandPropertiesPanel(
  page: Page,
  inspectedPanelId: string,
): Promise<void> {
  await page.evaluate(async (panelId) => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-PropertiesInspector")?.api.setActive();
    api.setEdgeGroupVisible("right", true);
    api.getEdgeGroup("right")?.expand();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        const inspectedPanel = api.getPanel(panelId);
        inspectedPanel?.api.setActive();
        inspectedPanel?.focus();
        resolve();
      });
    });
  }, inspectedPanelId);
}

/** Opens the tracking-flags scenario against an empty backend showfile. */
async function openOwnedTrackingFlagsApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      Boolean((window as any).appStores?.dockApi?.get?.()) &&
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.cues?.get) &&
      Boolean((window as any).appStores?.sequences?.get),
  );
  await expect
    .poll(() =>
      page.evaluate(() => ({
        cues: Object.keys((window as any).appStores.cues.get()).length,
        fixtures: Object.keys((window as any).appStores.fixtures.get()).length,
        sequences: Object.keys((window as any).appStores.sequences.get())
          .length,
      })),
    )
    .toEqual({ cues: 0, fixtures: 0, sequences: 0 });
}

/** Stores the complete fixture, cue, and sequence rendered by the test. */
async function storeOwnedTrackingFlagsData(
  page: Page,
): Promise<TrackingFlagsSeed> {
  const seed = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const sequenceId = Math.floor(900_000 + Math.random() * 50_000);
    const cueId = Math.floor(100 + Math.random() * 800);
    const fixtureId = Math.floor(600_000 + Math.random() * 100_000);
    const sequenceUid = crypto.randomUUID().replaceAll("-", "");
    const cueUid = crypto.randomUUID().replaceAll("-", "");
    const setupCueUid = crypto.randomUUID().replaceAll("-", "");
    const releaseCueUid = crypto.randomUUID().replaceAll("-", "");
    const fixedZero = { type: "Fixed", data: { secs: 0, nanos: 0 } };

    /** Builds an empty metadata cue for a sequence boundary row. */
    const metaCue = (
      uid: string,
      label: string,
      trackingMode: object,
    ): object => ({
      identifiers: { uid, id: 0, label },
      trigger: { type: "Manual" },
      transitions: {},
      transitions_by_attribute: {},
      instructions: [],
      parts: [],
      references: {},
      tracking_flags: "HTP",
      tracking_mode: trackingMode,
    });

    /** Stores one owned cue-domain record and rejects backend failures. */
    const store = async (message: object): Promise<void> => {
      const result = await stores.sendAndAwait(message);
      if (result.outcome.type !== "Succeeded") {
        throw new Error(
          `failed to store owned tracking-flags data: ${JSON.stringify(result)}`,
        );
      }
    };

    await store({
      module: "FixtureLibraryCommand",
      command: {
        type: "CreateFixtureFromLibrary",
        data: {
          id: fixtureId,
          make: "Generic",
          model: "Moving Head RGBW",
          mode: "Spot",
          label: `Owned Tracking Flags Fixture ${fixtureId}`,
          update_existing_ids: [],
          update_existing_only: false,
        },
      },
    });
    let fixture: any;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      fixture = (Object.values(stores.fixtures.get()) as Array<any>).find(
        (candidate) => candidate.identifiers.id === fixtureId,
      );
      if (fixture) break;
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    if (!fixture) {
      throw new Error("owned tracking-flags fixture did not load");
    }

    await store({
      module: "CueCommand",
      command: {
        type: "StoreCue",
        data: {
          identifiers: {
            uid: cueUid,
            id: cueId,
            label: "Tracking Flags E2E Cue",
          },
          trigger: { type: "Manual" },
          transitions: {},
          transitions_by_attribute: {},
          instructions: [
            {
              selection: {
                source: {
                  type: "Resolved",
                  data: [
                    {
                      fixture_uid: fixture.identifiers.uid,
                      index: null,
                    },
                  ],
                },
                clauses: [],
              },
              cue_instruction: {
                values: {
                  Intensity: {
                    type: "Inline",
                    data: { type: "Absolute", data: { value: 128 } },
                  },
                },
                transitions: {},
                transitions_by_attribute: {},
                transitions_by_fixture_attribute: [],
              },
            },
          ],
          parts: [],
          references: {},
          tracking_flags: "HTP",
        },
      },
    });
    await store({
      module: "CueCommand",
      command: {
        type: "StoreSequence",
        data: {
          identifiers: {
            uid: sequenceUid,
            id: sequenceId,
            label: "Owned Tracking Flags Sequence",
          },
          steps: [cueUid],
          wrap: false,
          release_on_start: false,
          setup_cue: metaCue(setupCueUid, "Setup", {
            type: "Flags",
            data: { __Composed__: 7 },
          }),
          release_cue: metaCue(releaseCueUid, "Release", {
            type: "Inherit",
          }),
          default_timing: {
            delay_in: fixedZero,
            fade_in: fixedZero,
            curve_in: "Linear",
            delay_out: fixedZero,
            fade_out: fixedZero,
            curve_out: "Linear",
          },
          tracking_mode: { type: "Flags", data: { __Composed__: 7 } },
        },
      },
    });

    (window as any).__trackingFlagsCueId = cueId;
    (window as any).__trackingFlagsCueUid = cueUid;
    (window as any).__trackingFlagsFixtureId = fixtureId;
    (window as any).__trackingFlagsSequenceId = sequenceId;
    (window as any).__trackingFlagsSequenceUid = sequenceUid;
    return {
      cueId,
      cueUid,
      fixtureId,
      fixtureUid: fixture.identifiers.uid,
      sequenceId,
      sequenceUid,
    };
  });

  await expect
    .poll(() =>
      page.evaluate(({ cueUid, fixtureId, sequenceUid }) => {
        const stores = (window as any).appStores;
        return {
          cue: stores.cues.get()[cueUid]?.identifiers.uid,
          fixture: (Object.values(stores.fixtures.get()) as Array<any>).find(
            (candidate) => candidate.identifiers.id === fixtureId,
          )?.identifiers.uid,
          sequence: stores.sequences.get()[sequenceUid]?.identifiers.uid,
          steps: stores.sequences.get()[sequenceUid]?.steps,
        };
      }, seed),
    )
    .toEqual({
      cue: seed.cueUid,
      fixture: seed.fixtureUid,
      sequence: seed.sequenceUid,
      steps: [seed.cueUid],
    });
  return seed;
}

/** Deletes all fixture and cue-domain data owned by the current scenario. */
async function cleanupOwnedTrackingFlagsData(page: Page): Promise<void> {
  const results = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const cueId = (window as any).__trackingFlagsCueId;
    const fixtureId = (window as any).__trackingFlagsFixtureId;
    const sequenceId = (window as any).__trackingFlagsSequenceId;
    if (
      typeof stores?.sendAndAwait !== "function" ||
      !Number.isFinite(cueId) ||
      !Number.isFinite(fixtureId) ||
      !Number.isFinite(sequenceId)
    ) {
      return null;
    }

    const cueResult = await stores.sendAndAwait({
      module: "CueCommand",
      command: {
        type: "DeleteCue",
        data: { sequence_id: sequenceId, cue_id: cueId },
      },
    });
    const sequenceResult = await stores.sendAndAwait({
      module: "CueCommand",
      command: { type: "DeleteSequence", data: sequenceId },
    });
    const fixtureResult = await stores.sendAndAwait({
      module: "FixtureCommand",
      command: { type: "DeleteFixture", data: fixtureId },
    });
    return [cueResult, sequenceResult, fixtureResult];
  });
  if (!results) return;
  for (const result of results) {
    expect(result.outcome.type, JSON.stringify(result)).toBe("Succeeded");
  }
  await expect
    .poll(() =>
      page.evaluate(() => ({
        cues: Object.keys((window as any).appStores.cues.get()).length,
        fixtures: Object.keys((window as any).appStores.fixtures.get()).length,
        sequences: Object.keys((window as any).appStores.sequences.get())
          .length,
      })),
    )
    .toEqual({ cues: 0, fixtures: 0, sequences: 0 });
}

/** Removes every cue-domain record created by the tracking-flags scenario. */
test.afterEach(async ({ page }) => {
  await cleanupOwnedTrackingFlagsData(page);
});

/**
 * Verifies cue tracking flags are editable in properties and in the sequence sheet.
 */
test("cue tracking flags render in properties and sequence editor", async ({
  backendSlot,
  page,
}) => {
  await openOwnedTrackingFlagsApp(page, backendSlot.backendPort);
  const seed = await storeOwnedTrackingFlagsData(page);

  await page.evaluate(({ cueUid, sequenceUid }) => {
    const stores = (window as any).appStores;
    const cues = stores.cues.get();
    const sequences = stores.sequences.get();
    const sequence = sequences[sequenceUid];
    const cue = cues[cueUid];
    if (!sequence || !cue) {
      throw new Error("expected owned tracking-flags sequence and cue");
    }

    stores.cues.set({
      ...cues,
      [cueUid]: {
        ...cue,
        identifiers: {
          ...cue.identifiers,
          label: "Tracking Flags E2E Cue",
        },
        tracking_flags: { __Composed__: 1 },
      },
    });
    stores.sequences.set({
      ...sequences,
      [sequence.identifiers.uid]: {
        ...sequence,
        setup_cue: {
          ...sequence.setup_cue,
          tracking_flags: { __Composed__: 7 },
        },
        release_cue: {
          ...sequence.release_cue,
          tracking_flags: { __Composed__: 1 },
        },
        steps: [cueUid],
      },
    });

    const api = stores.dockApi.get();
    if (!api.getPanel("panel-PropertiesInspector")) {
      api.addPanel({
        id: "panel-PropertiesInspector",
        component: "PropertiesInspector",
        title: "Properties",
        params: {},
      });
    }
    for (const panel of [...api.panels]) {
      if (
        panel.id.startsWith("panel-CueEditor") ||
        panel.id.startsWith("panel-SequenceEditor")
      ) {
        panel.api.close();
      }
    }
    const position = {
      referencePanel: "panel-FixtureGrid",
      direction: "within",
    } as const;
    api.addPanel({
      id: "panel-CueEditor-tracking-flags-e2e",
      component: "CueEditor",
      title: "Tracking Cue E2E",
      position,
      params: {
        initialPanelId: "panel-CueEditor-tracking-flags-e2e",
        initialCueUid: cueUid,
      },
    });
    api.addPanel({
      id: "panel-CueEditor-setup-tracking-flags-e2e",
      component: "CueEditor",
      title: "Tracking Setup E2E",
      position,
      params: {
        initialPanelId: "panel-CueEditor-setup-tracking-flags-e2e",
        initialCueUid: sequence.setup_cue.identifiers.uid,
        initialSetupSequenceUid: sequence.identifiers.uid,
      },
    });
    api.addPanel({
      id: "panel-CueEditor-release-tracking-flags-e2e",
      component: "CueEditor",
      title: "Tracking Release E2E",
      position,
      params: {
        initialPanelId: "panel-CueEditor-release-tracking-flags-e2e",
        initialCueUid: sequence.release_cue.identifiers.uid,
        initialReleaseSequenceUid: sequence.identifiers.uid,
      },
    });
    api.addPanel({
      id: "panel-SequenceEditor-tracking-flags-e2e",
      component: "SequenceEditor",
      title: "Tracking Sequence E2E",
      position,
      params: {
        initialPanelId: "panel-SequenceEditor-tracking-flags-e2e",
        initialSequenceUid: sequence.identifiers.uid,
      },
    });
    const cuePanel = api.getPanel("panel-CueEditor-tracking-flags-e2e");
    cuePanel?.api.setActive();
    cuePanel?.focus();
  }, seed);

  await focusDockPanel(page, "panel-CueEditor-tracking-flags-e2e");
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    const cues = stores.cues.get();
    const sequences = stores.sequences.get();
    const cueUid = (window as any).__trackingFlagsCueUid;
    const sequenceUid = (window as any).__trackingFlagsSequenceUid;
    const cue = cues[cueUid];
    const sequence = sequences[sequenceUid];
    if (!cueUid || !sequenceUid || !cue || !sequence) {
      throw new Error("Expected mounted tracking cue and sequence");
    }

    const trackingFlags = { __Composed__: 1 };
    stores.cues.set({
      ...cues,
      [cueUid]: {
        ...cue,
        identifiers: {
          ...cue.identifiers,
          label: "Tracking Flags E2E Cue",
        },
        tracking_flags: trackingFlags,
        tracking_mode: {
          type: "Flags",
          data: trackingFlags,
        },
      },
    });
    stores.sequences.set({
      ...sequences,
      [sequenceUid]: {
        ...sequence,
        setup_cue: {
          ...sequence.setup_cue,
          tracking_flags: { __Composed__: 7 },
        },
        release_cue: {
          ...sequence.release_cue,
          tracking_flags: { __Composed__: 1 },
        },
        steps: [cueUid],
      },
    });
  });
  await expandPropertiesPanel(page, "panel-CueEditor-tracking-flags-e2e");
  await focusDockPanel(page, "panel-CueEditor-tracking-flags-e2e");
  const propertiesInspector = page.locator(
    '[data-panel-id="panel-PropertiesInspector"]',
  );
  await expect(
    propertiesInspector.getByRole("heading", {
      name: /^Cue \d+(\.\d+)?$/,
      level: 3,
    }),
  ).toBeVisible();
  const propertiesTrackingSelect = propertiesInspector.locator(
    'select[id^="cue-properties-tracking-flags-"]',
  );
  await expect(propertiesTrackingSelect).toHaveAttribute("multiple", "");
  const propertiesTrackingToggle = propertiesInspector
    .getByRole("button", { name: "Intensity" })
    .first();
  await expect(propertiesTrackingToggle).toBeVisible();
  await propertiesTrackingToggle.click();

  const openedDropdown = page.locator("[data-hs-select-dropdown].opened");
  await expect(openedDropdown).toBeVisible();
  await expect
    .poll(async () => {
      const toggleBox = await propertiesTrackingToggle.boundingBox();
      const dropdownBox = await openedDropdown.boundingBox();
      if (!toggleBox || !dropdownBox) return false;
      return (
        Math.abs(dropdownBox.x - toggleBox.x) < 32 &&
        dropdownBox.y > toggleBox.y
      );
    })
    .toBe(true);

  await expect
    .poll(() =>
      openedDropdown
        .locator('[data-value="HTP"]')
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    )
    .toBe("rgba(0, 0, 0, 0)");

  const attributesOption = openedDropdown.locator('[data-value="LTP"]');
  const attributesBackground = await attributesOption.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await attributesOption.hover();
  await expect
    .poll(() =>
      attributesOption.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      ),
    )
    .not.toBe(attributesBackground);

  await openedDropdown.getByText("Attributes", { exact: true }).click();
  await expect
    .poll(async () => {
      const toggleBox = await propertiesTrackingToggle.boundingBox();
      const dropdownBox = await openedDropdown.boundingBox();
      if (!toggleBox || !dropdownBox) return false;
      return (
        Math.abs(dropdownBox.x - toggleBox.x) < 32 &&
        dropdownBox.y > toggleBox.y
      );
    })
    .toBe(true);

  const openDropdownBox = await openedDropdown.boundingBox();
  if (!openDropdownBox) throw new Error("expected tracking dropdown bounds");
  await page.mouse.click(openDropdownBox.x + 16, openDropdownBox.y - 12);
  await expect(openedDropdown).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Intensity and Attributes" }),
  ).toBeVisible();

  await focusDockPanel(page, "panel-CueEditor-setup-tracking-flags-e2e");
  await expandPropertiesPanel(page, "panel-CueEditor-setup-tracking-flags-e2e");
  await focusDockPanel(page, "panel-CueEditor-setup-tracking-flags-e2e");
  await expect(
    propertiesInspector.locator('select[id^="cue-properties-tracking-flags-"]'),
  ).toHaveCount(0);

  await focusDockPanel(page, "panel-CueEditor-release-tracking-flags-e2e");
  await expandPropertiesPanel(
    page,
    "panel-CueEditor-release-tracking-flags-e2e",
  );
  await focusDockPanel(page, "panel-CueEditor-release-tracking-flags-e2e");
  await expect(
    propertiesInspector.locator('select[id^="cue-properties-tracking-flags-"]'),
  ).toHaveCount(0);

  await page.evaluate(() => {
    const stores = (window as any).appStores;
    const cues = stores.cues.get();
    const cueUid = (window as any).__trackingFlagsCueUid;
    const cue = cues[cueUid];
    if (!cueUid || !cue)
      throw new Error("Expected tracking cue before grid edit");
    stores.cues.set({
      ...cues,
      [cueUid]: {
        ...cue,
        tracking_flags: { __Composed__: 3 },
      },
    });
  });

  await focusDockPanel(page, "panel-SequenceEditor-tracking-flags-e2e");
  const sequenceGrid = page.locator(
    '[data-panel-id="panel-SequenceEditor-tracking-flags-e2e"] [data-grid-owner="sequence-editor"]',
  );
  const table = sequenceGrid.locator('[data-grid-kind="tanstack"]');
  const trackingHeader = table.locator(
    '[data-grid-header-id="tanstack-header-tracking"]',
  );
  await expect(trackingHeader).toBeVisible();
  await scrollTrackingColumnIntoView(table);
  const setupLabelCellId = await table
    .locator('[data-grid-column-key="label"]')
    .filter({ hasText: "Setup" })
    .first()
    .getAttribute("id");
  const setupRowIndex = Number(setupLabelCellId?.split("-").at(-1));
  if (!Number.isFinite(setupRowIndex)) {
    throw new Error("Expected setup row in sequence editor");
  }
  const setupTrackingCell = table.locator(
    `[data-grid-column-key="tracking"][data-grid-row-index="${setupRowIndex}"]`,
  );
  await expect(setupTrackingCell).toContainText("All");
  await expect(
    setupTrackingCell.locator('select[aria-label="Choose tracking mode"]'),
  ).toHaveCount(0);
  await expect(
    setupTrackingCell.locator('select[aria-label="Choose tracking flags"]'),
  ).toHaveCount(0);
  await expect(
    setupTrackingCell.locator('[data-grid-dropdown-affordance="true"]'),
  ).toHaveCount(0);
  await expect(setupTrackingCell.getByRole("button")).toHaveCount(0);

  const releaseLabelCellId = await table
    .locator('[data-grid-column-key="label"]')
    .filter({ hasText: "Release" })
    .first()
    .getAttribute("id");
  const releaseRowIndex = Number(releaseLabelCellId?.split("-").at(-1));
  if (!Number.isFinite(releaseRowIndex)) {
    throw new Error("Expected release row in sequence editor");
  }
  const releaseTrackingCell = table.locator(
    `[data-grid-column-key="tracking"][data-grid-row-index="${releaseRowIndex}"]`,
  );
  await expect(
    releaseTrackingCell.locator('select[aria-label="Choose tracking mode"]'),
  ).toHaveCount(0);
  await expect(
    releaseTrackingCell.locator('select[aria-label="Choose tracking flags"]'),
  ).toHaveCount(0);
  await expect(
    releaseTrackingCell.locator('[data-grid-dropdown-affordance="true"]'),
  ).toHaveCount(1);
  await expectAffordanceFillsCell(releaseTrackingCell);
  await expect(releaseTrackingCell.getByRole("button")).toHaveCount(0);
  await expect(releaseTrackingCell).toContainText("All");

  const labelCellId = await table
    .locator('[data-grid-column-key="label"]')
    .filter({ hasText: "Tracking Flags E2E Cue" })
    .first()
    .getAttribute("id");
  const cueRowIndex = Number(labelCellId?.split("-").at(-1));
  if (!Number.isFinite(cueRowIndex)) {
    throw new Error("Expected tracking cue row in sequence editor");
  }
  const trackingCell = table.locator(
    `[data-grid-column-key="tracking"][data-grid-row-index="${cueRowIndex}"]`,
  );
  await expect(trackingCell).toContainText("Intensity");
  await expect(trackingCell).toContainText("Attributes");
  await expect(
    trackingCell.locator('select[aria-label="Choose tracking flags"]'),
  ).toHaveCount(0);
  await expect(
    trackingCell.locator('[data-grid-dropdown-affordance="true"]'),
  ).toHaveCount(1);
  await expectAffordanceFillsCell(trackingCell);
  await expect(trackingCell.getByRole("button")).toHaveCount(0);

  await trackingCell.click();
  await expect(trackingCell).toHaveAttribute("data-selected", "true");
  await expect(page.locator("[data-hs-select-dropdown].opened")).toHaveCount(0);
  await expect(
    trackingCell.locator('[data-grid-dropdown-affordance="true"]'),
  ).toHaveCount(1);
  await expectAffordanceFillsCell(trackingCell);
  await expect(trackingCell.getByRole("button")).toHaveCount(0);

  await trackingCell.dblclick();
  const sequenceDropdown = page.locator("[data-hs-select-dropdown].opened");
  await expect(sequenceDropdown).toBeVisible();
  await expect(
    trackingCell.locator('[data-grid-dropdown-affordance="true"]'),
  ).toHaveCount(0);
  await expect(
    trackingCell.locator('select[aria-label="Choose tracking mode"]'),
  ).toHaveValue("Flags");
  const sequenceTrackingToggle = trackingCell
    .getByRole("button", { name: /Intensity/ })
    .first();
  await expect(sequenceTrackingToggle).toBeVisible();
  await expect(trackingCell).toContainText("Intensity");
  await expect(trackingCell).toContainText("Attributes");
  await expect
    .poll(async () => {
      const toggleBox = await sequenceTrackingToggle.boundingBox();
      const dropdownBox = await sequenceDropdown.boundingBox();
      if (!toggleBox || !dropdownBox) return false;
      return (
        Math.abs(dropdownBox.x - toggleBox.x) < 32 &&
        dropdownBox.y > toggleBox.y
      );
    })
    .toBe(true);
  await sequenceDropdown.getByText("Effects", { exact: true }).click();
  await page.mouse.click(20, 20);
  await expect(sequenceDropdown).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const cues = (window as any).appStores.cues.get();
        const cue = cues[(window as any).__trackingFlagsCueUid];
        return cue?.tracking_flags?.__Composed__;
      }),
    )
    .toBe(7);
  await expect(
    trackingCell.locator('[data-grid-dropdown-affordance="true"]'),
  ).toHaveCount(1);
  await expect(trackingCell).toContainText("All");

  await trackingCell.dblclick();
  const reopenedSequenceDropdown = page.locator(
    "[data-hs-select-dropdown].opened",
  );
  await expect(reopenedSequenceDropdown).toBeVisible();
  const trackingSelect = trackingCell.locator(
    'select[aria-label="Choose tracking flags"]',
  );
  await expect(trackingSelect).toHaveAttribute("multiple", "");
  await trackingSelect.evaluate((element) => {
    const select = element as HTMLSelectElement;
    for (const option of Array.from(select.options)) {
      option.selected = option.value === "FX";
    }
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.mouse.click(20, 20);
  await expect(reopenedSequenceDropdown).toBeHidden();

  await expect
    .poll(() =>
      page.evaluate(() => {
        const cues = (window as any).appStores.cues.get();
        const cue = cues[(window as any).__trackingFlagsCueUid];
        return cue?.tracking_flags?.__Composed__;
      }),
    )
    .toBe(4);
  await expect(trackingCell).toContainText("Effects");
});
