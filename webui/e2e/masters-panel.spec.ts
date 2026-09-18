// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const CONTROLS_COLLAPSED_STORAGE_KEY =
  "nightfall-clip-panel:controls-collapsed";

test.setTimeout(60_000);

/** Opens an isolated showfile and waits for the panel shell to become interactive. */
async function loadTestApp(page: Page, showfileName: string): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.removeItem("nightfall.currentShowfileName");
    window.localStorage.removeItem("nightfall.e2eAutoOpenStartupShowfile");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page, {
    showfileName,
    createIfMissing: true,
    newShowfileName: showfileName,
  });
}

/** Returns the current number of masters in the frontend store. */
async function masterCount(page: Page): Promise<number> {
  return page.evaluate(
    () => Object.keys((window as any).appStores?.masters?.get?.() ?? {}).length,
  );
}

/** Returns the newest master by numeric ID from the frontend store. */
async function newestMaster(page: Page): Promise<{
  id: number;
  label: string;
}> {
  return page.evaluate(() => {
    const masters = Object.values(
      (window as any).appStores?.masters?.get?.() ?? {},
    ) as any[];
    const newest = masters.sort(
      (left, right) => right.identifiers.id - left.identifiers.id,
    )[0];
    return {
      id: newest.identifiers.id,
      label: newest.identifiers.label,
    };
  });
}

/** Adds a dock panel directly so drag/drop source and target stay visible together. */
async function addPanel(
  page: Page,
  panel: {
    id: string;
    component: string;
    title: string;
    position: Record<string, unknown>;
  },
): Promise<void> {
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
      params: {},
      position: panel.position,
    });
    nextPanel.api.setActive();
    nextPanel.focus();
  }, panel);

  await expect
    .poll(() =>
      page.evaluate(
        (panelId) =>
          (window as any).appStores.dockApi.get().activePanel?.id === panelId,
        panel.id,
      ),
    )
    .toBe(true);
}

/** Verifies the requested control is assigned to the expected master ID. */
async function expectMasterAssignedToControl(
  page: Page,
  masterId: number,
  controlIndex: number,
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        ({ controlIndex }) =>
          (
            (window as any).appStores.controls.get() as Array<{
              index: number;
              assigned_master_id?: number;
            }>
          ).find((control) => control.index === controlIndex)
            ?.assigned_master_id,
        { controlIndex },
      ),
    )
    .toBe(masterId);
}

/** Drags a persisted master from the Masters panel onto a control. */
async function dragMasterToControl(
  page: Page,
  masterId: number,
  controlIndex: number,
): Promise<void> {
  const mastersPanel = page.locator(".panel-Masters-assignment-e2e");
  const clipsPanel = page.locator(".panel-Clips-assignment-e2e");
  const dragHandle = mastersPanel.locator(
    `[data-master-drag-handle-id="${masterId}"]`,
  );
  const dropZone = clipsPanel.locator(
    `[data-clip-dropzone-index="${controlIndex}"]`,
  );
  await expect(dragHandle).toBeVisible();
  await expect(dropZone).toBeVisible();
  await dragHandle.dragTo(dropZone);
  await expectMasterAssignedToControl(page, masterId, controlIndex);
}

test("masters can be created and assigned to a control", async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.addInitScript((storageKey) => {
    window.localStorage.setItem(storageKey, "false");
  }, CONTROLS_COLLAPSED_STORAGE_KEY);

  await loadTestApp(page, "masters-assignment-e2e");
  await page.waitForTimeout(3_000);

  await addPanel(page, {
    id: "panel-Masters-assignment-e2e",
    component: "MastersPanel",
    title: "Masters",
    position: {
      referencePanel: "panel-FixtureGrid",
      direction: "left",
    },
  });
  await addPanel(page, {
    id: "panel-Clips-assignment-e2e",
    component: "ClipList",
    title: "Clips",
    position: {
      referencePanel: "panel-Masters-assignment-e2e",
      direction: "right",
    },
  });

  const mastersPanel = page.locator(".panel-Masters-assignment-e2e");
  const initialMasterCount = await masterCount(page);
  await mastersPanel
    .getByRole("button", { name: "New intensity global" })
    .click();
  await expect.poll(() => masterCount(page)).toBe(initialMasterCount + 1);

  const master = await newestMaster(page);
  const masterRow = mastersPanel.locator(`[data-master-id="${master.id}"]`);
  await expect(masterRow).toBeVisible();
  await expect(masterRow.getByText("All fixtures")).toBeVisible();
  await expect(masterRow.getByText("100%")).toBeVisible();
  await expect(mastersPanel.getByLabel("Group", { exact: true })).toHaveClass(
    /nf-form-control/,
  );
  const modeWidth = await masterRow
    .locator("select")
    .evaluate((select) => select.getBoundingClientRect().width);
  expect(modeWidth).toBeGreaterThanOrEqual(120);
  await page.screenshot({
    path: test.info().outputPath("shared-masters.png"),
    fullPage: true,
  });
  const level = masterRow.getByRole("slider");
  expect(
    await level.evaluate((input) => input.getBoundingClientRect().width),
  ).toBeGreaterThanOrEqual(120);
  await level.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath("shared-masters-level.png"),
  });
  await masterRow
    .locator(`[data-master-drag-handle-id="${master.id}"]`)
    .scrollIntoViewIfNeeded();
  await expect(
    masterRow.locator(`[data-master-drag-handle-id="${master.id}"]`),
  ).toBeVisible();

  await dragMasterToControl(page, master.id, 2);

  const assignedControl = page
    .locator(".panel-Clips-assignment-e2e")
    .locator('[data-control-index="2"]');
  const assignedDropZone = assignedControl.locator(
    '[data-clip-dropzone-index="2"]',
  );
  await expect(assignedControl).toBeVisible();
  await expect(assignedDropZone.locator(".font-medium")).toHaveText(
    String(master.id),
  );
  await expect(assignedDropZone.getByText(master.label)).toBeVisible();
  await expect(assignedControl.getByText("100%")).toBeVisible();
  await expect(
    assignedControl.locator(".vertical-range-slider"),
  ).not.toHaveClass(/is-disabled/);
});

test("playback rate masters use control midpoint as normal speed", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.addInitScript((storageKey) => {
    window.localStorage.setItem(storageKey, "false");
  }, CONTROLS_COLLAPSED_STORAGE_KEY);

  await loadTestApp(page, "rate-masters-assignment-e2e");
  await page.waitForTimeout(3_000);

  await addPanel(page, {
    id: "panel-Masters-assignment-e2e",
    component: "MastersPanel",
    title: "Masters",
    position: {
      referencePanel: "panel-FixtureGrid",
      direction: "left",
    },
  });
  await addPanel(page, {
    id: "panel-Clips-assignment-e2e",
    component: "ClipList",
    title: "Clips",
    position: {
      referencePanel: "panel-Masters-assignment-e2e",
      direction: "right",
    },
  });

  const mastersPanel = page.locator(".panel-Masters-assignment-e2e");
  const initialMasterCount = await masterCount(page);
  await mastersPanel.getByRole("button", { name: "New rate global" }).click();
  await expect.poll(() => masterCount(page)).toBe(initialMasterCount + 1);

  const master = await newestMaster(page);
  const masterRow = mastersPanel.locator(`[data-master-id="${master.id}"]`);
  await expect(masterRow).toBeVisible();
  await expect(masterRow.getByText("All instances")).toBeVisible();
  await expect(masterRow.getByText("100%")).toBeVisible();

  await dragMasterToControl(page, master.id, 3);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const control = (
          (window as any).appStores.controls.get() as Array<{
            index: number;
            display_value: number;
          }>
        ).find((candidate) => candidate.index === 3);
        return control?.display_value;
      }),
    )
    .toBe(50);

  const assignedControl = page
    .locator(".panel-Clips-assignment-e2e")
    .locator('[data-control-index="3"]');
  await expect(assignedControl.getByText("100%")).toBeVisible();
});
