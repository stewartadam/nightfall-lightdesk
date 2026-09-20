// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Opens a unique blank showfile for the timeline toolbar scenario. */
async function openOwnedTimelineListApp(page: Page): Promise<void> {
  const testInfo = test.info();
  const showfileName = `timeline-list-toolbar-${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`;
  await page.addInitScript(() => {
    window.localStorage.removeItem("nightfall.currentShowfileName");
    window.localStorage.removeItem("nightfall.e2eAutoOpenStartupShowfile");
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

/**
 * Opens the timeline list panel and waits for toolbar actions.
 */
async function openTimelineListPanel(page: Page) {
  await expect
    .poll(async () =>
      page.evaluate(() => Boolean((window as any).appStores?.dockApi?.get?.())),
    )
    .toBe(true);

  await page.evaluate(() => {
    const stores = (window as any).appStores;
    const api = stores.dockApi.get();
    api.getPanel("panel-TimelinesPanel-e2e")?.api.close();
    api.addPanel({
      id: "panel-TimelinesPanel-e2e",
      component: "TimelinesPanel",
      title: "Timelines",
      params: {},
      position: {
        referencePanel: "panel-FixtureGrid",
        direction: "within",
      },
    });
  });
}

/**
 * Focuses the timeline list panel so toolbar commands target it.
 */
async function focusTimelineListPanel(page: Page) {
  await page.evaluate(() => {
    const api = (window as any).appStores?.dockApi?.get?.();
    api?.getPanel("panel-TimelinesPanel-e2e")?.focus();
  });
}

/**
 * Looks up a timeline UID from its display ID in app stores.
 */
async function timelineUidById(page: Page, timelineId: number) {
  return page.evaluate((id) => {
    const stores = (window as any).appStores;
    const timeline = Object.values(stores.timelines.get()).find(
      (candidate: any) => candidate?.identifiers?.id === id,
    ) as { identifiers?: { uid?: string } } | undefined;
    return timeline?.identifiers?.uid ?? null;
  }, timelineId);
}

/**
 * Checks whether a timeline editor panel is open for a UID.
 */
async function timelinePanelIsOpen(page: Page, timelineUid: string) {
  return page.evaluate((uid) => {
    const api = (window as any).appStores?.dockApi?.get?.();
    return Boolean(api?.getPanel(`panel-Timeline-${uid}`));
  }, timelineUid);
}

/**
 * Closes the timeline editor panel for a UID when it is open.
 */
async function closeTimelinePanel(page: Page, timelineUid: string) {
  await page.evaluate((uid) => {
    const api = (window as any).appStores?.dockApi?.get?.();
    api?.getPanel(`panel-Timeline-${uid}`)?.api.close();
  }, timelineUid);
}

async function selectTimelineCard(
  page: Page,
  timelineId: number,
  timelineLabel: string,
) {
  await focusTimelineListPanel(page);
  const panel = page.locator(
    '[data-panel-kind="timeline-list"][data-panel-id="panel-TimelinesPanel-e2e"]',
  );
  await panel
    .getByRole("button", {
      name: new RegExp(`Timeline ${timelineId}: ${timelineLabel}`),
    })
    .click();
  return panel;
}

test("timeline list toolbar exposes CRUD actions", async ({
  page,
}, testInfo) => {
  await openOwnedTimelineListApp(page);
  await openTimelineListPanel(page);

  const panel = page.locator(
    '[data-panel-kind="timeline-list"][data-panel-id="panel-TimelinesPanel-e2e"]',
  );
  await expect(panel).toBeVisible();

  const addButton = panel.getByRole("button", { name: "Add timeline" });
  const openButton = panel.getByRole("button", {
    name: "Open selected timeline",
  });
  const editButton = panel.getByRole("button", {
    name: "Edit selected timeline",
  });
  const deleteButton = panel.getByRole("button", {
    name: "Delete selected timelines",
  });
  const listViewButton = panel.getByRole("button", {
    name: "Switch to list view",
  });
  const gridViewButton = panel.getByRole("button", {
    name: "Switch to grid view",
  });
  const selectionModeButton = panel.getByRole("button", {
    name: "Toggle selection mode",
  });

  await expect(addButton).toBeEnabled();
  await expect(openButton).toBeDisabled();
  await expect(editButton).toBeDisabled();
  await expect(deleteButton).toBeDisabled();
  await expect(listViewButton).toBeVisible();
  await expect(gridViewButton).toBeVisible();
  await expect(selectionModeButton).toBeVisible();

  await listViewButton.click();
  await expect(selectionModeButton).not.toBeVisible();
  await gridViewButton.click();
  await expect(selectionModeButton).toBeVisible();

  const createdTimelineId = await page.evaluate(() => {
    const stores = (window as any).appStores;
    const usedIds = new Set(
      Object.values(stores.timelines.get()).map(
        (timeline: any) => timeline?.identifiers?.id,
      ),
    );
    let timelineId = 900000 + Math.floor(Math.random() * 100000);
    while (usedIds.has(timelineId)) {
      timelineId += 1;
    }
    return timelineId;
  });
  const createdTimelineLabel = `Toolbar CRUD ${createdTimelineId}`;

  await addButton.click();
  await expect(
    page.getByRole("dialog", { name: "Create timeline" }),
  ).toBeVisible();
  await expect(page.getByLabel("Timeline label")).toBeFocused();
  await page.getByLabel("Timeline ID").fill(String(createdTimelineId));
  await page.getByLabel("Timeline label").fill(createdTimelineLabel);
  await page.getByRole("button", { name: "Create", exact: true }).click();

  await expect
    .poll(async () =>
      page.evaluate((timelineId) => {
        const stores = (window as any).appStores;
        const timeline = Object.values(stores.timelines.get()).find(
          (candidate: any) => candidate?.identifiers?.id === timelineId,
        ) as { timecode_uid?: string } | undefined;
        if (!timeline?.timecode_uid) return false;

        const timecode = stores.timecodes.get()[timeline.timecode_uid]?.[0];
        return timecode?.identifiers?.id === timelineId;
      }, createdTimelineId),
    )
    .toBe(true);

  const createdTimelineUid = await timelineUidById(page, createdTimelineId);
  expect(createdTimelineUid).not.toBeNull();
  await closeTimelinePanel(page, createdTimelineUid as string);

  await selectTimelineCard(page, createdTimelineId, createdTimelineLabel);
  await expect
    .poll(() => timelinePanelIsOpen(page, createdTimelineUid as string))
    .toBe(true);
  await expect(
    page
      .locator(".dv-tab")
      .getByText(`Timeline ${createdTimelineId}: ${createdTimelineLabel}`, {
        exact: true,
      }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("timeline-tab-title.png"),
  });
  await focusTimelineListPanel(page);
  await expect(openButton).toBeDisabled();
  await expect(editButton).toBeDisabled();
  await expect(deleteButton).toBeDisabled();

  await closeTimelinePanel(page, createdTimelineUid as string);
  await selectionModeButton.click();
  await selectTimelineCard(page, createdTimelineId, createdTimelineLabel);
  await expect
    .poll(() => timelinePanelIsOpen(page, createdTimelineUid as string))
    .toBe(false);
  await expect(openButton).toBeEnabled();
  await expect(editButton).toBeEnabled();
  await expect(deleteButton).toBeEnabled();

  await panel.screenshot({
    path: testInfo.outputPath("timeline-list-toolbar.png"),
  });

  await editButton.click();
  await expect(
    page.getByRole("dialog", { name: "Edit timeline" }),
  ).toBeVisible();
  await expect(page.getByLabel("Timeline ID")).toHaveValue(
    String(createdTimelineId),
  );
  await expect(page.getByLabel("Timeline label")).toHaveValue(
    createdTimelineLabel,
  );
  await page.getByRole("button", { name: "Cancel" }).click();

  await selectionModeButton.click();
  await selectTimelineCard(page, createdTimelineId, createdTimelineLabel);
  await deleteButton.click();
  await expect(
    page.getByRole("dialog", { name: "Delete selected timelines" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
});
