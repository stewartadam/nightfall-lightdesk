// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const EDGE_DROP_HOLD_DELAY_MS = 500;
const LAYOUT_STORAGE_KEY = "nightfall-ui-layouts";
const COMMAND_INPUT_PLACEHOLDER = "Type a command or search...";

/** Seeds startup state so Dockview layout tests bypass the showfile picker. */
async function installDockviewStartupSeed(
  page: Page,
  options: { clearOnceKey?: string } = {},
) {
  await page.addInitScript(({ clearOnceKey }) => {
    window.sessionStorage.setItem(
      "nightfall.appLifecycle.viteFullReload",
      JSON.stringify({
        savedAtMs: Date.now(),
        state: {
          draftRecovery: null,
          phase: "interactive",
          recoveryError: null,
          startupDraftRecoveryChecked: true,
          startupDraftRecoveryEnabled: false,
        },
      }),
    );

    if (clearOnceKey && window.sessionStorage.getItem(clearOnceKey)) {
      return;
    }

    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
    if (clearOnceKey) {
      window.sessionStorage.setItem(clearOnceKey, "1");
    }
  }, options);
}

/** Waits until the Dockview API is available through the dev app stores bridge. */
async function waitForDockview(page: Page) {
  await waitForDockviewApp(page);
}

/** Runs one command through the command palette. */
async function runCommand(page: Page, commandName: string) {
  await page.keyboard.press("Meta+Shift+P");

  const commandInput = page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER);
  await expect(commandInput).toBeVisible();
  await commandInput.fill(commandName);
  await page.keyboard.press("Enter");
}

/** Opens the requested singleton panel through the command palette. */
async function openPanelCommand(page: Page, panelName: string) {
  await runCommand(page, `Open ${panelName}`);
}

/** Moves the Properties panel into the main grid so the right edge group is empty. */
async function emptyRightEdgeGroup(page: Page) {
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const propertiesPanel = api.getPanel("panel-PropertiesInspector");
    const fixtureGroup = api.getPanel("panel-FixtureGrid")?.api.group;

    propertiesPanel?.api.moveTo({
      group: fixtureGroup,
      position: "center",
    });
  });

  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.dockApi.get().isEdgeGroupVisible("right"),
      ),
    )
    .toBe(false);
}

/** Moves the Programmer panel into the main grid so the left edge group is empty. */
async function emptyLeftEdgeGroup(page: Page) {
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const programmerPanel = api.getPanel("panel-ProgrammerGrid");
    const fixtureGroup = api.getPanel("panel-FixtureGrid")?.api.group;

    programmerPanel?.api.moveTo({
      group: fixtureGroup,
      position: "center",
    });
  });

  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.dockApi.get().isEdgeGroupVisible("left"),
      ),
    )
    .toBe(false);
}

/** Expands the right edge group and waits until edge tabs are draggable. */
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
    .locator('[data-testid="dv-edge-group-edge-Properties"]')
    .boundingBox()
    .then((box) => box?.width ?? 0);
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

/** Drags the right edge group's resize boundary to the requested width. */
async function resizeRightEdgeGroup(page: Page, targetWidth: number) {
  const box = await page
    .locator('[data-testid="dv-edge-group-edge-Properties"]')
    .boundingBox();
  if (!box) {
    throw new Error("Unable to resolve right edge group bounds");
  }

  const widthDelta = targetWidth - box.width;
  const sashX = box.x;
  const sashY = box.y + box.height / 2;
  await page.mouse.move(sashX, sashY);
  await page.mouse.down();
  await page.mouse.move(sashX - widthDelta, sashY, { steps: 12 });
  await page.mouse.up();
}

/** Drags the Properties tab from an expanded edge group to the left-edge rail. */
async function dragEdgePropertiesTabToLeftEdge(page: Page) {
  const propertiesTab = page.getByRole("tab", { name: /Properties/ }).first();
  await expect(propertiesTab).toBeVisible();

  const sourceBox = await propertiesTab.boundingBox();
  if (!sourceBox) {
    throw new Error("Unable to resolve Properties tab bounds for edge drag");
  }

  const sourceX = sourceBox.x + sourceBox.width / 2;
  const sourceY = sourceBox.y + sourceBox.height / 2;

  await page.mouse.move(sourceX, sourceY);
  await page.mouse.down();
  await page.mouse.move(sourceX - 30, sourceY, { steps: 6 });
  await page.mouse.move(8, 120, { steps: 20 });
  await page.waitForTimeout(EDGE_DROP_HOLD_DELAY_MS + 100);
  await page.mouse.up();
}

/** Moves Properties from the right edge group to the hidden left edge group. */
async function moveEdgePropertiesTabToHiddenLeftEdge(page: Page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await expandRightEdgeGroup(page);
    await page.keyboard.down("Alt");
    try {
      await dragEdgePropertiesTabToLeftEdge(page);
    } finally {
      await page.keyboard.up("Alt");
    }

    const moved = await page
      .waitForFunction(
        () => {
          const api = (window as any).appStores.dockApi.get();
          const location = api.getPanel("panel-PropertiesInspector")?.api
            .location;

          return (
            api.isEdgeGroupVisible("left") &&
            location?.type === "edge" &&
            location.position === "left"
          );
        },
        undefined,
        { timeout: 2000 },
      )
      .then(() => true)
      .catch(() => false);

    if (moved) return;
  }
}

/** Drags the Properties tab to the app-owned right-edge rail. */
async function dragPropertiesTabToRightEdge(page: Page) {
  const propertiesTab = page.getByRole("tab", { name: /Properties/ }).first();
  await expect(propertiesTab).toBeVisible();

  const sourceBox = await propertiesTab.boundingBox();
  if (!sourceBox) {
    throw new Error("Unable to resolve Properties tab bounds for edge drag");
  }

  const viewport = page.viewportSize();
  if (!viewport) {
    throw new Error("Unable to resolve viewport bounds for edge drag");
  }

  const sourceX = sourceBox.x + sourceBox.width / 2;
  const sourceY = sourceBox.y + sourceBox.height / 2;

  await page.mouse.move(sourceX, sourceY);
  await page.mouse.down();
  await page.mouse.move(sourceX + 30, sourceY, { steps: 6 });
  await page.mouse.move(viewport.width - 2, 120, { steps: 20 });
  await page.mouse.up();
}

/** Drags the Properties tab into the center of an existing main-grid group. */
async function dragPropertiesTabToMainGridCenter(page: Page) {
  const propertiesTab = page.getByRole("tab", { name: /Properties/ }).first();
  await page.evaluate(() =>
    (window as any).appStores.dockApi
      .get()
      .getPanel("panel-FixtureGrid")
      ?.api.setActive(),
  );
  const fixturePanel = page.locator(
    '[data-panel-kind="fixtures"][data-panel-id="panel-FixtureGrid"]:visible',
  );
  await expect(propertiesTab).toBeVisible();
  await expect(fixturePanel).toBeVisible();

  const targetBox = await fixturePanel.boundingBox();
  if (!targetBox) {
    throw new Error("Unable to resolve main grid bounds for dockview drag");
  }

  await propertiesTab.dragTo(page.locator("body"), {
    force: true,
    targetPosition: {
      x: targetBox.x + targetBox.width / 2,
      y: targetBox.y + targetBox.height / 2,
    },
  });
}

/** Verifies empty edge padding follows panel moves and survives layout restoration. */
test("hidden empty edge groups preserve side insets across restoration", async ({
  page,
}, testInfo) => {
  await installDockviewStartupSeed(page);
  await page.goto("/?e2e=1");
  await waitForDockview(page);
  await runCommand(page, "Reset Layout");
  const host = page.getByTestId("dockview-host");
  for (const edge of ["left", "right", "bottom"]) {
    await expect(host).toHaveCSS(edge, "0px");
  }

  await emptyRightEdgeGroup(page);
  await expect(host).toHaveCSS("right", "16px");
  await expect(host).toHaveCSS("left", "0px");
  await expect(host).toHaveCSS("bottom", "0px");
  await emptyLeftEdgeGroup(page);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-CommandLine").api.moveTo({
      group: api.getPanel("panel-FixtureGrid").api.group,
      position: "center",
    });
  });
  for (const edge of ["left", "right", "bottom"]) {
    await expect(host).toHaveCSS(edge, edge === "bottom" ? "0px" : "16px");
  }
  await page.screenshot({
    path: testInfo.outputPath("empty-edge-padding.png"),
  });

  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.fromJSON(api.toJSON());
  });
  for (const edge of ["left", "right", "bottom"]) {
    await expect(host).toHaveCSS(edge, edge === "bottom" ? "0px" : "16px");
  }

  await page.keyboard.down("Alt");
  await dragPropertiesTabToRightEdge(page);
  await page.keyboard.up("Alt");
  await expect(host).toHaveCSS("right", "0px");
  await expect(host).toHaveCSS("left", "16px");
  await expect(host).toHaveCSS("bottom", "0px");

  await runCommand(page, "Reset Layout");
  for (const edge of ["left", "right", "bottom"]) {
    await expect(host).toHaveCSS(edge, "0px");
  }
});

/** Verifies the default layout seeds collapsible Dockview edge groups. */
test("default layout seeds collapsible edge panels", async ({ page }) => {
  await installDockviewStartupSeed(page);

  await page.goto("/?e2e=1");
  await waitForDockview(page);
  await runCommand(page, "Reset Layout");

  await expect(page.getByRole("tab", { name: /Programmer/ })).toBeVisible();
  await expect(
    page
      .getByTestId("dv-edge-group-edge-Console")
      .getByRole("tab", { name: "Console", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: /Properties/ })).toBeVisible();

  await expect
    .poll(() =>
      page.evaluate(() => {
        const api = (window as any).appStores.dockApi.get();

        return {
          bottomPosition: api.getEdgeGroup("bottom")?.location?.position,
          consoleCollapsed: api.getEdgeGroup("bottom")?.isCollapsed(),
          consoleLocation: api.getPanel("panel-CommandLine")?.api.location,
          leftCollapsed: api.getEdgeGroup("left")?.isCollapsed(),
          leftPosition: api.getEdgeGroup("left")?.location?.position,
          programmerLocation: api.getPanel("panel-ProgrammerGrid")?.api
            .location,
          propertiesCollapsed: api.getEdgeGroup("right")?.isCollapsed(),
          propertiesLocation: api.getPanel("panel-PropertiesInspector")?.api
            .location,
          rightPosition: api.getEdgeGroup("right")?.location?.position,
        };
      }),
    )
    .toEqual({
      bottomPosition: "bottom",
      consoleCollapsed: true,
      consoleLocation: { position: "bottom", type: "edge" },
      leftCollapsed: true,
      leftPosition: "left",
      programmerLocation: { position: "left", type: "edge" },
      propertiesCollapsed: true,
      propertiesLocation: { position: "right", type: "edge" },
      rightPosition: "right",
    });

  await expect
    .poll(async () => {
      const box = await page
        .locator('[data-testid="dv-edge-group-edge-Properties"]')
        .boundingBox();
      return box?.width ?? 0;
    })
    .toBeLessThanOrEqual(42);

  const propertiesTab = page.getByRole("tab", { name: /Properties/ });
  await propertiesTab.click();
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
});

/** Verifies command-opening an existing edge panel expands its collapsed edge group. */
test("command opening existing edge panel expands its edge group", async ({
  page,
}) => {
  await installDockviewStartupSeed(page);

  await page.goto("/?e2e=1");
  await waitForDockview(page);
  await runCommand(page, "Reset Layout");

  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.dockApi
          .get()
          .getEdgeGroup("right")
          ?.isCollapsed(),
      ),
    )
    .toBe(true);

  await openPanelCommand(page, "Properties");

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
  await expect.poll(() => rightEdgeGroupWidth(page)).toBeGreaterThan(260);
});

/** Verifies resized edge group sizes are persisted and restored with layouts. */
test("resized edge group sizes survive layout reload", async ({ page }) => {
  await installDockviewStartupSeed(page, {
    clearOnceKey: "edge-size-layout-test-cleared",
  });

  await page.goto("/?e2e=1");
  await waitForDockview(page);
  await expandRightEdgeGroup(page);

  await resizeRightEdgeGroup(page, 520);

  await expect.poll(() => rightEdgeGroupWidth(page)).toBeGreaterThan(500);
  await expect.poll(() => savedRightEdgeGroupSize(page)).toBeGreaterThan(500);

  await page.reload();
  await waitForDockview(page);

  await expect.poll(() => savedRightEdgeGroupSize(page)).toBeGreaterThan(500);
  await expandRightEdgeGroup(page);
  await expect.poll(() => rightEdgeGroupWidth(page)).toBeGreaterThan(500);
});

/** Verifies unarmed edge drops continue to use Dockview's normal grid behavior. */
test("unarmed edge drops do not enter hidden edge groups", async ({ page }) => {
  await installDockviewStartupSeed(page);

  await page.goto("/?e2e=1");
  await waitForDockview(page);
  await runCommand(page, "Reset Layout");
  await emptyRightEdgeGroup(page);
  await dragPropertiesTabToRightEdge(page);

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
});

/** Verifies edge-docked panels keep Dockview's normal tab drag behavior. */
test("edge-docked panels can be dragged back into the grid", async ({
  page,
}) => {
  await installDockviewStartupSeed(page);

  await page.goto("/?e2e=1");
  await waitForDockview(page);
  await runCommand(page, "Reset Layout");
  await expandRightEdgeGroup(page);

  await dragPropertiesTabToMainGridCenter(page);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const api = (window as any).appStores.dockApi.get();
        const fixturesGroupId = api.getPanel("panel-FixtureGrid")?.api.group.id;
        const propertiesGroupId = api.getPanel("panel-PropertiesInspector")?.api
          .group.id;

        return {
          isTabbedWithFixtures: fixturesGroupId === propertiesGroupId,
          locationType: api.getPanel("panel-PropertiesInspector")?.api.location
            .type,
          rightVisible: api.isEdgeGroupVisible("right"),
        };
      }),
    )
    .toEqual({
      isTabbedWithFixtures: true,
      locationType: "grid",
      rightVisible: false,
    });
});

/** Verifies edge-docked panels can use the modifier shortcut for other hidden edges. */
test("edge-docked panels can move to a hidden edge group", async ({ page }) => {
  await installDockviewStartupSeed(page);

  await page.goto("/?e2e=1");
  await waitForDockview(page);
  await runCommand(page, "Reset Layout");
  await emptyLeftEdgeGroup(page);
  await moveEdgePropertiesTabToHiddenLeftEdge(page);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const api = (window as any).appStores.dockApi.get();

        return {
          leftVisible: api.isEdgeGroupVisible("left"),
          location: api.getPanel("panel-PropertiesInspector")?.api.location,
        };
      }),
    )
    .toEqual({
      leftVisible: true,
      location: { position: "left", type: "edge" },
    });
});

/** Verifies the modifier shortcut routes hidden edge drops immediately. */
test("modifier edge drops reveal hidden edge groups immediately", async ({
  page,
}) => {
  await installDockviewStartupSeed(page);

  await page.goto("/?e2e=1");
  await waitForDockview(page);
  await runCommand(page, "Reset Layout");
  await emptyRightEdgeGroup(page);
  await page.keyboard.down("Alt");
  await dragPropertiesTabToRightEdge(page);
  await page.keyboard.up("Alt");

  await expect
    .poll(() =>
      page.evaluate(() => {
        const api = (window as any).appStores.dockApi.get();

        return {
          location: api.getPanel("panel-PropertiesInspector")?.api.location,
          rightVisible: api.isEdgeGroupVisible("right"),
        };
      }),
    )
    .toEqual({
      location: { position: "right", type: "edge" },
      rightVisible: true,
    });
});
