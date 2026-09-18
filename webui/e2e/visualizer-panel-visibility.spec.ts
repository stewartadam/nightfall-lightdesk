// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const VISUALIZER_PANEL_ID = "panel-Visualizer";
const OCCLUDER_PANEL_ID = "panel-Visualizer-occluder-e2e";

/** Opens a deterministic visualizer layout without restoring browser-local state. */
async function openVisualizerLayout(page: Page): Promise<void> {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/?e2e=1");
  await waitForDockviewApp(page);

  await page.evaluate((occluderPanelId) => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel(occluderPanelId)?.api.close();
    if (!api.getPanel("panel-Visualizer")) {
      throw new Error("Expected the default visualizer panel");
    }
  }, OCCLUDER_PANEL_ID);

  await expect
    .poll(() =>
      page.evaluate(
        (panelId) => Boolean((window as any).visualizerApis?.[panelId]),
        VISUALIZER_PANEL_ID,
      ),
    )
    .toBe(true);

  await page.getByRole("tab", { name: "3D Visualizer" }).click();
  await expect(
    page.getByRole("tab", {
      name: "3D Visualizer",
      selected: true,
    }),
  ).toBeVisible();
}

/** Returns whether the test visualizer renderer is currently paused. */
async function isVisualizerPaused(page: Page): Promise<boolean | undefined> {
  return page.evaluate(
    (panelId) => (window as any).visualizerApis?.[panelId]?.isPaused(),
    VISUALIZER_PANEL_ID,
  );
}

/**
 * Verifies merging the active panel into the visualizer group suspends the now-hidden renderer.
 */
test("pauses a visualizer hidden by a panel merge", async ({ page }) => {
  await openVisualizerLayout(page);
  await expect.poll(() => isVisualizerPaused(page)).toBe(false);

  await page.evaluate(
    ({ occluderPanelId, visualizerPanelId }) => {
      const api = (window as any).appStores.dockApi.get();
      api.addPanel({
        id: occluderPanelId,
        component: "PropertiesInspector",
        title: "Visualizer Occluder",
        params: { initialPanelId: occluderPanelId },
        position: {
          referencePanel: visualizerPanelId,
          direction: "right",
        },
      });
      api.getPanel(occluderPanelId)?.api.setActive();
    },
    {
      occluderPanelId: OCCLUDER_PANEL_ID,
      visualizerPanelId: VISUALIZER_PANEL_ID,
    },
  );

  await expect.poll(() => isVisualizerPaused(page)).toBe(false);

  const targetBox = await page.evaluate((visualizerPanelId) => {
    const api = (window as any).appStores.dockApi.get();
    const groupElement = api.getPanel(visualizerPanelId)?.group.element;
    const bounds = groupElement?.getBoundingClientRect();
    return bounds
      ? {
          height: bounds.height,
          width: bounds.width,
          x: bounds.x,
          y: bounds.y,
        }
      : null;
  }, VISUALIZER_PANEL_ID);
  if (!targetBox) {
    throw new Error("Expected the visualizer viewport bounds");
  }
  await page
    .getByRole("tab", { name: "Visualizer Occluder" })
    .dragTo(page.locator("body"), {
      force: true,
      targetPosition: {
        x: targetBox.x + targetBox.width / 2,
        y: targetBox.y + targetBox.height / 2,
      },
    });

  await expect(
    page.getByRole("tab", { name: "Visualizer Occluder", selected: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate((visualizerPanelId) => {
        const api = (window as any).appStores.dockApi.get();
        const visualizerPanel = api.getPanel(visualizerPanelId);
        return {
          activePanelId: visualizerPanel?.group.activePanel?.id,
          groupVisible: visualizerPanel?.group.api.isVisible,
          rendererPaused: (window as any).visualizerApis?.[
            visualizerPanelId
          ]?.isPaused(),
        };
      }, VISUALIZER_PANEL_ID),
    )
    .toEqual({
      activePanelId: OCCLUDER_PANEL_ID,
      groupVisible: true,
      rendererPaused: true,
    });

  await page.getByRole("tab", { name: "3D Visualizer" }).click();
  await expect.poll(() => isVisualizerPaused(page)).toBe(false);
});

/**
 * Verifies a worker that finishes initialization after its panel closes is
 * terminated before it can publish visualizer statistics.
 */
test("disposes a worker initialized after its visualizer panel closes", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const state = {
      created: 0,
      terminated: 0,
      gateReached: false,
      gateUsed: false,
      releaseGate: null as (() => void) | null,
    };
    (window as any).__visualizerWorkerLifecycleTest = state;

    /** Suspends only the first renderer initialization in this page. */
    async function waitAtFirstRendererInitialization(): Promise<void> {
      if (state.gateUsed) return;
      state.gateUsed = true;
      state.gateReached = true;
      await new Promise<void>((resolve) => {
        state.releaseGate = resolve;
      });
    }
    (window as any).__nightfallE2eVisualizerRendererInitializationGate =
      waitAtFirstRendererInitialization;

    /** Tracks visualizer worker creation and explicit termination. */
    class TrackingWorker extends NativeWorker {
      private readonly isVisualizerWorker: boolean;

      /** Creates a worker while recording visualizer renderer instances. */
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        this.isVisualizerWorker = String(scriptURL).includes("worker-renderer");
        if (this.isVisualizerWorker) state.created += 1;
      }

      /** Records explicit renderer disposal before terminating the worker. */
      override terminate(): void {
        if (this.isVisualizerWorker) state.terminated += 1;
        super.terminate();
      }
    }
    window.Worker = TrackingWorker;
    window.localStorage.clear();
  });

  await page.goto("/?e2e=1&visualizer:offscreenCanvas=true");
  await waitForDockviewApp(page);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (window as any).__visualizerWorkerLifecycleTest;
        return {
          created: state.created,
          gateReached: state.gateReached,
        };
      }),
    )
    .toEqual({ created: 1, gateReached: true });

  await page.evaluate((panelId) => {
    const api = (window as any).appStores.dockApi.get();
    const panel = api.getPanel(panelId);
    if (!panel) throw new Error("Expected the initializing visualizer panel");
    panel.api.close();
  }, VISUALIZER_PANEL_ID);
  await expect
    .poll(() =>
      page.evaluate(
        (panelId) =>
          Boolean((window as any).appStores.dockApi.get().getPanel(panelId)),
        VISUALIZER_PANEL_ID,
      ),
    )
    .toBe(false);

  await page.evaluate(() => {
    const state = (window as any).__visualizerWorkerLifecycleTest;
    if (!state.releaseGate) throw new Error("Expected the renderer test gate");
    state.releaseGate();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__visualizerWorkerLifecycleTest.terminated,
      ),
    )
    .toBe(1);
  await page.waitForTimeout(500);
  expect(
    await page.evaluate(() => (window as any).appStores.visualizerStats.get()),
  ).toBeNull();

  await page.evaluate((panelId) => {
    const api = (window as any).appStores.dockApi.get();
    const referencePanel =
      (api.activePanel?.api.location.type === "grid"
        ? api.activePanel
        : undefined) ??
      api.panels.find(
        (candidate: any) => candidate.api.location.type === "grid",
      );
    if (!referencePanel) throw new Error("Expected an active dock panel");
    const panel = api.addPanel({
      id: panelId,
      component: "Visualizer",
      title: "3D Visualizer",
      params: { initialPanelId: panelId },
      position: { referencePanel: referencePanel.id, direction: "within" },
    });
    panel.api.setActive();
    panel.focus();
  }, VISUALIZER_PANEL_ID);
  await expect
    .poll(() =>
      page.evaluate(
        (panelId) => (window as any).visualizerApis?.[panelId]?.isUsingWorker(),
        VISUALIZER_PANEL_ID,
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).appStores.visualizerStats.get()),
    )
    .toMatchObject({ renderMode: "worker" });

  const samples: number[] = [];
  for (let sample = 0; sample < 8; sample += 1) {
    await page.waitForTimeout(300);
    samples.push(
      await page.evaluate(
        () => (window as any).appStores.visualizerStats.get()?.fps,
      ),
    );
  }
  expect(samples.every(Number.isFinite)).toBe(true);
  expect(Math.max(...samples)).toBeLessThanOrEqual(70);
  expect(
    await page.evaluate(() => {
      const state = (window as any).__visualizerWorkerLifecycleTest;
      return { created: state.created, terminated: state.terminated };
    }),
  ).toEqual({ created: 2, terminated: 1 });

  await testInfo.attach("replacement-worker-visualizer", {
    body: await page
      .locator(
        `[data-component="Visualizer"][data-panel-id="${VISUALIZER_PANEL_ID}"]:visible`,
      )
      .screenshot(),
    contentType: "image/png",
  });
});
