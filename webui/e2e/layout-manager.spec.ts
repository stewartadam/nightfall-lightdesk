// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const LAYOUT_STORAGE_KEY = "nightfall-ui-layouts";
const STORAGE_CLEARED_FLAG = "nightfall-layout-test-storage-cleared";

/** Shows overflow carets only where more layouts remain while keeping creation controls visible. */
test("layout list shows scroll indicators at overflow edges", async ({
  page,
}, testInfo) => {
  await clearLayoutStorageOnFirstLoad(page);
  await page.goto("/?e2e=1");
  await waitForDockview(page);
  await openCommandPaletteCommand(page, "Manage Layouts");
  const dialog = page.getByRole("dialog", { name: "Manage layouts" });
  const bottom = dialog.locator('[data-edge="bottom"]');
  const top = dialog.locator('[data-edge="top"]');
  await expect(bottom).toHaveAttribute("data-visible", "false");
  for (let index = 0; index < 12; index++) {
    await dialog.getByPlaceholder("Layout name").fill(`Layout ${index + 1}`);
    await dialog.getByRole("button", { name: "Store Current" }).click();
    await expect(dialog.getByPlaceholder("Layout name")).toHaveValue("");
  }
  await expect(bottom).toHaveAttribute("data-visible", "true");
  await expect(top).toHaveAttribute("data-visible", "false");
  await page.screenshot({
    path: testInfo.outputPath("layouts-overflow-top.png"),
  });
  await dialog.locator(".nf-scroll-viewport").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(top).toHaveAttribute("data-visible", "true");
  await expect(bottom).toHaveAttribute("data-visible", "false");
  await expect(
    dialog.getByRole("button", { name: "Store Current" }),
  ).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("layouts-overflow-bottom.png"),
  });
  await dialog.getByRole("button", { name: "Close layouts" }).click();
});

/**
 * Runs a command-palette command and waits for it to affect the layout.
 */
async function openCommandPaletteCommand(page: Page, commandName: string) {
  const shortcut =
    process.platform === "darwin" ? "Meta+Shift+P" : "Control+Shift+P";
  await page.keyboard.press(shortcut);

  const commandInput = page.getByPlaceholder("Type a command or search...");
  await expect(commandInput).toBeVisible();
  await commandInput.fill(commandName);
  await page.keyboard.press("Enter");
}

/**
 * Presses the browser-runtime close-panel shortcut.
 */
async function pressClosePanelShortcut(page: Page) {
  const modKey = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modKey}+K`);
  await page.keyboard.press("w");
}

/**
 * Presses the Tauri native close-panel shortcut.
 */
async function pressNativeClosePanelShortcut(page: Page) {
  const modKey = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modKey}+W`);
}

/** Clears layout storage once for the current test page's first app document. */
async function clearLayoutStorageOnFirstLoad(page: Page) {
  const clearToken = `clear-${Date.now()}-${Math.random()}`;
  await page.addInitScript(
    ({ flagKey, token }) => {
      if (window.sessionStorage.getItem(flagKey) === token) return;

      window.localStorage.clear();
      window.sessionStorage.setItem(flagKey, token);
    },
    { flagKey: STORAGE_CLEARED_FLAG, token: clearToken },
  );
}

/** Waits until the Dockview API is available through the test app stores. */
async function waitForDockview(page: Page) {
  await waitForDockviewApp(page);
}

/** Rebuilds the production default layout before testing layout persistence. */
async function resetToDefaultLayout(page: Page) {
  await openCommandPaletteCommand(page, "Reset Layout");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const api = (window as any).appStores.dockApi.get();
        return Boolean(
          api.getPanel("panel-Visualizer") && api.getEdgeGroup("right"),
        );
      }),
    )
    .toBe(true);
}

/** Expands the right edge group and waits for Dockview to report it expanded. */
async function expandRightEdgeGroup(page: Page) {
  await page.evaluate(() =>
    (window as any).appStores.dockApi.get().getEdgeGroup("right")?.expand(),
  );

  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.dockApi
          .get()
          .getEdgeGroup("right")
          ?.isCollapsed(),
      ),
    )
    .toBe(false);
}

/** Returns the current rendered width of the right edge group. */
async function rightEdgeGroupWidth(page: Page) {
  return page
    .locator(
      '[data-workspace-active="true"] [data-testid="dv-edge-group-edge-Properties"]',
    )
    .boundingBox()
    .then((box) => box?.width ?? 0);
}

/** Returns the right edge size captured for a named layout in local storage. */
async function storedLayoutRightEdgeSize(page: Page, layoutName: string) {
  return page.evaluate(
    ({ name, storageKey }) => {
      const stored = window.localStorage.getItem(storageKey);
      if (!stored) return null;

      const state = JSON.parse(stored);
      const layout = state.layouts?.find(
        (entry: { name?: string }) => entry.name === name,
      );
      return layout?.layout?.edgeGroups?.right?.size ?? null;
    },
    { name: layoutName, storageKey: LAYOUT_STORAGE_KEY },
  );
}

/** Returns the active stored layout name from local storage. */
async function activeStoredLayoutName(page: Page) {
  return page.evaluate((storageKey) => {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return null;

    const state = JSON.parse(stored);
    const layout = state.layouts?.find(
      (entry: { id?: string }) => entry.id === state.activeLayoutId,
    );
    return layout?.name ?? null;
  }, LAYOUT_STORAGE_KEY);
}

/** Returns the active session layout's right edge size from local storage. */
async function sessionLayoutRightEdgeSize(page: Page) {
  return page.evaluate((storageKey) => {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return null;

    const state = JSON.parse(stored);
    return state.sessionLayout?.layout?.edgeGroups?.right?.size ?? null;
  }, LAYOUT_STORAGE_KEY);
}

/** Returns Dockview's current serialized right edge shell size. */
async function currentSerializedRightEdgeSize(page: Page) {
  return page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    return api.toJSON()?.edgeGroups?.right?.size ?? null;
  });
}

/** Drags the right edge group's resize boundary to the requested width. */
async function resizeRightEdgeGroup(page: Page, targetWidth: number) {
  const box = await page
    .locator(
      '[data-workspace-active="true"] [data-testid="dv-edge-group-edge-Properties"]',
    )
    .boundingBox();
  if (!box) {
    throw new Error("Unable to resolve right edge group bounds");
  }

  const widthDelta = targetWidth - box.width;
  const sash = await page
    .locator('[data-workspace-active="true"] .dv-sash')
    .evaluateAll((elements, edge) => {
      const y = edge.y + edge.height / 2;
      return elements
        .map((element) => element.getBoundingClientRect())
        .filter(
          (rect) =>
            rect.width > 0 &&
            rect.width < 30 &&
            rect.top <= y &&
            rect.bottom >= y,
        )
        .sort(
          (a, b) =>
            Math.abs(a.x + a.width / 2 - edge.x) -
            Math.abs(b.x + b.width / 2 - edge.x),
        )
        .map((rect) => ({ x: rect.x + rect.width / 2, y }))[0];
    }, box);
  if (!sash) throw new Error("Unable to resolve the right edge resize handle");
  const sashX = sash.x;
  const sashY = sash.y;
  await page.mouse.move(sashX, sashY);
  await page.mouse.down();
  await page.mouse.move(sashX - widthDelta, sashY, { steps: 12 });
  await page.mouse.up();
}

/** Moves the Properties panel into the main grid so a layout load can restore it. */
async function movePropertiesPanelToGrid(page: Page) {
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const propertiesPanel = api.getPanel("panel-PropertiesInspector");
    const gridPanel =
      api.getPanel("panel-FixtureGrid") ??
      api.panels.find(
        (panel: any) =>
          panel.id !== "panel-PropertiesInspector" &&
          panel.api.location.type === "grid",
      );
    if (!gridPanel) {
      throw new Error("Unable to resolve a grid panel for Properties");
    }

    propertiesPanel?.api.moveTo({
      group: gridPanel.api.group,
      position: "center",
    });
  });

  await expect
    .poll(() =>
      page.evaluate(() => {
        const api = (window as any).appStores.dockApi.get();

        return {
          locationType: api.getPanel("panel-PropertiesInspector")?.api.location
            .type,
          rightVisible: api.isEdgeGroupVisible("right"),
        };
      }),
    )
    .toEqual({
      locationType: "grid",
      rightVisible: false,
    });
}

/** Verifies stored layouts can be managed through app-shell commands. */
test("stores and loads named panel layouts from the layout manager", async ({
  page,
}, testInfo) => {
  const layoutName = `Board Op ${testInfo.workerIndex}-${Date.now()}`;

  await clearLayoutStorageOnFirstLoad(page);

  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();

  await waitForDockview(page);
  await resetToDefaultLayout(page);

  await openCommandPaletteCommand(page, "Manage Layouts");

  const layoutsDialog = page.getByRole("dialog", { name: "Manage layouts" });
  await expect(layoutsDialog).toBeVisible();

  await layoutsDialog.getByPlaceholder("Layout name").fill(layoutName);
  await layoutsDialog
    .getByRole("button", { name: "Save current as new" })
    .click();

  await expect(
    layoutsDialog.getByText(layoutName, { exact: true }),
  ).toBeVisible();
  await expect.poll(() => activeStoredLayoutName(page)).not.toBe(layoutName);
  await page.screenshot({
    path: testInfo.outputPath("shared-layout-manager.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    layoutsDialog.getByRole("button", { name: "Save current as new" }),
  ).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("shared-layout-manager-narrow.png"),
  });
  await page.setViewportSize({ width: 1280, height: 720 });

  await layoutsDialog.getByRole("button", { name: "Close layouts" }).click();
  await expect(layoutsDialog).not.toBeVisible();

  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-Visualizer")?.api.close();
  });

  await expect(
    page.locator(".dv-tab").filter({ hasText: "3D Visualizer" }),
  ).not.toBeVisible();

  await page
    .getByRole("button", { name: new RegExp(`^Layout [0-9]+: ${layoutName}$`) })
    .click();

  await expect(
    page.locator(".dv-tab").filter({ hasText: "3D Visualizer" }).first(),
  ).toBeVisible();

  await page.reload();
  await expect(page.locator("main#app")).toBeVisible();
  await expect(
    page.locator(".dv-tab").filter({ hasText: "3D Visualizer" }).first(),
  ).toBeVisible();
});

/** Verifies named layouts preserve edge groups, contents, and edge sizes. */
test("stores and loads named layouts with edge panels and sizing", async ({
  page,
}, testInfo) => {
  const layoutName = `Edge Board ${testInfo.workerIndex}-${Date.now()}`;

  await clearLayoutStorageOnFirstLoad(page);

  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockview(page);
  await resetToDefaultLayout(page);

  await expandRightEdgeGroup(page);
  await resizeRightEdgeGroup(page, 520);
  await expect.poll(() => rightEdgeGroupWidth(page)).toBeGreaterThan(500);

  await openCommandPaletteCommand(page, "Manage Layouts");

  const layoutsDialog = page.getByRole("dialog", { name: "Manage layouts" });
  await expect(layoutsDialog).toBeVisible();

  await layoutsDialog.getByPlaceholder("Layout name").fill(layoutName);
  await layoutsDialog
    .getByRole("button", { name: "Save current as new" })
    .click();
  await expect(
    layoutsDialog.getByText(layoutName, { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => storedLayoutRightEdgeSize(page, layoutName))
    .toBeGreaterThan(500);
  await expect
    .poll(() => sessionLayoutRightEdgeSize(page))
    .toBeGreaterThan(500);
  await layoutsDialog.getByRole("button", { name: "Close layouts" }).click();
  await expect(layoutsDialog).not.toBeVisible();

  await movePropertiesPanelToGrid(page);
  await openCommandPaletteCommand(page, "Manage Layouts");
  await expect(layoutsDialog).toBeVisible();
  await layoutsDialog.getByRole("button", { name: "Close layouts" }).click();
  await page
    .getByRole("button", { name: new RegExp(`^Layout [0-9]+: ${layoutName}$`) })
    .click();
  await expect
    .poll(() => storedLayoutRightEdgeSize(page, layoutName))
    .toBeGreaterThan(500);
  await expect
    .poll(() => currentSerializedRightEdgeSize(page))
    .toBeGreaterThan(500);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const api = (window as any).appStores.dockApi.get();

        return {
          location: api.getPanel("panel-PropertiesInspector")?.api.location,
          rightCollapsed: api.getEdgeGroup("right")?.isCollapsed(),
          rightVisible: api.isEdgeGroupVisible("right"),
        };
      }),
    )
    .toEqual({
      location: { position: "right", type: "edge" },
      rightCollapsed: false,
      rightVisible: true,
    });
  await expect.poll(() => rightEdgeGroupWidth(page)).toBeGreaterThan(500);
});

/** Verifies the active session draft preserves edge sizes across page refresh. */
test("restores draft layout edge sizing after page refresh", async ({
  page,
}, testInfo) => {
  const layoutName = `Draft Edge ${testInfo.workerIndex}-${Date.now()}`;

  await clearLayoutStorageOnFirstLoad(page);

  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockview(page);
  await resetToDefaultLayout(page);

  await expandRightEdgeGroup(page);
  await resizeRightEdgeGroup(page, 520);
  await expect.poll(() => rightEdgeGroupWidth(page)).toBeGreaterThan(500);

  await openCommandPaletteCommand(page, "Manage Layouts");

  const layoutsDialog = page.getByRole("dialog", { name: "Manage layouts" });
  await expect(layoutsDialog).toBeVisible();
  await layoutsDialog.getByPlaceholder("Layout name").fill(layoutName);
  await layoutsDialog
    .getByRole("button", { name: "Save current as new" })
    .click();
  await expect(
    layoutsDialog.getByText(layoutName, { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => storedLayoutRightEdgeSize(page, layoutName))
    .toBeGreaterThan(500);
  await layoutsDialog.getByRole("button", { name: "Close layouts" }).click();
  await expect(layoutsDialog).not.toBeVisible();

  await page.reload();
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockview(page);

  await expect
    .poll(() => sessionLayoutRightEdgeSize(page))
    .toBeGreaterThan(500);
  await expect
    .poll(() => currentSerializedRightEdgeSize(page))
    .toBeGreaterThan(500);
  await expect.poll(() => rightEdgeGroupWidth(page)).toBeGreaterThan(500);
});

/** Verifies the app-level close-panel shortcut closes the active Dockview panel. */
test("closes the active panel with the close-panel shortcut", async ({
  page,
}) => {
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();

  await expect
    .poll(async () =>
      page.evaluate(() => Boolean((window as any).appStores?.dockApi?.get?.())),
    )
    .toBe(true);

  await openCommandPaletteCommand(page, "Open Patch");

  const patchTab = page.locator(".dv-tab").filter({ hasText: "Patch" });
  await expect(patchTab.first()).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(
        () => (window as any).appStores.dockApi.get()?.activePanel?.id,
      ),
    )
    .toBe("panel-PatchEditor");

  await pressClosePanelShortcut(page);

  await expect(patchTab).not.toBeVisible();
});

/** Verifies Tauri keeps the chord shortcut and adds the native close alias. */
test("closes the active panel with both Tauri close-panel shortcuts", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
      {};
  });
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();

  await waitForDockview(page);

  await openCommandPaletteCommand(page, "Open Patch");

  const patchTab = page.locator(".dv-tab").filter({ hasText: "Patch" });
  await expect(patchTab.first()).toBeVisible();

  await pressClosePanelShortcut(page);

  await expect(patchTab).not.toBeVisible();

  await openCommandPaletteCommand(page, "Open Patch");
  await expect(patchTab.first()).toBeVisible();

  await pressNativeClosePanelShortcut(page);

  await expect(patchTab).not.toBeVisible();
});
