// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const COMMAND_INPUT_PLACEHOLDER = "Type a command or search...";

/** Waits until the Dockview API is available through the dev app stores bridge. */
async function waitForDockview(page: Page) {
  await waitForDockviewApp(page);
}

/** Opens the command palette and filters to the requested command. */
async function filterCommand(page: Page, commandName: string) {
  await page.keyboard.press("Meta+Shift+P");

  const commandInput = page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER);
  await expect(commandInput).toBeVisible();
  await commandInput.fill(commandName);
}

test("panel navigation shortcuts delegate to Dockview focus traversal", async ({
  page,
}) => {
  await page.goto("/?e2e=1");
  await waitForDockview(page);

  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    (window as any).__dockTraversalCalls = [];

    const originalNext = api.activateNext.bind(api);
    const originalPrevious = api.activatePrevious.bind(api);
    (window as any).__restoreDockTraversal = () => {
      api.activateNext = originalNext;
      api.activatePrevious = originalPrevious;
    };

    api.activateNext = (options: unknown) => {
      (window as any).__dockTraversalCalls.push(["next", options]);
    };
    api.activatePrevious = (options: unknown) => {
      (window as any).__dockTraversalCalls.push(["previous", options]);
    };
  });

  await page.keyboard.press("Control+PageDown");
  await page.keyboard.press("Control+PageUp");

  await expect
    .poll(() => page.evaluate(() => (window as any).__dockTraversalCalls))
    .toEqual([
      ["next", { includePanel: true }],
      ["previous", { includePanel: true }],
    ]);

  await page.evaluate(() => (window as any).__restoreDockTraversal?.());
});

test("command palette modifiers position newly opened panels", async ({
  page,
}) => {
  await page.goto("/?e2e=1");
  await waitForDockview(page);

  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-PatchEditor")?.api.close();
    api.getPanel("panel-FixtureLibrary")?.api.close();
    api.getPanel("panel-ObjectLibrary")?.api.close();
    api.getPanel("panel-SequenceList")?.api.close();
    api.getPanel("panel-FixtureGrid")?.focus();
    (window as any).__activeDockGroup = {
      height: api.activeGroup.height,
      id: api.activeGroup.id,
      width: api.activeGroup.width,
    };
    (window as any).__dockAddPanelCalls = [];

    const originalAddPanel = api.addPanel.bind(api);
    (window as any).__restoreDockAddPanel = () => {
      api.addPanel = originalAddPanel;
    };

    api.addPanel = (options: any) => {
      (window as any).__dockAddPanelCalls.push({
        id: options.id,
        initialHeight: options.initialHeight,
        initialWidth: options.initialWidth,
        position: options.position,
      });
      return originalAddPanel(options);
    };
  });

  await filterCommand(page, "Open Patch");
  await page.keyboard.press("Control+Enter");

  await filterCommand(page, "Open Fixture Library");
  await page.keyboard.press("Meta+Enter");

  await filterCommand(page, "Open Sequences");
  await page.keyboard.press("Meta+Alt+Enter");

  await filterCommand(page, "Open Object Library");
  await page.keyboard.press("Meta+Alt+Shift+Enter");

  const activeGroup = await page.evaluate(
    () => (window as any).__activeDockGroup,
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).__dockAddPanelCalls))
    .toEqual([
      {
        id: "panel-PatchEditor",
        initialHeight: undefined,
        initialWidth: undefined,
        position: {
          direction: "right",
          referenceGroup: activeGroup.id,
        },
      },
      {
        id: "panel-FixtureLibrary",
        initialHeight: undefined,
        initialWidth: undefined,
        position: {
          direction: "below",
        },
      },
      {
        id: "panel-SequenceList",
        initialHeight: undefined,
        initialWidth: expect.any(Number),
        position: {
          direction: "right",
          referenceGroup: expect.any(String),
        },
      },
      {
        id: "panel-ObjectLibrary",
        initialHeight: undefined,
        initialWidth: expect.any(Number),
        position: {
          direction: "left",
          referenceGroup: expect.any(String),
        },
      },
    ]);

  await page.evaluate(() => (window as any).__restoreDockAddPanel?.());
});

test("command palette vertical splits stay inside the active group branch", async ({
  page,
}) => {
  await page.goto("/?e2e=1");
  await waitForDockview(page);

  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.clear();
    const cuePanel = api.addPanel({
      id: "panel-CueList",
      component: "CueList",
      title: "Cues",
      params: {},
    });
    api.addPanel({
      id: "panel-Visualizer",
      component: "Visualizer",
      title: "3D Visualizer",
      params: {},
      position: {
        direction: "right",
        referencePanel: cuePanel.id,
      },
    });
    cuePanel.focus();
  });

  const readLayout = () =>
    page.evaluate(() => {
      const api = (window as any).appStores.dockApi.get();
      const rectForPanel = (id: string) => {
        const panel = api.getPanel(id);
        if (!panel) return null;
        const rect = panel.group.element.getBoundingClientRect();
        return {
          height: rect.height,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          width: rect.width,
        };
      };

      return {
        cues: rectForPanel("panel-CueList"),
        objectLibrary: rectForPanel("panel-ObjectLibrary"),
        sequences: rectForPanel("panel-SequenceList"),
        visualizer: rectForPanel("panel-Visualizer"),
      };
    });

  const initialLayout = await readLayout();
  if (!initialLayout.cues || !initialLayout.visualizer) {
    throw new Error("Expected initial Cues and 3D Visualizer groups");
  }

  await filterCommand(page, "Open Sequences");
  await page.keyboard.press("Meta+Alt+Enter");

  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-CueList")?.focus();
  });
  await filterCommand(page, "Open Object Library");
  await page.keyboard.press("Meta+Alt+Shift+Enter");

  await expect.poll(readLayout).toEqual({
    cues: expect.objectContaining({ width: expect.any(Number) }),
    objectLibrary: expect.objectContaining({ width: expect.any(Number) }),
    sequences: expect.objectContaining({ width: expect.any(Number) }),
    visualizer: expect.objectContaining({ width: expect.any(Number) }),
  });
  const layout = await readLayout();

  expect(layout.objectLibrary!.right).toBeLessThanOrEqual(
    layout.cues!.left + 2,
  );
  expect(layout.cues!.right).toBeLessThanOrEqual(layout.sequences!.left + 2);
  expect(layout.sequences!.right).toBeLessThanOrEqual(
    layout.visualizer!.left + 2,
  );
  expect(Math.abs(layout.cues!.top - layout.sequences!.top)).toBeLessThan(3);
  expect(layout.visualizer!.width).toBeGreaterThan(
    initialLayout.visualizer.width - 16,
  );
});

test("command palette row placements stay outside the active group branch", async ({
  page,
}) => {
  await page.goto("/?e2e=1");
  await waitForDockview(page);

  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.clear();
    const cuePanel = api.addPanel({
      id: "panel-CueList",
      component: "CueList",
      title: "Cues",
      params: {},
    });
    api.addPanel({
      id: "panel-Visualizer",
      component: "Visualizer",
      title: "3D Visualizer",
      params: {},
      position: {
        direction: "right",
        referencePanel: cuePanel.id,
      },
    });
    cuePanel.focus();
  });

  const readLayout = () =>
    page.evaluate(() => {
      const api = (window as any).appStores.dockApi.get();
      const rectForPanel = (id: string) => {
        const panel = api.getPanel(id);
        if (!panel) return null;
        const rect = panel.group.element.getBoundingClientRect();
        return {
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          width: rect.width,
        };
      };

      return {
        cues: rectForPanel("panel-CueList"),
        patch: rectForPanel("panel-PatchEditor"),
        visualizer: rectForPanel("panel-Visualizer"),
      };
    });

  const initialLayout = await readLayout();
  if (!initialLayout.cues || !initialLayout.visualizer) {
    throw new Error("Expected initial Cues and 3D Visualizer groups");
  }

  await filterCommand(page, "Open Patch");
  await page.keyboard.press("Meta+Enter");

  await expect.poll(readLayout).toEqual({
    cues: expect.objectContaining({ width: expect.any(Number) }),
    patch: expect.objectContaining({ width: expect.any(Number) }),
    visualizer: expect.objectContaining({ width: expect.any(Number) }),
  });
  const layout = await readLayout();

  expect(layout.patch!.top).toBeGreaterThanOrEqual(layout.cues!.bottom - 4);
  expect(layout.patch!.left).toBeLessThanOrEqual(initialLayout.cues.left + 4);
  expect(Math.abs(layout.cues!.top - layout.visualizer!.top)).toBeLessThan(3);
});
