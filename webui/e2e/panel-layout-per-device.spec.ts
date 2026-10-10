// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.setTimeout(60_000);

const LAYOUT_STORAGE_KEY = "nightfall-ui-layouts";

/** Seeds browser storage so startup opens the default showfile context. */
async function installBrowserStorageSeed(page: Page) {
  await page.addInitScript(() => {
    const seedKey = "nightfall.panelLayoutPerDeviceSeeded";
    if (!window.sessionStorage.getItem(seedKey)) {
      window.localStorage.clear();
      window.localStorage.setItem("nightfall.currentShowfileName", "default");
      window.sessionStorage.setItem(seedKey, "1");
    }
  });
}

/** Sends a desk command and throws when the backend reports an error. */
async function sendDeskCommand(page: Page, command: Record<string, unknown>) {
  const result = await page.evaluate(
    async (commandData) =>
      (window as any).appStores.sendAndAwait({
        module: "DeskCommand",
        command: commandData,
      }),
    command,
  );
  if (result.outcome.type === "Failed") {
    throw new Error(result.outcome.data.message);
  }
}

/** Returns whether Playwright lost the page context during an expected reload. */
function isNavigationContextError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("Execution context was destroyed")
  );
}

/** Sends a world-swap command and awaits the replacement backend resync. */
async function sendWorldSwapDeskCommand(
  page: Page,
  command: Record<string, unknown>,
) {
  try {
    await page.evaluate(
      (commandData) =>
        window.__nightfallTest.showfiles.swapWorld(
          commandData,
          typeof commandData.data === "string" ? commandData.data : "default",
          { timeoutMs: 15_000 },
        ),
      command,
    );
  } catch (error) {
    if (!isNavigationContextError(error)) throw error;
  }
  await waitForDockviewApp(page, { timeoutMs: 30_000 });
}

/**
 * Stores the current arrangement as a new named layout and makes it the
 * showfile's default, returning the layout id.
 */
async function storeArrangementAsDefaultLayout(page: Page, name: string) {
  return page.evaluate(async (layoutName) => {
    const { createNamedLayout, setDefaultLayout } = (
      await window.__nightfallHarness.load("app")
    ).layoutManagement;
    const api = (window as any).appStores.dockApi.get();
    const layout = await createNamedLayout(api, layoutName);
    if (!layout) throw new Error("Could not create layout");
    if (!(await setDefaultLayout(layout.id)))
      throw new Error("Could not set default layout");
    return layout.id as string;
  }, name);
}

/** Returns the serialized right edge group size saved in localStorage. */
async function savedRightEdgeGroupSize(page: Page) {
  return page.evaluate((storageKey) => {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return null;

    const state = JSON.parse(stored);
    return state.sessionLayout?.layout?.edgeGroups?.right?.size ?? null;
  }, LAYOUT_STORAGE_KEY);
}

/** Returns a compact summary of layout details under test. */
async function activeLayoutSummary(page: Page) {
  return page.evaluate(async () => {
    const api = (window as any).appStores.dockApi.get();
    const { createSerializedLayout } = (
      await window.__nightfallHarness.load("app")
    ).dockviewLayout;
    const layout = createSerializedLayout(api).layout as any;
    const programmerLocation = api.getPanel("panel-ProgrammerGrid")?.api
      .location;
    const propertiesLocation = api.getPanel("panel-PropertiesInspector")?.api
      .location;
    const rightEdgeGroup = api.getEdgeGroup("right");

    return {
      programmerEdgePosition:
        programmerLocation?.type === "edge"
          ? programmerLocation.position
          : null,
      programmerLocationType: programmerLocation?.type,
      propertiesEdgePosition:
        propertiesLocation?.type === "edge"
          ? propertiesLocation.position
          : null,
      propertiesLocationType: propertiesLocation?.type,
      rightCollapsed: rightEdgeGroup?.isCollapsed() ?? null,
      rightSerializedCollapsed: layout.edgeGroups?.right?.collapsed ?? null,
      rightSerializedSize: layout.edgeGroups?.right?.size ?? null,
      rightVisible: api.isEdgeGroupVisible("right"),
    };
  });
}

/** Moves the Programmer panel into the main grid to create a distinctive layout. */
async function moveProgrammerPanelToGrid(page: Page) {
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const programmerPanel = api.getPanel("panel-ProgrammerGrid");
    const mainGroup = api.getPanel("panel-Groups")?.api.group;

    programmerPanel?.api.moveTo({
      group: mainGroup,
      position: "center",
    });
  });
}

/** Sets the serialized right edge group shell state through the shared restore path. */
async function setRightEdgeGroupState(
  page: Page,
  options: { collapsed: boolean; size: number },
) {
  const helpers = await page.evaluateHandle(async () => ({
    ...(await window.__nightfallHarness.load("app")).dockviewLayout,
    ...(await window.__nightfallHarness.load("app")).layoutStorage,
  }));
  try {
    await page.evaluate(
      ({ helpers, collapsed, size }) => {
        const api = (window as any).appStores.dockApi.get();
        const serialized = helpers.createSerializedLayout(api);
        const layout = structuredClone(serialized.layout) as any;
        layout.edgeGroups.right = {
          ...layout.edgeGroups.right,
          collapsed,
          size,
          visible: true,
        };
        helpers.restoreSerializedLayout(api, { ...serialized, layout });
        helpers.saveLayout(api);
      },
      { helpers, ...options },
    );
  } catch (error) {
    if (!isNavigationContextError(error)) throw error;
    await waitForDockviewApp(page, { timeoutMs: 30_000 });
  } finally {
    await helpers.dispose();
  }
}

/** Applies a distinctive layout with panel movement and right edge state. */
async function arrangeDistinctiveLayout(page: Page) {
  await moveProgrammerPanelToGrid(page);
  await setRightEdgeGroupState(page, { collapsed: true, size: 520 });

  await expect
    .poll(() => activeLayoutSummary(page))
    .toMatchObject({
      programmerLocationType: "grid",
      propertiesEdgePosition: "right",
      propertiesLocationType: "edge",
      rightCollapsed: true,
      rightSerializedCollapsed: true,
      rightSerializedSize: 520,
      rightVisible: true,
    });
  await expect.poll(() => savedRightEdgeGroupSize(page)).toBeGreaterThan(500);
}

/** Applies a second layout that should be discarded by load/draft restore. */
async function arrangeDiscardedLayout(page: Page) {
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getEdgeGroup("right")?.expand();
    const propertiesPanel = api.getPanel("panel-PropertiesInspector");
    const mainGroup = api.getPanel("panel-Groups")?.api.group;

    propertiesPanel?.api.moveTo({
      group: mainGroup,
      position: "center",
    });
  });

  await expect
    .poll(() => activeLayoutSummary(page))
    .toMatchObject({
      propertiesLocationType: "grid",
      rightCollapsed: false,
    });
}

/**
 * Saves the showfile under a new name through the header command line and waits
 * until the browser adopts that name, so later header input cannot race the save.
 */
async function saveShowfileFromHeader(page: Page, showfileName: string) {
  const input = page.locator("#header-cmdline");
  await input.fill(`save ${showfileName}`);
  await input.press("Enter");
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.localStorage.getItem("nightfall.currentShowfileName"),
        ),
      { timeout: 20_000 },
    )
    .toBe(showfileName);
}

/** Submits a world-swap header command and waits for its replacement session. */
async function submitWorldSwapHeaderCommand(page: Page, command: string) {
  const previousGeneration = await page.evaluate(async () => {
    const websocket = window.__nightfallTest.runtime;
    return websocket.resyncGeneration();
  });

  const input = page.locator("#header-cmdline");
  await input.fill(command);
  await expect(
    page.getByRole("status", { name: "Command syntax valid." }),
  ).toBeVisible();
  await input.evaluate((element: HTMLInputElement) =>
    element.form?.requestSubmit(),
  );
  await expect(input).toHaveValue("");
  await expect
    .poll(
      () =>
        page.evaluate(async (generation) => {
          const websocket = window.__nightfallTest.runtime;
          return (
            websocket.resyncComplete() &&
            websocket.resyncGeneration() > generation
          );
        }, previousGeneration),
      { timeout: 30_000 },
    )
    .toBe(true);
  await waitForDockviewApp(page, { timeoutMs: 30_000 });
}

/** Verifies local session layout restores across a browser page refresh. */
test("restores unsaved active panel layout after page refresh", async ({
  backendSlot,
  page,
}) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await installBrowserStorageSeed(page);
  await page.goto("/?startup:draftRecovery=false");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);

  await arrangeDistinctiveLayout(page);
  await page.reload();
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);

  await expect
    .poll(() => activeLayoutSummary(page))
    .toMatchObject({
      programmerLocationType: "grid",
      propertiesEdgePosition: "right",
      propertiesLocationType: "edge",
      rightCollapsed: true,
      rightSerializedCollapsed: true,
      rightVisible: true,
    });
  await expect.poll(() => savedRightEdgeGroupSize(page)).toBeGreaterThan(500);
});

/** The arrangement summary `arrangeDistinctiveLayout` produces. */
const DISTINCTIVE_SUMMARY = {
  programmerLocationType: "grid",
  propertiesEdgePosition: "right",
  propertiesLocationType: "edge",
  rightCollapsed: true,
  rightSerializedCollapsed: true,
  rightVisible: true,
};

/** The arrangement summary `arrangeDiscardedLayout` produces. */
const DISCARDED_SUMMARY = {
  propertiesLocationType: "grid",
  rightCollapsed: false,
};

/** Verifies a device with no arrangement of its own opens the showfile's default layout. */
test("opens the showfile's default layout on a device without its own arrangement", async ({
  backendSlot,
  page,
}, testInfo) => {
  const showfileName = `defaultLayout${testInfo.workerIndex}${Date.now()}`;

  const otherShowfileName = await prepareFreshBackendShowfile(
    backendSlot.backendPort,
  );
  await installBrowserStorageSeed(page);
  await page.goto("/?startup:draftRecovery=false");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  // Keep the fresh show on disk so the test can switch back to it.
  await sendDeskCommand(page, { type: "SaveShowfile" });

  await arrangeDistinctiveLayout(page);
  const defaultLayoutId = await storeArrangementAsDefaultLayout(page, "Stage");
  await saveShowfileFromHeader(page, showfileName);

  // Work in another show, so this device's arrangement no longer belongs to
  // the saved one, as when a device opens a show it never arranged.
  await sendWorldSwapDeskCommand(page, {
    type: "LoadNamedShowfile",
    data: otherShowfileName,
  });
  await arrangeDiscardedLayout(page);
  await sendWorldSwapDeskCommand(page, {
    type: "LoadNamedShowfile",
    data: showfileName,
  });

  await expect
    .poll(() => activeLayoutSummary(page))
    .toMatchObject(DISTINCTIVE_SUMMARY);
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (
          await window.__nightfallHarness.load("app")
        ).layoutSwitcher.activeLayoutId.get(),
      ),
    )
    .toBe(defaultLayoutId);
});

/** Verifies reloading a showfile keeps the arrangement this device already made for it. */
test("keeps this device's arrangement when the same showfile loads again", async ({
  backendSlot,
  page,
}, testInfo) => {
  const showfileName = `deviceLayout${testInfo.workerIndex}${Date.now()}`;

  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await installBrowserStorageSeed(page);
  await page.goto("/?startup:draftRecovery=false");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);

  await arrangeDistinctiveLayout(page);
  await storeArrangementAsDefaultLayout(page, "Stage");
  await saveShowfileFromHeader(page, showfileName);
  await arrangeDiscardedLayout(page);

  await submitWorldSwapHeaderCommand(page, `load ${showfileName}`);

  await expect
    .poll(() => activeLayoutSummary(page))
    .toMatchObject(DISCARDED_SUMMARY);
});

/** Verifies saving the show on one device does not rearrange another device's panels. */
test("saving on another device leaves this device's panels alone", async ({
  backendSlot,
  page,
}) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await installBrowserStorageSeed(page);
  await page.goto("/?startup:draftRecovery=false");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await arrangeDistinctiveLayout(page);

  const otherPage = await page.context().newPage();
  await otherPage.goto("/?startup:draftRecovery=false");
  await expect(otherPage.locator("main#app")).toBeVisible();
  await waitForDockviewApp(otherPage);
  await arrangeDiscardedLayout(otherPage);

  /** Reads the settings snapshot revision this page has applied. */
  const settingsRevision = () =>
    page.evaluate(async () =>
      (
        await window.__nightfallHarness.load("app")
      ).settings.$settingsSnapshotRevision.get(),
    );
  const before = await settingsRevision();
  // The other device saves its arrangement into the shared layout, which
  // broadcasts new settings to every device, then saves the show.
  await otherPage.evaluate(async () => {
    const harness = await window.__nightfallHarness.load("app");
    const id = harness.layoutSwitcher.activeLayoutId.get();
    const api = (window as any).appStores.dockApi.get();
    if (!id || !(await harness.layoutManagement.saveNamedLayout(api, id)))
      throw new Error("Could not save the other device's layout");
  });
  await sendDeskCommand(otherPage, { type: "SaveShowfile" });
  await expect.poll(settingsRevision).toBeGreaterThan(before);

  await page.waitForTimeout(500);
  await expect
    .poll(() => activeLayoutSummary(page))
    .toMatchObject(DISTINCTIVE_SUMMARY);
  await otherPage.close();
});

/** Reads the id of the named layout this page has open. */
async function activeLayoutId(page: Page) {
  return page.evaluate(async () =>
    (
      await window.__nightfallHarness.load("app")
    ).layoutSwitcher.activeLayoutId.get(),
  );
}

/** Verifies saving the show under a new name keeps the arrangement this device made for it. */
test("save as keeps this device's arrangement", async ({
  backendSlot,
  page,
}, testInfo) => {
  const showfileName = `saveAsLayout${testInfo.workerIndex}${Date.now()}`;

  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await installBrowserStorageSeed(page);
  await page.goto("/?startup:draftRecovery=false");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await arrangeDistinctiveLayout(page);
  const layoutBefore = await activeLayoutId(page);

  await saveShowfileFromHeader(page, showfileName);
  await page.waitForTimeout(500);

  await expect
    .poll(() => activeLayoutSummary(page))
    .toMatchObject(DISTINCTIVE_SUMMARY);
  expect(await activeLayoutId(page)).toBe(layoutBefore);
});

/** Verifies crossing the compact breakpoint and back keeps the layout the operator switched to. */
test("returning from the compact view keeps the open layout", async ({
  backendSlot,
  page,
}) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await installBrowserStorageSeed(page);
  await page.goto("/?startup:draftRecovery=false");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);

  const otherId = await page.evaluate(async () => {
    const harness = await window.__nightfallHarness.load("app");
    const api = (window as any).appStores.dockApi.get();
    const layout = await harness.layoutManagement.createNamedLayout(
      api,
      "Other",
      true,
    );
    if (
      !layout ||
      !(await harness.layoutActivation.activateStoredLayout(api, layout.id))
    )
      throw new Error("Could not open the other layout");
    return layout.id as string;
  });
  await expect.poll(() => activeLayoutId(page)).toBe(otherId);

  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 500, height: size.height });
  await expect(page.getByRole("button", { name: "Panels" })).toBeVisible();
  await page.setViewportSize(size);
  await waitForDockviewApp(page);
  await page.waitForTimeout(500);

  expect(await activeLayoutId(page)).toBe(otherId);
});
