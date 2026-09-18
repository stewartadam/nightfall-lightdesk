// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.setTimeout(90_000);

interface SequenceRecord {
  identifiers: { id: number; uid: string; label: string };
  [key: string]: unknown;
}

interface SearchSequenceContext {
  keepId: number;
  keepLabel: string;
  keepSequence: SequenceRecord;
  keepUid: string;
  hideId: number;
  hideLabel: string;
  hideSequence: SequenceRecord;
  hideUid: string;
}

/** Opens a unique blank showfile for the CRUD sequence search scenario. */
async function openOwnedCrudSearchApp(page: Page): Promise<void> {
  const testInfo = test.info();
  const showfileName = `crud-search-${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`;

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

/** Waits until app stores needed by CRUD search are ready. */
async function waitForCrudStores(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      Boolean((window as any).appStores?.dockApi?.get?.()) &&
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.sequences?.get),
  );
}

/** Creates one sequence through the dedicated search panel and restores panel focus. */
async function createSequenceFromSearchPanel(
  page: Page,
): Promise<SequenceRecord> {
  const beforeSequenceUids = await page.evaluate(() =>
    Object.keys((window as any).appStores.sequences.get()),
  );
  const panel = page.locator(
    '[data-component="SequenceList"][data-panel-id="panel-SequenceList-crud-search-e2e"]',
  );
  await panel.getByRole("button", { name: "Add sequence" }).click();

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
  const sequence = await page.evaluate((previousUids) => {
    const existingUids = new Set(previousUids.map((uid) => uid.toLowerCase()));
    const created = (
      Object.values(
        (window as any).appStores.sequences.get(),
      ) as SequenceRecord[]
    ).find(
      (candidate) => !existingUids.has(candidate.identifiers.uid.toLowerCase()),
    );
    if (!created) throw new Error("Created sequence did not hydrate");
    return created;
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
        sequence.identifiers.uid,
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-SequenceList-crud-search-e2e")?.api.setActive();
    api.getPanel("panel-SequenceList-crud-search-e2e")?.focus();
  });
  await expect(panel).toBeVisible();
  return sequence;
}

/** Creates and relabels the two sequences owned by CRUD search assertions. */
async function createSearchSequences(
  page: Page,
): Promise<SearchSequenceContext> {
  const firstSequence = await createSequenceFromSearchPanel(page);
  const secondSequence = await createSequenceFromSearchPanel(page);
  const context = await page.evaluate(
    async ({ firstSequence, secondSequence }) => {
      const stores = (window as any).appStores;
      const keepSequence = {
        ...firstSequence,
        identifiers: {
          ...firstSequence.identifiers,
          label: `center bstrip right ${firstSequence.identifiers.id}`,
        },
      };
      const hideSequence = {
        ...secondSequence,
        identifiers: {
          ...secondSequence.identifiers,
          label: `bstrip left ${secondSequence.identifiers.id}`,
        },
      };
      await stores.sendAndAwait({
        module: "CueCommand",
        command: { type: "StoreSequence", data: keepSequence },
      });
      await stores.sendAndAwait({
        module: "CueCommand",
        command: { type: "StoreSequence", data: hideSequence },
      });
      return {
        keepId: keepSequence.identifiers.id,
        keepLabel: keepSequence.identifiers.label,
        keepSequence,
        keepUid: keepSequence.identifiers.uid,
        hideId: hideSequence.identifiers.id,
        hideLabel: hideSequence.identifiers.label,
        hideSequence,
        hideUid: hideSequence.identifiers.uid,
      };
    },
    { firstSequence, secondSequence },
  );
  await expect
    .poll(() =>
      page.evaluate(({ keepUid, keepLabel, hideUid, hideLabel }) => {
        const sequences = (window as any).appStores.sequences.get();
        return (
          sequences[keepUid]?.identifiers.label === keepLabel &&
          sequences[hideUid]?.identifiers.label === hideLabel
        );
      }, context),
    )
    .toBe(true);
  return context;
}

/** Reapplies owned search sequences after backend hydration updates. */
async function applySearchSequences(
  page: Page,
  context: SearchSequenceContext,
): Promise<void> {
  await page.evaluate(({ keepSequence, hideSequence }) => {
    const stores = (window as any).appStores;
    stores.sequences.set({
      ...stores.sequences.get(),
      [keepSequence.identifiers.uid]: keepSequence,
      [hideSequence.identifiers.uid]: hideSequence,
    });
  }, context);
}

/** Opens a dedicated sequence-list panel for CRUD search assertions. */
async function openSequenceSearchPanel(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const api = (window as any).appStores.dockApi.get();
    const panelId = "panel-SequenceList-crud-search-e2e";
    api.getPanel("panel-SequenceList")?.api.close();
    api.getPanel(panelId)?.api.close();
    const referencePanel = api.getPanel("panel-FixtureGrid");
    api.addPanel({
      id: panelId,
      component: "SequenceList",
      title: "Sequences",
      params: { initialPanelId: panelId },
      ...(referencePanel
        ? {
            position: {
              referencePanel: referencePanel.id,
              direction: "within",
            },
          }
        : {}),
    });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    api.getPanel(panelId)?.api.setActive();
    api.getPanel(panelId)?.focus();
  });
}

/** Waits until the sequence list panel has loaded its toolbar controls. */
async function waitForSequenceSearchPanel(page: Page): Promise<void> {
  const retry = page.getByRole("button", { name: "Retry" }).first();
  if (await retry.isVisible({ timeout: 250 }).catch(() => false)) {
    await retry.click();
  }
  await expect(
    page.getByRole("button", { name: "Search sequences" }),
  ).toBeVisible({ timeout: 15_000 });
}

/** Deletes the sequences created by this spec. */
async function cleanupSearchSequences(
  page: Page,
  context: SearchSequenceContext,
): Promise<void> {
  await page.evaluate(async ({ keepId, hideId }) => {
    const stores = (window as any).appStores;
    await stores.sendAndAwait({
      module: "CueCommand",
      command: { type: "DeleteSequence", data: keepId },
    });
    await stores.sendAndAwait({
      module: "CueCommand",
      command: { type: "DeleteSequence", data: hideId },
    });
  }, context);
  await expect
    .poll(() =>
      page.evaluate(({ keepUid, hideUid }) => {
        const sequences = (window as any).appStores.sequences.get();
        return !sequences[keepUid] && !sequences[hideUid];
      }, context),
    )
    .toBe(true);
}

/** Presses the platform modifier search shortcut. */
async function pressModF(page: Page): Promise<void> {
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+F" : "Control+F",
  );
}

/** Checks toolbar filtering, keyboard controls, and the composite field's focus surface. */
test("CRUD toolbar search matches phrases without searching UIDs", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openOwnedCrudSearchApp(page);
  await waitForCrudStores(page);
  await openSequenceSearchPanel(page);
  await waitForSequenceSearchPanel(page);
  const context = await createSearchSequences(page);
  try {
    const keepCard = page.locator(
      `button[data-crud-select-id="${context.keepUid.toLowerCase()}"]:visible`,
    );
    const hideCard = page.locator(
      `button[data-crud-select-id="${context.hideUid.toLowerCase()}"]:visible`,
    );
    await expect(keepCard).toBeVisible();
    await expect(hideCard).toBeVisible();
    await expect(keepCard).toHaveCSS("width", "140px");
    await expect(keepCard).toHaveCSS("height", "60px");
    await keepCard.locator("..").screenshot({
      path: testInfo.outputPath("sequence-tiles.png"),
    });

    await page.getByRole("button", { name: "Search sequences" }).click();
    const searchInput = page.getByRole("searchbox", {
      name: "Search sequences",
    });
    await expect(searchInput).toBeFocused();
    await expect(searchInput).toHaveCSS("outline-style", "none");
    await expect(searchInput).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await page.getByRole("search").screenshot({
      path: testInfo.outputPath("toolbar-search-focused.png"),
    });
    await searchInput.fill("bstrip right");
    await applySearchSequences(page, context);
    await expect(keepCard).toBeVisible();
    await expect(hideCard).toHaveCount(0);

    await page.getByRole("button", { name: "Clear search" }).click();
    await applySearchSequences(page, context);
    await expect(keepCard).toBeVisible();
    await expect(hideCard).toBeVisible();

    await pressModF(page);
    await expect(searchInput).toBeFocused();
    await searchInput.fill("bstrip left");
    await applySearchSequences(page, context);
    await expect(keepCard).toHaveCount(0);
    await expect(hideCard).toBeVisible();

    await searchInput.fill(context.keepUid.slice(0, 8));
    await applySearchSequences(page, context);
    await expect(keepCard).toHaveCount(0);
    await expect(hideCard).toHaveCount(0);
    await expect(page.getByText("Loading sequences...")).toHaveCount(0);
    await expect(page.getByText("No matching sequences")).toBeVisible();

    await searchInput.press("Escape");
    await applySearchSequences(page, context);
    await expect(searchInput).toHaveCount(0);
    await expect(keepCard).toBeVisible();
    await expect(hideCard).toBeVisible();
  } finally {
    await cleanupSearchSequences(page, context);
  }
});
