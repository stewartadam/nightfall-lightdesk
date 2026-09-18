// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const SEQUENCE_EDITOR_PANEL_ID =
  "panel-SequenceEditor-create-tracking-mode-e2e";

interface OwnedSequence {
  identifiers: { id: number; uid: string; label: string };
  tracking_mode: unknown;
  setup_cue: { tracking_mode: unknown };
  release_cue: { tracking_mode: unknown };
}

/** Opens a unique blank showfile for one sequence tracking-mode scenario. */
async function openOwnedSequenceTrackingApp(page: Page): Promise<void> {
  const testInfo = test.info();
  const showfileName = `sequence-tracking-${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`;

  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");

  const openDialog = page.getByRole("dialog", { name: "Open Showfile" });
  await expect(openDialog).toBeVisible();
  await openDialog.getByRole("button", { name: "New showfile" }).click();
  const newDialog = page.getByRole("dialog", { name: "New Showfile" });
  await expect(newDialog).toBeVisible();
  await newDialog.getByLabel("Show name").fill(showfileName);
  await newDialog.getByRole("button", { name: "Create Show" }).click();
  await expect(newDialog).not.toBeVisible({ timeout: 10_000 });
  await waitForDockviewApp(page);
}

/** Waits for the stores needed by the sequence-list creation flow. */
async function waitForSequenceListStores(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      Boolean((window as any).appStores?.dockApi?.get?.()) &&
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.sequences?.get),
  );
}

/** Opens a dedicated sequence list panel for the creation test. */
async function openSequenceListPanel(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    const api = stores.dockApi.get();
    const panelId = "panel-SequenceList-create-tracking-mode-e2e";
    const referencePanel =
      api.getPanel("panel-FixtureGrid") ??
      api.panels.find(
        (candidate: any) => candidate.api.location.type === "grid",
      );
    const panel =
      api.getPanel(panelId) ??
      api.addPanel({
        id: panelId,
        component: "SequenceList",
        title: "Sequences",
        ...(referencePanel
          ? {
              position: {
                referencePanel: referencePanel.id,
                direction: "within",
              },
            }
          : {}),
        params: { initialPanelId: panelId },
      });
    panel.api.setActive();
    panel.focus();
  });
}

/** Creates one sequence through the Sequence list and returns its hydrated record. */
async function createSequenceFromList(page: Page): Promise<OwnedSequence> {
  await openSequenceListPanel(page);
  const beforeSequenceUids = await page.evaluate(() =>
    Object.keys((window as any).appStores.sequences.get()),
  );
  await page
    .locator('[data-panel-id="panel-SequenceList-create-tracking-mode-e2e"]')
    .getByRole("button", { name: "Add sequence" })
    .click();

  await expect
    .poll(
      () =>
        page.evaluate((previousUids) => {
          const existingUids = new Set(
            previousUids.map((uid) => uid.toLowerCase()),
          );
          return (
            (
              Object.values(
                (window as any).appStores.sequences.get(),
              ) as OwnedSequence[]
            )
              .filter(
                (sequence) =>
                  !existingUids.has(sequence.identifiers.uid.toLowerCase()),
              )
              .sort(
                (left, right) => right.identifiers.id - left.identifiers.id,
              )[0] ?? null
          );
        }, beforeSequenceUids),
      { timeout: 15_000 },
    )
    .not.toBeNull();

  return page.evaluate((previousUids) => {
    const existingUids = new Set(previousUids.map((uid) => uid.toLowerCase()));
    const sequence = (
      Object.values(
        (window as any).appStores.sequences.get(),
      ) as OwnedSequence[]
    )
      .filter(
        (candidate) =>
          !existingUids.has(candidate.identifiers.uid.toLowerCase()),
      )
      .sort((left, right) => right.identifiers.id - left.identifiers.id)[0];
    if (!sequence) throw new Error("Created sequence did not hydrate");
    return sequence;
  }, beforeSequenceUids);
}

/** Opens the created sequence editor and its properties panel. */
async function openCreatedSequenceProperties(
  page: Page,
  sequenceUid: string,
): Promise<void> {
  await page.evaluate((uid) => {
    const stores = (window as any).appStores;
    const api = stores.dockApi.get();
    const panelId = "panel-SequenceEditor-create-tracking-mode-e2e";
    api.getPanel(`sequence-editor-panel-${uid}`)?.api.close();
    api.getPanel(panelId)?.api.close();
    const referencePanel =
      api.getPanel("panel-FixtureGrid") ??
      api.panels.find(
        (candidate: any) => candidate.api.location.type === "grid",
      );
    const panel = api.addPanel({
      id: panelId,
      component: "SequenceEditor",
      title: "Tracking Mode Defaults E2E",
      ...(referencePanel
        ? {
            position: {
              referencePanel: referencePanel.id,
              direction: "within",
            },
          }
        : {}),
      params: {
        initialPanelId: panelId,
        initialSequenceUid: uid,
      },
    });
    if (!api.getPanel("panel-PropertiesInspector")) {
      api.addPanel({
        id: "panel-PropertiesInspector",
        component: "PropertiesInspector",
        title: "Properties",
        params: {},
      });
    }
    panel.api.setActive();
    panel.focus();
  }, sequenceUid);
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
}

/** Scrolls the sequence grid horizontally until the Tracking cells are rendered. */
async function scrollTrackingColumnIntoView(table: Locator) {
  await table.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
}

/** Deletes the sequence created by this spec. */
async function cleanupCreatedSequence(
  page: Page,
  sequence: OwnedSequence,
): Promise<void> {
  await page.evaluate(async ({ id }) => {
    const stores = (window as any).appStores;
    if (!stores?.sendAndAwait || !stores?.sequences?.get) return;
    await stores.sendAndAwait({
      module: "CueCommand",
      command: {
        type: "DeleteSequence",
        data: id,
      },
    });
  }, sequence.identifiers);
  await expect
    .poll(() =>
      page.evaluate(
        (uid) => !(window as any).appStores.sequences.get()[uid],
        sequence.identifiers.uid,
      ),
    )
    .toBe(true);
}

/** Verifies the sequence properties Tracking dropdown marks every flag for All. */
test("sequence properties tracking dropdown selects all default flags", async ({
  page,
}) => {
  await openOwnedSequenceTrackingApp(page);
  await waitForSequenceListStores(page);
  const sequenceTarget = await createSequenceFromList(page);

  try {
    await openCreatedSequenceProperties(page, sequenceTarget.identifiers.uid);
    await focusDockPanel(page, SEQUENCE_EDITOR_PANEL_ID);
    await expect(
      page.getByRole("tab", {
        name: `Sequence ${sequenceTarget.identifiers.id}: ${sequenceTarget.identifiers.label}`,
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "Properties", exact: true }).click();
    const sequenceTrackingSelect = page.locator(
      'select[id^="sequence-properties-tracking-flags-"]',
    );
    await expect(sequenceTrackingSelect).toHaveAttribute("multiple", "");
    await expect(
      sequenceTrackingSelect
        .locator("xpath=ancestor::div[contains(@class, 'hs-select')][1]")
        .getByRole("button", { name: "Sequence tracking flags", exact: true }),
    ).toBeVisible();
    const trackingToggle = page.getByRole("button", {
      name: "Sequence tracking flags",
      exact: true,
    });
    await expect(trackingToggle).toHaveText("All");
    await trackingToggle.click();

    const sequenceTrackingDropdown = page.locator(
      "[data-hs-select-dropdown].opened",
    );
    await expect(sequenceTrackingDropdown).toBeVisible();
    await expect(
      sequenceTrackingDropdown.locator("[data-value].selected"),
    ).toHaveCount(3);
    await expect(
      sequenceTrackingDropdown.locator('[data-value="HTP"].selected'),
    ).toHaveCount(1);
    await expect(
      sequenceTrackingDropdown.locator('[data-value="LTP"].selected'),
    ).toHaveCount(1);
    await expect(
      sequenceTrackingDropdown.locator('[data-value="FX"].selected'),
    ).toHaveCount(1);
  } finally {
    await cleanupCreatedSequence(page, sequenceTarget);
  }
});

/** Verifies new sequences persist concrete sequence tracking with inherited built-in cues. */
test("sequence list creates sequences with tracking mode defaults", async ({
  page,
}) => {
  await openOwnedSequenceTrackingApp(page);
  await waitForSequenceListStores(page);
  const created = await createSequenceFromList(page);

  try {
    expect(created.tracking_mode).toEqual({
      type: "Flags",
      data: { __Composed__: 7 },
    });
    expect(created.setup_cue.tracking_mode).toEqual({
      type: "Flags",
      data: { __Composed__: 7 },
    });
    expect(created.release_cue.tracking_mode).toEqual({ type: "Inherit" });

    await openCreatedSequenceProperties(page, created.identifiers.uid);
    await focusDockPanel(page, SEQUENCE_EDITOR_PANEL_ID);
    await expect(
      page.getByRole("tab", {
        name: `Sequence ${created.identifiers.id}: ${created.identifiers.label}`,
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "Properties", exact: true }).click();
    const sequenceTrackingSelect = page.locator(
      'select[id^="sequence-properties-tracking-flags-"]',
    );
    await expect(sequenceTrackingSelect).toHaveAttribute("multiple", "");
    await expect(
      sequenceTrackingSelect
        .locator("xpath=ancestor::div[contains(@class, 'hs-select')][1]")
        .getByRole("button", { name: "Sequence tracking flags", exact: true }),
    ).toBeVisible();

    await focusDockPanel(page, SEQUENCE_EDITOR_PANEL_ID);
    const sequenceGrid = page
      .locator(`[data-panel-id="${SEQUENCE_EDITOR_PANEL_ID}"]`)
      .locator('[data-grid-owner="sequence-editor"]');
    const table = sequenceGrid.locator('[data-grid-kind="tanstack"]');
    await expect(table.locator("#tanstack-cell-1-0")).toContainText("Setup");
    await scrollTrackingColumnIntoView(table);
    const setupTrackingCell = table.locator(
      '[data-grid-column-key="tracking"][data-grid-row-index="0"]',
    );
    await expect(
      setupTrackingCell.locator('select[aria-label="Choose tracking mode"]'),
    ).toHaveCount(0);
    await expect(
      setupTrackingCell.locator('select[aria-label="Choose tracking flags"]'),
    ).toHaveCount(0);
    await expect(setupTrackingCell).toContainText("All");
  } finally {
    await cleanupCreatedSequence(page, created);
  }
});
