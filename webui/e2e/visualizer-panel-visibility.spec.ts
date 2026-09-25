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

/**
 * Waits for startup, then for the showfile revision to stay unchanged long
 * enough to be settled. With a seeded showfile the backend's
 * CurrentShowfileChanged confirmation can arrive after the startup load's
 * command result has already bumped the revision, which restores the layout
 * (and remounts every panel) a second time after `waitForDockviewApp` returns.
 */
async function waitForSettledStartup(page: Page): Promise<void> {
  await waitForDockviewApp(page);
  /** Reads the showfile revision and the revision the layout was restored for. */
  const readRevisions = () =>
    page.evaluate(async () => {
      const [{ currentShowfileRevision }, layoutReadiness] = await Promise.all([
        import(/* @vite-ignore */ "/lib/showfile-loading.ts"),
        import(
          /* @vite-ignore */ "/components/shell/docking/layout-readiness.ts"
        ),
      ]);
      return {
        showfile: currentShowfileRevision.get(),
        layout: layoutReadiness.dockviewLayoutShowfileRevision.get(),
      };
    });
  let previous = await readRevisions();
  let stableSince = Date.now();
  await expect
    .poll(
      async () => {
        const current = await readRevisions();
        if (JSON.stringify(current) !== JSON.stringify(previous)) {
          previous = current;
          stableSince = Date.now();
        }
        return (
          current.layout >= current.showfile &&
          Date.now() - stableSince >= 3_000
        );
      },
      { timeout: 30_000, intervals: [250] },
    )
    .toBe(true);
  await waitForDockviewApp(page);
}

/**
 * Replaces whatever layout the seeded showfile restored with the default
 * layout, so panel geometry and drag targets do not depend on test data.
 */
async function resetToDefaultLayout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open command palette" }).click();
  const commandInput = page.getByPlaceholder("Type a command or search...");
  await expect(commandInput).toBeVisible();
  await commandInput.fill("Reset Layout");
  await page.keyboard.press("Enter");
  await expect(commandInput).toBeHidden();
}

/** Counts visualizer renderer workers created and explicitly terminated by the page. */
async function installWorkerTracking(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const state = { created: 0, terminated: 0 };
    (window as any).__visualizerWorkerTracking = state;
    /** Records creation and termination of visualizer renderer workers. */
    class TrackingWorker extends NativeWorker {
      private readonly isVisualizerWorker: boolean;

      /** Records creation of visualizer renderer workers. */
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        this.isVisualizerWorker = String(scriptURL).includes("worker-renderer");
        if (this.isVisualizerWorker) state.created += 1;
      }

      /** Records renderer disposal before terminating the worker. */
      override terminate(): void {
        if (this.isVisualizerWorker) state.terminated += 1;
        super.terminate();
      }
    }
    window.Worker = TrackingWorker;
  });
}

/** Reads the visualizer worker creation and termination counters. */
async function workerCounts(
  page: Page,
): Promise<{ created: number; terminated: number }> {
  return page.evaluate(() => {
    const state = (window as any).__visualizerWorkerTracking;
    return { created: state.created, terminated: state.terminated };
  });
}

/** Waits until the panel publishes a debug API whose renderer is running. */
async function waitForRunningVisualizer(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (panelId) =>
            (window as any).visualizerApis?.[panelId]?.isPaused() === false,
          VISUALIZER_PANEL_ID,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
}

/** Closes the test visualizer panel and waits until Dockview has removed it. */
async function closeVisualizerPanel(page: Page): Promise<void> {
  await page.evaluate((panelId) => {
    const api = (window as any).appStores.dockApi.get();
    const panel = api.getPanel(panelId);
    if (!panel) throw new Error("Expected the visualizer panel");
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
}

/** Opens the test visualizer panel as the active tab of a grid group. */
async function addVisualizerPanel(page: Page): Promise<void> {
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
}

/** Opens a deterministic visualizer layout without restoring browser-local state. */
async function openVisualizerLayout(page: Page): Promise<void> {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/?e2e=1");
  await waitForSettledStartup(page);
  await resetToDefaultLayout(page);

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

  // Merge through Dockview's move API (the operation a tab drop performs)
  // rather than a pointer drag, whose drop target depends on asynchronous
  // relayout of whatever layout the seeded showfile restored.
  await page.evaluate(
    ({ occluderPanelId, visualizerPanelId }) => {
      const api = (window as any).appStores.dockApi.get();
      api.getPanel(occluderPanelId).api.moveTo({
        group: api.getPanel(visualizerPanelId).group,
        position: "center",
      });
    },
    {
      occluderPanelId: OCCLUDER_PANEL_ID,
      visualizerPanelId: VISUALIZER_PANEL_ID,
    },
  );

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
  await installWorkerTracking(page);
  await page.addInitScript(() => {
    const gate = {
      armed: false,
      reached: false,
      release: null as (() => void) | null,
    };
    (window as any).__visualizerInitializationGate = gate;

    /** Suspends the next renderer initialization once the test arms the gate. */
    async function waitAtArmedRendererInitialization(): Promise<void> {
      if (!gate.armed) return;
      gate.armed = false;
      gate.reached = true;
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    }
    (window as any).__nightfallE2eVisualizerRendererInitializationGate =
      waitAtArmedRendererInitialization;
    window.localStorage.clear();
  });

  await page.goto("/?e2e=1&visualizer:offscreenCanvas=true");
  await waitForSettledStartup(page);
  await resetToDefaultLayout(page);
  // Startup may remount the panel when a seeded showfile restores its layout,
  // so gate a panel opened after startup has settled.
  await waitForRunningVisualizer(page);
  await closeVisualizerPanel(page);
  await expect
    .poll(async () => {
      const counts = await workerCounts(page);
      return counts.created > 0 && counts.created === counts.terminated;
    })
    .toBe(true);
  const baseline = await workerCounts(page);

  await page.evaluate(() => {
    (window as any).__visualizerInitializationGate.armed = true;
  });
  await addVisualizerPanel(page);
  await expect
    .poll(async () => ({
      ...(await workerCounts(page)),
      gateReached: await page.evaluate(
        () => (window as any).__visualizerInitializationGate.reached,
      ),
    }))
    .toEqual({
      created: baseline.created + 1,
      terminated: baseline.terminated,
      gateReached: true,
    });

  await closeVisualizerPanel(page);
  await page.evaluate(() => {
    const gate = (window as any).__visualizerInitializationGate;
    if (!gate.release) throw new Error("Expected the renderer test gate");
    gate.release();
  });
  await expect
    .poll(async () => (await workerCounts(page)).terminated)
    .toBe(baseline.terminated + 1);
  await page.waitForTimeout(500);
  expect(
    await page.evaluate(() => (window as any).appStores.visualizerStats.get()),
  ).toBeNull();

  await addVisualizerPanel(page);
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
  expect(await workerCounts(page)).toEqual({
    created: baseline.created + 2,
    terminated: baseline.terminated + 1,
  });

  await testInfo.attach("replacement-worker-visualizer", {
    body: await page
      .locator(
        `[data-component="Visualizer"][data-panel-id="${VISUALIZER_PANEL_ID}"]:visible`,
      )
      .screenshot(),
    contentType: "image/png",
  });
});

for (const offscreenCanvas of [true, false]) {
  const mode = offscreenCanvas ? "worker" : "main-thread";

  /**
   * Verifies a quality change remounts the renderer exactly once with the live
   * camera pose, republishes the debug API for the new renderer, and leaves the
   * replaced API inert so visibility changes cannot reach the disposed renderer.
   * The worker variant starts from a non-default persisted preset and the
   * main-thread variant from the diagnostic URL override, so neither relies on
   * the default quality.
   */
  test(`quality change keeps the camera and retires the old ${mode} renderer`, async ({
    page,
  }, testInfo) => {
    await installWorkerTracking(page);
    await page.addInitScript((persistLow) => {
      window.localStorage.clear();
      if (persistLow)
        window.localStorage.setItem(
          "nightfall-visualizer-settings",
          JSON.stringify({ qualityPreset: "low" }),
        );
    }, offscreenCanvas);
    await page.goto(
      `/?e2e=1&visualizer:offscreenCanvas=${offscreenCanvas}${offscreenCanvas ? "" : "&visualizer:beamQuality=low"}`,
    );
    await waitForSettledStartup(page);
    await waitForRunningVisualizer(page);
    expect(
      await page.evaluate(
        (panelId) => (window as any).visualizerApis[panelId].isUsingWorker(),
        VISUALIZER_PANEL_ID,
      ),
    ).toBe(offscreenCanvas);
    expect(
      await page.evaluate(async () => {
        const settings = await import("/features/visualizer/state/settings.ts");
        return settings.visualizerEffectiveQuality.get();
      }),
    ).toBe("low");
    // Startup may have replaced a renderer (e.g. a seeded layout restore);
    // exactly one must remain live before the quality change.
    await expect
      .poll(async () => {
        const counts = await workerCounts(page);
        return counts.created - counts.terminated;
      })
      .toBe(offscreenCanvas ? 1 : 0);
    const baseline = await workerCounts(page);

    const camera = {
      position: { x: -6.5, y: 3.25, z: 7.75 },
      target: { x: 1.5, y: 0.5, z: -2 },
    };
    await page.evaluate(
      ({ panelId, camera }) => {
        const api = (window as any).visualizerApis[panelId];
        (window as any).__replacedVisualizerApi = api;
        api.setCameraState(camera);
      },
      { panelId: VISUALIZER_PANEL_ID, camera },
    );

    await page.evaluate(async () => {
      const settings = await import("/features/visualizer/state/settings.ts");
      settings.visualizerQualityPreset.set("high");
    });

    await expect
      .poll(() =>
        page.evaluate((panelId) => {
          const api = (window as any).visualizerApis?.[panelId];
          return (
            Boolean(api) && api !== (window as any).__replacedVisualizerApi
          );
        }, VISUALIZER_PANEL_ID),
      )
      .toBe(true);

    /** Rounds camera coordinates so float transport noise cannot fail the comparison. */
    const readCamera = () =>
      page.evaluate(async (panelId) => {
        const state = await (window as any).visualizerApis[
          panelId
        ].getCameraState();
        const round = (v: { x: number; y: number; z: number }) => ({
          x: Math.round(v.x * 100) / 100,
          y: Math.round(v.y * 100) / 100,
          z: Math.round(v.z * 100) / 100,
        });
        return { position: round(state.position), target: round(state.target) };
      }, VISUALIZER_PANEL_ID);
    await expect.poll(readCamera).toEqual(camera);

    // The replaced handle must be inert: no renderer, no restarted loops.
    const replaced = await page.evaluate(() => {
      const api = (window as any).__replacedVisualizerApi;
      api.pause();
      api.resume();
      return { paused: api.isPaused(), scene: api.getScene() === undefined };
    });
    expect(replaced).toEqual({ paused: true, scene: true });

    await expect
      .poll(() =>
        page.evaluate(
          (panelId) => (window as any).visualizerApis[panelId].isPaused(),
          VISUALIZER_PANEL_ID,
        ),
      )
      .toBe(false);
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).appStores.visualizerStats.get()),
      )
      .toMatchObject({ renderMode: mode });
    const expected = offscreenCanvas
      ? { created: baseline.created + 1, terminated: baseline.terminated + 1 }
      : baseline;
    await expect.poll(() => workerCounts(page)).toEqual(expected);
    // No further renderer may appear once the new quality has settled.
    await page.waitForTimeout(500);
    expect(await workerCounts(page)).toEqual(expected);

    const screenshotPath = testInfo.outputPath(`quality-remount-${mode}.png`);
    await page
      .locator(
        `[data-component="Visualizer"][data-panel-id="${VISUALIZER_PANEL_ID}"]:visible`,
      )
      .screenshot({ path: screenshotPath });
    await testInfo.attach(`quality-remount-${mode}`, {
      path: screenshotPath,
      contentType: "image/png",
    });
  });
}

for (const inspector of [false, true]) {
  /**
   * Verifies the worker renderer publishes the shared instrumentation stats,
   * and includes frame-pacing and resolution diagnostics only when the
   * `visualizer:inspector` flag is set on the page URL.
   */
  test(`worker stats ${inspector ? "include" : "omit"} diagnostics ${inspector ? "with" : "without"} the inspector flag`, async ({
    page,
  }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await page.goto(
      `/?e2e=1&visualizer:offscreenCanvas=true&visualizer:inspector=${inspector}`,
    );
    await waitForDockviewApp(page);
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const stats = (window as any).appStores.visualizerStats.get();
            return stats && stats.fps > 0 ? stats.renderMode : null;
          }),
        { timeout: 60_000 },
      )
      .toBe("worker");
    const keys = await page.evaluate(() =>
      Object.keys((window as any).appStores.visualizerStats.get()),
    );
    expect(keys).toContain("updateFixturesMs");
    for (const key of ["framePacing", "sceneScale", "atmosphereScale"])
      expect(keys.includes(key), key).toBe(inspector);
  });
}
