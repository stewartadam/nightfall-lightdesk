// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { gridCellByKey, gridHeaderByColumnKey } from "./data-grid-selectors";
import { expect, type Page, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

const WRAP_DELAY_PANEL_ID = "panel-SequenceEditor-wrap-delay-e2e";
const ENTRY_LAYOUT_PANEL_ID = "panel-SequenceEditor-entry-layout-e2e";

/** Returns the TanStack grid owned by one sequence editor panel. */
function sequenceEditorGrid(page: Page, panelId: string) {
  return page
    .locator(`[data-component="SequenceEditor"][data-panel-id="${panelId}"]`)
    .locator('[data-grid-owner="sequence-editor"]')
    .locator('[data-grid-kind="tanstack"]');
}

/** Seeds a wrapped sequence whose first cue carries a wrap delay. */
async function seedWrapDelaySequence(page: Page): Promise<{
  cueOneUid: string;
  sequenceUid: string;
}> {
  return page.evaluate(async () => {
    const stores = (window as any).appStores;
    const sequenceUid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01";
    const cueOneUid = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01";
    const cueTwoUid = "cccccccccccccccccccccccccccccc01";
    const seconds = (secs: number) => ({ secs, nanos: 0 });
    const cue = (
      id: number,
      uid: string,
      label: string,
      delay: number,
      triggerType: "AfterDelay" | "At" = "AfterDelay",
    ) => ({
      identifiers: { id, uid, label },
      trigger: { type: triggerType, data: seconds(delay) },
      transitions: {},
      transitions_by_attribute: {},
      instructions: [],
      parts: [],
      tracking_flags: "HTP",
    });
    const metaCue = (uid: string, label: string) => ({
      identifiers: { id: 0, uid, label },
      trigger: { type: "Manual" },
      transitions: {},
      transitions_by_attribute: {},
      instructions: [],
      parts: [],
      tracking_flags: "HTP",
    });

    stores.cues.set({
      ...stores.cues.get(),
      [cueOneUid]: cue(1, cueOneUid, "Wrapped One", 5, "At"),
      [cueTwoUid]: cue(2, cueTwoUid, "Wrapped Two", 2),
    });
    stores.sequences.set({
      ...stores.sequences.get(),
      [sequenceUid]: {
        identifiers: {
          id: 904,
          uid: sequenceUid,
          label: "Wrap Delay E2E",
        },
        steps: [cueOneUid, cueTwoUid],
        wrap: true,
        release_on_start: false,
        setup_cue: metaCue("dddddddddddddddddddddddddddddd01", "Setup"),
        release_cue: metaCue("eeeeeeeeeeeeeeeeeeeeeeeeeeeeee01", "Release"),
        default_timing: {
          delay_in: { type: "Fixed", data: seconds(0) },
          fade_in: { type: "Fixed", data: seconds(0) },
          curve_in: "Linear",
          delay_out: { type: "Fixed", data: seconds(0) },
          fade_out: { type: "Fixed", data: seconds(0) },
          curve_out: "Linear",
        },
      },
    });

    const api = stores.dockApi.get();
    const referencePanel =
      api.getPanel("panel-FixtureGrid") ??
      api.panels.find(
        (candidate: any) => candidate.api.location.type === "grid",
      );
    const panel = api.addPanel({
      id: "panel-SequenceEditor-wrap-delay-e2e",
      component: "SequenceEditor",
      title: "Sequence Wrap Delay E2E",
      ...(referencePanel
        ? {
            position: {
              referencePanel: referencePanel.id,
              direction: "within",
            },
          }
        : {}),
      params: {
        initialPanelId: "panel-SequenceEditor-wrap-delay-e2e",
        initialSequenceUid: sequenceUid,
      },
    });
    panel.api.setActive();
    panel.focus();

    return { cueOneUid, sequenceUid };
  });
}

/** Seeds a non-wrapping sequence whose first cue uses an AfterDelay trigger. */
async function seedNonWrappingEntrySequence(page: Page): Promise<{
  cueOneUid: string;
  cueTwoUid: string;
  setupCueUid: string;
  releaseCueUid: string;
}> {
  return page.evaluate(async () => {
    const stores = (window as any).appStores;
    const sequenceUid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa11";
    const cueOneUid = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb11";
    const cueTwoUid = "cccccccccccccccccccccccccccccc11";
    const setupCueUid = "dddddddddddddddddddddddddddddd11";
    const releaseCueUid = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeee11";
    const seconds = (secs: number) => ({ secs, nanos: 0 });
    const cue = (id: number, uid: string, label: string, trigger: unknown) => ({
      identifiers: { id, uid, label },
      trigger,
      transitions: {},
      transitions_by_attribute: {},
      instructions: [],
      parts: [],
      tracking_flags: "HTP",
    });
    const metaCue = (uid: string, label: string) =>
      cue(0, uid, label, { type: "Manual" });

    stores.cues.set({
      ...stores.cues.get(),
      [cueOneUid]: cue(1, cueOneUid, "Entry One", {
        type: "AfterDelay",
        data: seconds(3),
      }),
      [cueTwoUid]: cue(2, cueTwoUid, "Entry Two", {
        type: "FollowPrevious",
      }),
    });
    stores.sequences.set({
      ...stores.sequences.get(),
      [sequenceUid]: {
        identifiers: {
          id: 905,
          uid: sequenceUid,
          label: "Non-Wrap Entry E2E",
        },
        steps: [cueOneUid, cueTwoUid],
        wrap: false,
        release_on_start: false,
        setup_cue: metaCue(setupCueUid, "Setup"),
        release_cue: metaCue(releaseCueUid, "Release"),
        default_timing: {
          delay_in: { type: "Fixed", data: seconds(0) },
          fade_in: { type: "Fixed", data: seconds(0) },
          curve_in: "Linear",
          delay_out: { type: "Fixed", data: seconds(0) },
          fade_out: { type: "Fixed", data: seconds(0) },
          curve_out: "Linear",
        },
      },
    });

    const api = stores.dockApi.get();
    const referencePanel =
      api.getPanel("panel-FixtureGrid") ??
      api.panels.find(
        (candidate: any) => candidate.api.location.type === "grid",
      );
    const panel = api.addPanel({
      id: "panel-SequenceEditor-entry-layout-e2e",
      component: "SequenceEditor",
      title: "Sequence Entry Layout E2E",
      ...(referencePanel
        ? {
            position: {
              referencePanel: referencePanel.id,
              direction: "within",
            },
          }
        : {}),
      params: {
        initialPanelId: "panel-SequenceEditor-entry-layout-e2e",
        initialSequenceUid: sequenceUid,
      },
    });
    panel.api.setActive();
    panel.focus();

    return { cueOneUid, cueTwoUid, setupCueUid, releaseCueUid };
  });
}

/** Returns the left edge of a grid cell's visible text span. */
async function cellTextLeft(
  cell: ReturnType<typeof gridCellByKey>,
): Promise<number> {
  return cell
    .locator("span")
    .first()
    .evaluate((span) => {
      const rect = span.getBoundingClientRect();
      return rect.left;
    });
}

/** Verifies cue 1 wrap delay is labeled and zeroed when wrapping is disabled. */
test("sequence editor labels first cue timing as wrap delay only while wrapping", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await prepareStoreSeededTestApp(page);

  const { cueOneUid, sequenceUid } = await seedWrapDelaySequence(page);
  const grid = sequenceEditorGrid(page, WRAP_DELAY_PANEL_ID);
  await expect(grid).toBeVisible();

  const cueOneRowKey = `${cueOneUid}:cue`;
  await expect(
    gridCellByKey(grid, {
      columnKey: "trigger",
      rowKey: cueOneRowKey,
    }),
  ).toContainText("Wrap Delay");
  await expect(
    gridCellByKey(grid, {
      columnKey: "after_delay",
      rowKey: cueOneRowKey,
    }),
  ).toContainText("5s");

  await page.evaluate((uid) => {
    const stores = (window as any).appStores;
    const sequences = stores.sequences.get();
    stores.sequences.set({
      ...sequences,
      [uid]: {
        ...sequences[uid],
        wrap: false,
      },
    });
  }, sequenceUid);

  await expect(
    gridCellByKey(grid, {
      columnKey: "trigger",
      rowKey: cueOneRowKey,
    }),
  ).not.toContainText("Wrap Delay");
  await expect(
    gridCellByKey(grid, {
      columnKey: "after_delay",
      rowKey: cueOneRowKey,
    }),
  ).toContainText("0s");

  await expect
    .poll(async () => {
      return page.evaluate((uid) => {
        const cue = (window as any).appStores.cues.get()[uid];
        return cue?.trigger;
      }, cueOneUid);
    })
    .toEqual({
      type: "At",
      data: { secs: 5, nanos: 0 },
    });
});

/** Verifies sequence entry trigger labels, alignment, and header grouping. */
test("sequence editor aligns non-wrapping cue entry trigger cells", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await prepareStoreSeededTestApp(page);

  const { cueOneUid, cueTwoUid, setupCueUid, releaseCueUid } =
    await seedNonWrappingEntrySequence(page);
  const grid = sequenceEditorGrid(page, ENTRY_LAYOUT_PANEL_ID);
  await expect(grid).toBeVisible();

  const cueOneTrigger = gridCellByKey(grid, {
    columnKey: "trigger",
    rowKey: `${cueOneUid}:cue`,
  });
  const cueTwoTrigger = gridCellByKey(grid, {
    columnKey: "trigger",
    rowKey: `${cueTwoUid}:cue`,
  });
  const setupTrigger = gridCellByKey(grid, {
    columnKey: "trigger",
    rowKey: `${setupCueUid}:cue`,
  });
  const releaseTrigger = gridCellByKey(grid, {
    columnKey: "trigger",
    rowKey: `${releaseCueUid}:cue`,
  });

  await expect(cueOneTrigger).toContainText("After Delay");
  await expect(cueOneTrigger).not.toContainText("AfterDelay");
  await expect(setupTrigger).toContainText("Setup");
  await expect(releaseTrigger).toContainText("Follow Previous");
  await expect(cueTwoTrigger).toContainText("Follow Previous");

  const cueEntryHeader = grid.locator(
    '[data-grid-header-id="tanstack-header-group:Cue Entry"]',
  );
  await expect(cueEntryHeader).toContainText("Cue Entry");
  await expect(gridHeaderByColumnKey(grid, "trigger")).toContainText("Trigger");
  await expect(gridHeaderByColumnKey(grid, "after_delay")).toContainText(
    "Time",
  );

  const durationHeader = gridHeaderByColumnKey(grid, "duration");
  const trackingHeader = gridHeaderByColumnKey(grid, "tracking");
  const durationBox = await durationHeader.boundingBox();
  const trackingBox = await trackingHeader.boundingBox();
  expect(durationBox).not.toBeNull();
  expect(trackingBox).not.toBeNull();
  expect(trackingBox!.x).toBeGreaterThan(durationBox!.x);

  const dropdownCellBox = await cueTwoTrigger.boundingBox();
  expect(dropdownCellBox).not.toBeNull();
  const dropdownTextLeft = dropdownCellBox!.x + 8;
  for (const triggerCell of [setupTrigger, cueOneTrigger, releaseTrigger]) {
    expect(
      Math.abs((await cellTextLeft(triggerCell)) - dropdownTextLeft),
    ).toBeLessThan(1.5);
  }
});
