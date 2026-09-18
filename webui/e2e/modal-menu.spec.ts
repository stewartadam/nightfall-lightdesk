// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Starts each modal workflow with an isolated blank showfile before opening the UI. */
test.beforeEach(async ({ backendSlot }) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
});

/**
 * Opens the app shell with a clean layout.
 */
async function openApp(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => {
    window.localStorage.removeItem("nightfall-ui-layouts");
    window.localStorage.removeItem("nightfall.e2eAutoOpenStartupShowfile");
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
    window.localStorage.setItem("nightfall-patch-panel:active-tab", "fixtures");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
}

/**
 * Waits until the Dockview API is available on appStores.
 */
async function waitForDockApi(page: Page) {
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();

      /** Polls until the app shell has installed the Dockview API. */
      const tick = () => {
        const api = (window as any).appStores?.dockApi?.get?.();
        if (api) {
          resolve();
          return;
        }
        if (Date.now() - started > 15_000) {
          reject(new Error("dock API did not initialize"));
          return;
        }
        window.setTimeout(tick, 100);
      };
      tick();
    });
  });
}

/**
 * Adds a Patch panel and focuses it.
 */
async function addPatchPanel(page: Page) {
  await waitForDockApi(page);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-PatchEditor-modal-e2e")?.api.close();
    const referencePanel =
      (api.activePanel?.api.location.type === "grid"
        ? api.activePanel
        : undefined) ??
      api.panels.find(
        (candidate: any) => candidate.api.location.type === "grid",
      ) ??
      api.getPanel("panel-FixtureGrid");
    const nextPanel = api.addPanel({
      id: "panel-PatchEditor-modal-e2e",
      component: "PatchEditor",
      title: "Patch",
      params: {},
      ...(referencePanel
        ? {
            position: {
              referencePanel: referencePanel.id,
              direction: "within",
            },
          }
        : {}),
    });
    nextPanel.api.setActive();
    nextPanel.focus();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.dockApi.get().activePanel?.id,
      ),
    )
    .toBe("panel-PatchEditor-modal-e2e");
  await expect(
    page.locator(
      '[data-component="PatchEditor"][data-panel-id="panel-PatchEditor-modal-e2e"]',
    ),
  ).toBeVisible();
}

/**
 * Seeds enough fixture library rows for the wizard list to scroll.
 */
async function seedFixtureLibrary(page: Page) {
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    stores.fixtureLibrary.set(
      Array.from({ length: 40 }, (_unused, index) => ({
        make: "E2E",
        model: `Fixture ${String(index + 1).padStart(2, "0")}`,
        modes: ["Default"],
        source_format: "GDTF",
        asset_etag: `fixture-${index + 1}`,
      })),
    );
  });
}

/** Keeps the document locked while the fixture list scrolls independently of its preview. */
test("patch wizard locks body scroll and keeps preview fixed while fixture list scrolls", async ({
  page,
}) => {
  await openApp(page);
  await seedFixtureLibrary(page);
  await addPatchPanel(page);

  await page.getByRole("button", { name: "Add fixture", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Patch Wizard" });
  await expect(dialog).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.body.style.overflow))
    .toBe("hidden");

  const documentPanel = dialog.getByRole("document");
  const fixtureList = dialog.getByRole("region", { name: "Fixture library" });
  const preview = dialog.getByRole("region", { name: "Fixture preview" });
  const before = await preview.boundingBox();
  expect(before).toBeTruthy();

  await fixtureList.evaluate((element) => {
    element.scrollTop = 500;
  });
  await expect
    .poll(() => fixtureList.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect
    .poll(() => documentPanel.evaluate((element) => element.scrollTop))
    .toBe(0);

  const after = await preview.boundingBox();
  expect(after).toBeTruthy();
  expect(Math.round(after!.y)).toBe(Math.round(before!.y));

  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.body.style.overflow))
    .toBe("");
});

/** Verifies the status menu keeps context-menu row sizing while showing hotkeys. */
test("status menu displays hotkeys and opens keyboard shortcuts", async ({
  page,
}) => {
  await openApp(page);

  await page.locator('[title="Menu"]').click();
  const menu = page.locator('[data-menu-kind="dropdown"]').first();
  await expect(menu).toBeVisible();
  await expect(menu).toHaveCSS("min-width", "220px");
  const iconSlots = await menu
    .locator("button > span:first-child")
    .evaluateAll((slots) =>
      slots.map((slot) => {
        const rect = slot.getBoundingClientRect();
        return { height: rect.height, width: rect.width };
      }),
    );
  expect(iconSlots).not.toHaveLength(0);
  for (const slot of iconSlots) {
    expect(Math.round(slot.width)).toBe(16);
    expect(Math.round(slot.height)).toBe(16);
  }
  await expect(
    page.getByRole("button", { name: /New Showfile.*⌘⇧N/u }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Open Showfile.*⌘O/u }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Save Showfile.*⌘S/u }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Settings.*⌘,/u }),
  ).toBeVisible();

  await page.getByRole("button", { name: /Keyboard Shortcuts.*⇧\?/u }).click();
  await expect(page.locator('[data-dialog-kind="shortcuts"]')).toBeVisible();
});

/** Creates fixtures through the shared wizard controls and verifies the narrow layout keeps actions reachable. */
test("patch wizard uses shared forms to create fixtures at narrow width", async ({
  page,
}, testInfo) => {
  await openApp(page);
  await addPatchPanel(page);
  await page.getByRole("button", { name: "Add fixture", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Patch Wizard" });
  const filter = dialog.getByRole("textbox", { name: "Filter fixtures" });
  await filter.fill("Moving Head RGBW");
  await page.setViewportSize({ width: 390, height: 800 });
  await dialog.locator(".nf-dialog-surface").screenshot({
    path: testInfo.outputPath("shared-patch-picker.png"),
  });
  await dialog
    .getByRole("row")
    .filter({ hasText: "Generic" })
    .filter({ hasText: "Moving Head RGBW" })
    .click();
  await dialog.getByRole("button", { name: "Next", exact: true }).click();
  await dialog.getByRole("button", { name: "Spot", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Spot", exact: true }),
  ).toHaveCSS(
    "background-color",
    await dialog
      .getByRole("button", { name: "Next", exact: true })
      .evaluate((button) => getComputedStyle(button).backgroundColor),
  );
  await dialog.locator(".nf-dialog-surface").screenshot({
    path: testInfo.outputPath("shared-patch-modes.png"),
  });
  await dialog.getByRole("button", { name: "Next", exact: true }).click();
  const label = `Shared wizard ${Date.now()}`;
  await dialog.getByRole("textbox", { name: "Label (optional)" }).fill(label);
  await dialog
    .getByRole("spinbutton", { name: "Quantity", exact: true })
    .fill("2");
  await dialog.getByRole("checkbox", { name: "Assign Console DMX" }).uncheck();
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(dialog.locator(".nf-dialog-surface")).toHaveClass(
    /nf-patch-wizard/,
  );
  expect(
    await dialog
      .locator(".nf-dialog-body")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  const next = dialog.getByRole("button", { name: "Next", exact: true });
  const box = (await next.boundingBox())!;
  expect(box.y + box.height).toBeLessThan(800);
  await dialog
    .locator(".nf-dialog-surface")
    .screenshot({ path: testInfo.outputPath("shared-patch-configure.png") });
  await next.click();
  await dialog.getByRole("button", { name: "Finish", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(
        (label) =>
          Object.values((window as any).appStores.fixtures.get()).filter(
            (f: any) => f.identifiers.label.startsWith(label),
          ).length,
        label,
      ),
    )
    .toBe(2);
});

/** Creates a built-in scene object using the shared searchable wizard at a narrow viewport. */
test("object wizard filters selects and creates with shared controls", async ({
  page,
}, testInfo) => {
  await openApp(page);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.addPanel({
      id: "shared-object-wizard",
      component: "SceneObjects",
      title: "Scene Objects",
      params: {},
    });
  });
  await page.getByRole("button", { name: "Add object", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add Object", exact: true });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Add Object", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("textbox", { name: "Search objects" }).fill("Truss");
  await dialog.getByRole("button", { name: /Truss.*Structural truss/ }).click();
  await dialog.getByRole("spinbutton", { name: "Quantity" }).fill("2");
  const before = await page.evaluate(
    () => Object.keys((window as any).appStores.sceneObjects.get()).length,
  );
  await page.setViewportSize({ width: 390, height: 800 });
  expect(
    await dialog
      .locator(".nf-dialog-body")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await dialog.screenshot({
    path: testInfo.outputPath("shared-object-wizard.png"),
  });
  await dialog.getByRole("button", { name: "Add Object", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as any).appStores.sceneObjects.get()).length,
      ),
    )
    .toBe(before + 2);
});
