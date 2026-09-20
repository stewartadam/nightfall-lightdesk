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
    const seedKey = "nightfall.activePanelLayoutShowfileSeeded";
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
    await page.evaluate(async (commandData) => {
      const websocket = await import("/lib/engine-runtime.ts");
      const { waitForStartupWorldSwapCommand } = await import(
        "/components/shell/startup/readiness.ts"
      );
      const timeoutMs = 15_000;
      websocket.markResyncPending();
      await waitForStartupWorldSwapCommand(
        (window as any).appStores.sendAndAwait({
          module: "DeskCommand",
          command: commandData,
        }),
        timeoutMs,
        typeof commandData.data === "string" ? commandData.data : "default",
      );
    }, command);
  } catch (error) {
    if (!isNavigationContextError(error)) throw error;
  }
  await waitForDockviewApp(page, { timeoutMs: 30_000 });
}

/** Returns the current active panel layout as seen by the browser page. */
async function currentActivePanelLayout(page: Page) {
  return page.evaluate(async () => {
    const api = (window as any).appStores.dockApi.get();
    if (!api) {
      throw new Error("Dockview API unavailable");
    }
    const { createActivePanelLayout } = await import(
      "/lib/dockview-active-layout.ts"
    );
    return createActivePanelLayout(api);
  });
}

/** Sends a draft save command that captures the current browser Dockview layout. */
async function saveDraftShowfile(page: Page) {
  await sendDeskCommand(page, {
    type: "SaveDraftShowfile",
    data: {
      activePanelLayout: await currentActivePanelLayout(page),
    },
  });
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
    const { createSerializedLayout } = await import("/lib/dockview-layout.ts");
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
    const fixtureGroup = api.getPanel("panel-FixtureGrid")?.api.group;

    programmerPanel?.api.moveTo({
      group: fixtureGroup,
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
    ...(await import("/lib/dockview-layout.ts")),
    ...(await import("/lib/layoutStorage.ts")),
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
    const fixtureGroup = api.getPanel("panel-FixtureGrid")?.api.group;

    propertiesPanel?.api.moveTo({
      group: fixtureGroup,
      position: "center",
    });
  });

  await expect
    .poll(() => activeLayoutSummary(page))
    .toMatchObject({
      propertiesLocationType: "grid",
      rightVisible: false,
    });
}

/** Submits a command through the header command line. */
async function submitHeaderCommand(page: Page, command: string) {
  const input = page.locator("#header-cmdline");
  await input.fill(command);
  await input.press("Enter");
}

/** Submits a world-swap header command and waits for its replacement session. */
async function submitWorldSwapHeaderCommand(page: Page, command: string) {
  const previousGeneration = await page.evaluate(async () => {
    const websocket = await import("/lib/engine-runtime.ts");
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
          const websocket = await import("/lib/engine-runtime.ts");
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

/** Verifies saved showfile layout discards later unsaved panel changes on load. */
test("restores saved active panel layout on showfile load", async ({
  backendSlot,
  page,
}, testInfo) => {
  const showfileName = `activePanelLayout${testInfo.workerIndex}${Date.now()}`;

  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await installBrowserStorageSeed(page);
  await page.goto("/?startup:draftRecovery=false");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);

  await arrangeDistinctiveLayout(page);

  await submitHeaderCommand(page, `save ${showfileName}`);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.localStorage.getItem("nightfall.currentShowfileName"),
      ),
    )
    .toBe(showfileName);

  await arrangeDiscardedLayout(page);

  await page.evaluate(() => {
    window.localStorage.clear();
  });
  await sendWorldSwapDeskCommand(page, {
    type: "LoadNamedShowfile",
    data: showfileName,
  });

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

/** Verifies repeated command-line load settles on the saved showfile layout. */
test("keeps saved active panel layout after repeated command-line loads", async ({
  backendSlot,
  page,
}, testInfo) => {
  const showfileName = `activePanelRepeated${testInfo.workerIndex}${Date.now()}`;

  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await installBrowserStorageSeed(page);
  await page.goto("/?startup:draftRecovery=false");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);

  await arrangeDistinctiveLayout(page);
  await submitHeaderCommand(page, `save ${showfileName}`);

  await arrangeDiscardedLayout(page);
  await submitWorldSwapHeaderCommand(page, `load ${showfileName}`);
  await submitWorldSwapHeaderCommand(page, `load ${showfileName}`);

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
  await page.waitForTimeout(500);
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

/** Verifies draft load restores the save-time active panel layout. */
test("restores draft active panel layout after loading draft", async ({
  backendSlot,
  page,
}) => {
  const showfileName = await prepareFreshBackendShowfile(
    backendSlot.backendPort,
  );
  await installBrowserStorageSeed(page);
  await page.goto("/?startup:draftRecovery=false");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);

  await arrangeDistinctiveLayout(page);
  await saveDraftShowfile(page);
  await arrangeDiscardedLayout(page);

  await page.evaluate(() => {
    window.localStorage.clear();
  });
  await sendWorldSwapDeskCommand(page, {
    type: "LoadDraftShowfile",
    data: showfileName,
  });

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
