// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

interface SequenceRecord {
  identifiers: { id: number; uid: string; label: string };
}

interface RenameContext {
  sequenceId: number;
  sequenceUid: string;
  inlineLabel: string;
  listLabel: string;
  propertiesLabel: string;
}

/** Opens a unique blank showfile for the CRUD sequence rename scenario. */
async function openOwnedCrudRenameApp(page: Page): Promise<void> {
  const testInfo = test.info();
  const showfileName = `crud-rename-${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`;

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

/** Waits until the blank showfile exposes stores needed by CRUD rename. */
async function waitForStores(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      Boolean((window as any).appStores?.dockApi?.get?.()) &&
      Boolean((window as any).appStores?.sequences?.get) &&
      typeof (window as any).appStores?.sendAndAwait === "function",
    undefined,
    { timeout: 15_000 },
  );
}

/** Opens dedicated Sequence list and Properties panels for rename interactions. */
async function openRenamePanels(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const api = (window as any).appStores.dockApi.get();
    if (!api.getPanel("panel-SequenceList-crud-rename")) {
      const referencePanel = api.getPanel("panel-FixtureGrid");
      api.addPanel({
        id: "panel-SequenceList-crud-rename",
        component: "SequenceList",
        title: "Sequences",
        params: { initialPanelId: "panel-SequenceList-crud-rename" },
        ...(referencePanel
          ? {
              position: {
                referencePanel: referencePanel.id,
                direction: "within",
              },
            }
          : {}),
      });
    }
    if (!api.getPanel("panel-PropertiesInspector")) {
      api.addPanel({
        id: "panel-PropertiesInspector",
        component: "PropertiesInspector",
        title: "Properties",
        params: {},
      });
    }
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    api.getPanel("panel-SequenceList-crud-rename")?.api.setActive();
    api.getPanel("panel-SequenceList-crud-rename")?.focus();
  });
}

/** Creates the sole sequence owned by the CRUD rename scenario. */
async function createRenameSequence(page: Page): Promise<RenameContext> {
  const beforeSequenceUids = await page.evaluate(() =>
    Object.keys((window as any).appStores.sequences.get()),
  );
  const sequencePanel = page.locator(
    '[data-component="SequenceList"][data-panel-id="panel-SequenceList-crud-rename"]',
  );
  await sequencePanel.getByRole("button", { name: "Add sequence" }).click();

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
              ) as SequenceRecord[]
            ).find(
              (sequence) =>
                !existingUids.has(sequence.identifiers.uid.toLowerCase()),
            ) ?? null
          );
        }, beforeSequenceUids),
      { timeout: 15_000 },
    )
    .not.toBeNull();

  const context = await page.evaluate((previousUids) => {
    const existingUids = new Set(previousUids.map((uid) => uid.toLowerCase()));
    const sequence = (
      Object.values(
        (window as any).appStores.sequences.get(),
      ) as SequenceRecord[]
    ).find(
      (candidate) => !existingUids.has(candidate.identifiers.uid.toLowerCase()),
    );
    if (!sequence) throw new Error("Created sequence did not hydrate");
    const sequenceId = sequence.identifiers.id;
    return {
      sequenceId,
      sequenceUid: sequence.identifiers.uid,
      inlineLabel: `CRUD Rename Inline ${sequenceId}`,
      listLabel: `CRUD Rename List ${sequenceId}`,
      propertiesLabel: `CRUD Rename Properties ${sequenceId}`,
    };
  }, beforeSequenceUids);
  await expect
    .poll(() =>
      page.evaluate(
        (sequenceUid) =>
          Boolean(
            (window as any).appStores.dockApi
              .get()
              .getPanel(`sequence-editor-panel-${sequenceUid}`),
          ),
        context.sequenceUid,
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-SequenceList-crud-rename")?.api.setActive();
    api.getPanel("panel-SequenceList-crud-rename")?.focus();
  });
  await expect(sequencePanel).toBeVisible();
  return context;
}

/** Deletes the sequence created by the CRUD rename scenario. */
async function cleanupRenameSequence(
  page: Page,
  context: RenameContext,
): Promise<void> {
  await page.evaluate(async (sequenceId) => {
    await (window as any).appStores.sendAndAwait({
      module: "CueCommand",
      command: { type: "DeleteSequence", data: sequenceId },
    });
  }, context.sequenceId);
  await expect
    .poll(() =>
      page.evaluate(
        (sequenceUid) =>
          !(window as any).appStores.sequences.get()[sequenceUid],
        context.sequenceUid,
      ),
    )
    .toBe(true);
}

/** Waits until the owned sequence has the expected label in appStores. */
async function expectSequenceLabel(
  page: Page,
  sequenceUid: string,
  label: string,
): Promise<void> {
  await page.waitForFunction(
    ({ sequenceUid, label }) =>
      (window as any).appStores?.sequences?.get?.()?.[sequenceUid]?.identifiers
        .label === label,
    { sequenceUid, label },
  );
}

/** Exercises card, list, and Properties rename commits for one owned sequence. */
async function exerciseRenameSurfaces(
  page: Page,
  context: RenameContext,
): Promise<void> {
  const cardLabel = page
    .locator(`button[data-crud-select-id="${context.sequenceUid}"]:visible`)
    .first();
  const sequencePanel = cardLabel.locator(
    "xpath=ancestor::div[.//button[@aria-label='Switch to list view']][1]",
  );
  await expect(cardLabel).toBeVisible();
  await cardLabel.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();

  const cardInlineEditor = page.getByLabel("Sequence card label");
  await expect(cardInlineEditor).toBeVisible();
  await cardInlineEditor.fill(context.inlineLabel);
  await cardInlineEditor.press("Enter");
  await expectSequenceLabel(page, context.sequenceUid, context.inlineLabel);

  await sequencePanel.getByLabel("Switch to list view").click();
  const updatedRowLabel = page
    .locator('[role="gridcell"]:visible')
    .filter({ hasText: context.inlineLabel })
    .first();
  await expect(updatedRowLabel).toBeVisible();
  await updatedRowLabel.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const listInlineEditor = page.locator('[role="gridcell"] input').last();
  await expect(listInlineEditor).toBeVisible();
  await listInlineEditor.fill(context.listLabel);
  await listInlineEditor.blur();
  await expectSequenceLabel(page, context.sequenceUid, context.listLabel);

  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-SequenceList-crud-rename")?.api.setActive();
    api.getPanel("panel-SequenceList-crud-rename")?.focus();
    api.getPanel("panel-PropertiesInspector")?.focus();
  });
  const propertiesInput = page.getByLabel("Sequence label");
  await expect(propertiesInput).toHaveValue(context.listLabel);
  await propertiesInput.fill("");
  await propertiesInput.pressSequentially(context.propertiesLabel);
  await expect(propertiesInput).toBeFocused();
  await expectSequenceLabel(page, context.sequenceUid, context.listLabel);
  await propertiesInput.blur();
  await expectSequenceLabel(page, context.sequenceUid, context.propertiesLabel);
}

test("CRUD sequence labels rename inline and commit from Properties on blur", async ({
  page,
}) => {
  test.setTimeout(60_000);

  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));

  await page.setViewportSize({ width: 1600, height: 900 });
  await openOwnedCrudRenameApp(page);
  await expect(page.locator("main#app")).toBeVisible();
  await waitForStores(page);
  await openRenamePanels(page);
  const context = await createRenameSequence(page);

  try {
    await exerciseRenameSurfaces(page, context);
    expect(runtimeErrors).toEqual([]);
  } finally {
    await cleanupRenameSequence(page, context);
  }
});
