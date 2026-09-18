// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { writeFile } from "node:fs/promises";
import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.setTimeout(90_000);

/** Content and viewport sizing stay clean indefinitely, while real divider drags remain unsaved edits. */
test("distinguishes delayed automatic sizing from divider edits", async ({
  page,
  backendSlot,
}, testInfo) => {
  await setupSlots(page, backendSlot.backendPort);
  await slotAction(page, 1, "Revert");
  const slot = page.locator(".nf-layout-slot").filter({
    has: page.getByRole("button", {
      name: "Layout 1: Programming",
      exact: true,
    }),
  });
  await expect(slot).toHaveAttribute("data-modified", "false");
  const widths = await page.evaluate(async () => {
    const api = (window as any).appStores.dockApi.get();
    const group = api.getPanel("panel-Visualizer").group;
    const before = group.api.width;
    await new Promise((resolve) => setTimeout(resolve, 600));
    group.api.setSize({ width: 500 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    return [before, group.api.width];
  });
  expect(widths[0]).not.toBe(widths[1]);
  await expect(slot).toHaveAttribute("data-modified", "false");
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.waitForTimeout(250);
  await expect(slot).toHaveAttribute("data-modified", "false");
  /** Drags a tall interior divider rather than an edge rail or hidden workspace handle. */
  const dragDivider = async () => {
    const handles = await page
      .locator('[data-workspace-active="true"] .dv-sash:visible')
      .evaluateAll((elements) =>
        elements.map((element) => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        }),
      );
    const handle = handles.find(
      ({ x, width, height }) =>
        x > 200 && x < 1200 && height > 300 && width < 20,
    );
    if (!handle) throw new Error("No interior divider");
    await page.mouse.move(
      handle.x + handle.width / 2,
      handle.y + handle.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(handle.x - 80, handle.y + handle.height / 2, {
      steps: 10,
    });
    await page.mouse.up();
  };
  await dragDivider();
  await expect(slot).toHaveAttribute("data-modified", "true");
  await page.setViewportSize({ width: 1450, height: 900 });
  await page.waitForTimeout(250);
  await expect(slot).toHaveAttribute("data-modified", "true");
  await slotAction(page, 1, "Save");
  await expect(slot).toHaveAttribute("data-modified", "false");
  await dragDivider();
  await expect(slot).toHaveAttribute("data-modified", "true");
  await slotAction(page, 1, "Revert");
  await page.waitForTimeout(700);
  await expect(slot).toHaveAttribute("data-modified", "false");
  await page.screenshot({
    path: testInfo.outputPath("automatic-sizing-clean.png"),
  });
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.addFloatingGroup(api.getPanel("panel-Visualizer"), {
      x: 100,
      y: 100,
      width: 500,
      height: 400,
      dragHandle: "titlebar",
    });
  });
  await slotAction(page, 1, "Save");
  await expect(slot).toHaveAttribute("data-modified", "false");
  const titlebar = await page
    .locator('[data-workspace-active="true"] .dv-floating-titlebar')
    .boundingBox();
  if (!titlebar) throw new Error("No floating titlebar");
  await page.mouse.move(titlebar.x + 120, titlebar.y + 15);
  await page.mouse.down();
  await page.mouse.move(titlebar.x + 200, titlebar.y + 65, { steps: 10 });
  await page.mouse.up();
  await expect(slot).toHaveAttribute("data-modified", "true");
  await slotAction(page, 1, "Revert");
  await expect(slot).toHaveAttribute("data-modified", "false");
});

/** A failed revert preserves the outgoing workspace even when reduced motion completes presentation immediately. */
test("preserves the working layout when revert cannot persist", async ({
  page,
  backendSlot,
}) => {
  await setupSlots(page, backendSlot.backendPort);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const result = await page.evaluate(async () => {
    const { revertNamedLayout } = await import("/lib/layout-management.ts");
    const { layoutStorageStore } = await import("/lib/layoutStorage.ts");
    const { activeLayoutId } = await import("/state/layout-switcher.ts");
    const api = (window as any).appStores.dockApi.get();
    const element = document.querySelector('[data-workspace-active="true"]');
    const set = layoutStorageStore.set;
    /** Simulates unavailable session persistence during the activation commit. */
    layoutStorageStore.set = () => {
      throw new Error("Simulated storage failure");
    };
    try {
      const reverted = await revertNamedLayout(api, activeLayoutId.get()!);
      return {
        reverted,
        retained: element?.isConnected,
        sameApi: api === (window as any).appStores.dockApi.get(),
      };
    } finally {
      layoutStorageStore.set = set;
    }
  });
  expect(result).toEqual({ reverted: false, retained: true, sameApi: true });
  await expect(
    page.getByRole("tab", { name: "3D Visualizer", exact: true }),
  ).toBeVisible();
});

/** Restored layouts remain clean after deferred edge constraints and viewport sizing finish. */
test("reverted snapshots stay clean after settling", async ({
  page,
  backendSlot,
}, testInfo) => {
  await openFreshWorkspace(page, backendSlot.backendPort);
  await expect(
    page.getByRole("button", { name: "Layout 1: Your Layout", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const ids = await page.evaluate(async () => {
    const { editLayouts } = await import("/lib/layout-management.ts");
    const { createBlankStoredLayout } = await import("/lib/layoutStorage.ts");
    const { createSerializedLayout } = await import("/lib/dockview-layout.ts");
    const api = (window as any).appStores.dockApi.get();
    const blank = createBlankStoredLayout(api);
    const populated = {
      ...createBlankStoredLayout(api),
      ...createSerializedLayout(api),
      name: "Restored panels",
    };
    for (const edge of Object.values(
      (populated.layout as any).edgeGroups,
    ) as any[])
      delete edge.minimumSize;
    await editLayouts((existing) => [...existing, blank, populated]);
    return [blank.id, populated.id];
  });
  for (const id of ids) {
    await page.evaluate(async (id) => {
      const { activateStoredLayout } = await import(
        "/lib/layout-activation.ts"
      );
      const { revertNamedLayout } = await import("/lib/layout-management.ts");
      await activateStoredLayout((window as any).appStores.dockApi.get(), id);
      if (
        !(await revertNamedLayout((window as any).appStores.dockApi.get(), id))
      )
        throw new Error("Revert failed");
    }, id);
    const states = await page.evaluate(async (id) => {
      const { modifiedLayoutIds } = await import("/state/layout-switcher.ts");
      const values = [modifiedLayoutIds.get().includes(id)];
      const unsubscribe = modifiedLayoutIds.subscribe((ids) =>
        values.push(ids.includes(id)),
      );
      await new Promise((resolve) => setTimeout(resolve, 700));
      unsubscribe();
      return values;
    }, id);
    expect(
      states.every((dirty) => !dirty),
      JSON.stringify(states),
    ).toBe(true);
  }
  await page.screenshot({
    path: testInfo.outputPath("reverted-clean-layout.png"),
  });
  await page.evaluate(() =>
    (window as any).appStores.dockApi
      .get()
      .panels[0].api.setTitle("Edited after revert"),
  );
  await expect(
    page.locator('.nf-layout-slot[data-active="true"]'),
  ).toHaveAttribute("data-modified", "true");
});

/** Reverting discards only the chosen working copy, and saved snapshots clear the modified marker. */
test("marks modified layouts and reverts active and inactive working copies", async ({
  page,
  backendSlot,
}, testInfo) => {
  await setupSlots(page, backendSlot.backendPort);
  const programming = page.getByRole("button", {
    name: "Layout 1: Programming",
    exact: true,
  });
  const playback = page.getByRole("button", {
    name: "Layout 2: Playback",
    exact: true,
  });
  const slot = page.locator(".nf-layout-slot").filter({ has: programming });
  await expect(slot).toHaveAttribute("data-modified", "false");
  /** Changes a panel title to make an observable arrangement edit. */
  const rename = (title: string) =>
    page.evaluate(
      (value) =>
        (window as any).appStores.dockApi
          .get()
          .getPanel("panel-Visualizer")
          .api.setTitle(value),
      title,
    );
  await rename("Unsaved visualizer");
  await expect(slot).toHaveAttribute("data-modified", "true");
  await page.screenshot({ path: testInfo.outputPath("modified-layout.png") });
  await slotAction(page, 1, "Revert");
  await expect(slot).toHaveAttribute("data-modified", "false");
  await expect(
    page.getByRole("tab", { name: "3D Visualizer", exact: true }),
  ).toBeVisible();
  await rename("Saved visualizer");
  await slotAction(page, 1, "Save");
  await expect(slot).toHaveAttribute("data-modified", "false");
  await rename("Discarded visualizer");
  await playback.click();
  await expect(slot).toHaveAttribute("data-modified", "true");
  await slotAction(page, 1, "Revert");
  await expect(playback).toHaveAttribute("aria-pressed", "true");
  await expect(slot).toHaveAttribute("data-modified", "false");
  await programming.click();
  await expect(
    page.getByRole("tab", { name: "Saved visualizer", exact: true }),
  ).toBeVisible();
  await expect(slot).toHaveAttribute("data-modified", "false");
  await page.screenshot({ path: testInfo.outputPath("reverted-layout.png") });
});

/** Older saved layouts remain discoverable when they lack explicit switcher visibility. */
test("restores saved layouts without visibility metadata", async ({
  page,
  backendSlot,
}) => {
  await openFreshWorkspace(page, backendSlot.backendPort);
  await expect(
    page.getByRole("button", { name: "Layout 1: Your Layout", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const result = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const { getShowfilePanelLayouts } = await import("/lib/layoutStorage.ts");
    return stores.sendAndAwait({
      module: "SettingsCommand",
      command: {
        type: "SetPanelLayouts",
        data: [
          ...getShowfilePanelLayouts(),
          {
            id: "older-layout",
            name: "Saved arrangement",
            version: 2,
            createdAt: 1,
            updatedAt: 1,
            layout: {
              grid: {
                width: 1000,
                height: 700,
                orientation: "HORIZONTAL",
                root: {
                  type: "branch",
                  size: 700,
                  data: [
                    {
                      type: "leaf",
                      size: 1000,
                      data: {
                        id: "saved-group",
                        views: ["saved-sequences"],
                        activeView: "saved-sequences",
                      },
                    },
                  ],
                },
              },
              panels: {
                "saved-sequences": {
                  id: "saved-sequences",
                  contentComponent: "ExecutorList",
                  title: "Saved sequences",
                },
              },
            },
            panels: [
              { id: "saved-sequences", title: "Saved sequences", params: {} },
            ],
          },
        ],
      },
    });
  });
  expect(result.outcome.type).not.toBe("Failed");
  const layout = page.getByRole("button", {
    name: "Layout 2: Saved arrangement",
    exact: true,
  });
  await layout.click();
  await expect(layout).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("tab", { name: "Saved sequences", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as any).appStores.dockApi.get().toJSON().panels[
          "saved-sequences"
        ].contentComponent,
    ),
  ).toBe("ClipList");
});

/** Waits for saving and slot motion to finish before hovering controls or capturing their settled positions. */
async function settleSlotMotion(page: Page) {
  await expect(
    page.getByRole("button", {
      name: "Options for layout 1",
      exact: true,
    }),
  ).toBeEnabled();
  await page.locator(".nf-layout-slot").evaluateAll(async (elements) => {
    await Promise.all(
      elements.flatMap((element) =>
        element
          .getAnimations()
          .map((animation) => animation.finished.catch(() => {})),
      ),
    );
  });
}

/** Runs a shell command through the same palette used by end users. */
async function command(page: Page, name: string) {
  await page.getByRole("button", { name: "Open command palette" }).click();
  await page.getByPlaceholder("Type a command or search...").fill(name);
  await page
    .locator("[data-command-id]")
    .filter({ hasText: name })
    .first()
    .click();
}

/** Stores the live arrangement through the layout manager. */
async function saveLayout(page: Page, name: string) {
  await command(page, "Manage Layouts");
  const dialog = page.getByRole("dialog", { name: "Manage layouts" });
  await dialog.getByPlaceholder("Layout name").fill(name);
  await dialog.getByRole("button", { name: "Save current as new" }).click();
  await expect(dialog.getByText(name, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close layouts" }).click();
}

/** Starts a fresh showfile without replaying a seeded startup layout. */
async function openFreshWorkspace(page: Page, backendPort: number) {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("layout-switcher-seeded")) {
      localStorage.clear();
      sessionStorage.setItem("layout-switcher-seeded", "true");
    }
  });
  await page.goto("/?startup:draftRecovery=false");
  await waitForDockviewApp(page);
}

/** Creates two visible saved layouts and hides the initial layout after activating Programming. */
async function setupSlots(page: Page, backendPort: number) {
  await openFreshWorkspace(page, backendPort);
  await expect(
    page.getByRole("button", { name: "Layout 1: Your Layout", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await command(page, "Reset Layout");
  await saveLayout(page, "Programming");
  await page.evaluate(() =>
    (window as any).appStores.dockApi
      .get()
      .getPanel("panel-Visualizer")
      .api.close(),
  );
  await saveLayout(page, "Playback");
  await page
    .getByRole("button", { name: "Layout 2: Programming", exact: true })
    .click();
  await slotAction(page, 1, "Hide from switcher");
  await expect(
    page.getByRole("button", { name: "Layout 1: Programming", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await settleSlotMotion(page);
}

/** Opens one slot's menu and invokes a named action. */
async function slotAction(page: Page, slot: number, action: string) {
  await page
    .getByRole("button", { name: new RegExp(`^Layout ${slot}:`) })
    .hover();
  await page
    .getByRole("button", {
      name: `Options for layout ${slot}`,
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: action, exact: true }).click();
}

/** Proves customized arrangements survive repeated recalls and explicit save updates the selected snapshot. */
test("remembers slot arrangements, supports keyboard recall, and saves its own snapshot", async ({
  page,
  backendSlot,
}, testInfo) => {
  await setupSlots(page, backendSlot.backendPort);
  const programming = page.getByRole("button", {
    name: "Layout 1: Programming",
    exact: true,
  });
  const playback = page.getByRole("button", {
    name: "Layout 2: Playback",
    exact: true,
  });
  const options = page.getByRole("button", {
    name: "Options for layout 1",
    exact: true,
  });
  await expect(options).toHaveCSS("opacity", "0");
  await programming.hover();
  await expect(options).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: testInfo.outputPath("layout-switcher-hover.png"),
  });
  await page.mouse.move(0, 400);
  await expect(options).toHaveCSS("opacity", "0");
  await programming.focus();
  await page.keyboard.press("Tab");
  await expect(options).toBeFocused();
  await expect(options).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Save", exact: true }).focus();
  await expect(options).toHaveCSS("opacity", "1");
  await page.keyboard.press("Escape");
  await programming.click();
  await expect(programming).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() =>
    (window as any).appStores.dockApi
      .get()
      .getPanel("panel-Visualizer")
      .api.setTitle("Working visualizer"),
  );
  await programming.click();
  await expect(
    page
      .locator('[data-workspace-active="true"] .dv-tab:visible')
      .filter({ hasText: "Working visualizer" }),
  ).toBeVisible();
  await page.keyboard.press("F2");
  await expect(playback).toHaveAttribute("aria-pressed", "true");
  await expect(
    page
      .locator('[data-workspace-active="true"] .dv-tab:visible')
      .filter({ hasText: "Working visualizer" }),
  ).toHaveCount(0);
  await page.keyboard.press("F1");
  await expect(
    page
      .locator('[data-workspace-active="true"] .dv-tab:visible')
      .filter({ hasText: "Working visualizer" }),
  ).toBeVisible();
  await playback.click();
  await expect(programming).toHaveAttribute("aria-pressed", "false");
  await programming.click();
  await expect(
    page
      .locator('[data-workspace-active="true"] .dv-tab:visible')
      .filter({ hasText: "Working visualizer" }),
  ).toBeVisible();
  await page.mouse.move(0, 400);
  await expect(page.locator(".toastify")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("layout-switcher-working-copy.png"),
  });
  await slotAction(page, 1, "Save");
  await expect(
    page
      .locator('[data-workspace-active="true"] .dv-tab:visible')
      .filter({ hasText: "Working visualizer" }),
  ).toBeVisible();
  await playback.click();
  await programming.click();
  await expect(
    page
      .locator('[data-workspace-active="true"] .dv-tab:visible')
      .filter({ hasText: "Working visualizer" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 700, height: 800 });
  await expect(
    page.getByRole("button", { name: "Manage layouts" }),
  ).toBeInViewport();
  await playback.focus();
  await page.keyboard.press("Space");
  await expect(playback).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({
    path: testInfo.outputPath("layout-switcher-narrow.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Manage layouts" }),
  ).toBeInViewport();
  await programming.click();
  await expect(programming).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({
    path: testInfo.outputPath("layout-switcher-mobile.png"),
  });
});

/** Measures retained workspaces while proving view identity, viewport preservation, and renderer suspension. */
test("retains live timeline views and measures parked workspace overhead", async ({
  page,
  backendSlot,
}, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openFreshWorkspace(page, backendSlot.backendPort);
  await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const timecodeUid = crypto.randomUUID().replaceAll("-", "");
    const timelineUid = crypto.randomUUID().replaceAll("-", "");
    await stores.sendAndAwait({
      module: "TimecodeCommand",
      command: {
        type: "StoreTimecode",
        data: {
          identifiers: {
            id: 990001,
            uid: timecodeUid,
            label: "Workspace measurement",
          },
          rate: "Fps30",
          source: "Internal",
        },
      },
    });
    await stores.sendAndAwait({
      module: "TimelineCommand",
      command: {
        type: "StoreTimeline",
        data: {
          identifiers: {
            id: 990002,
            uid: timelineUid,
            label: "Workspace measurement",
          },
          timecode_uid: timecodeUid,
          timecode_start: { secs: 0, nanos: 0 },
          audio_path: "",
          tracks: [],
          markers: [
            {
              uid: crypto.randomUUID().replaceAll("-", ""),
              label: "End",
              time: { secs: 120, nanos: 0 },
            },
          ],
          regions: [],
          bpm: 120,
          beats_per_bar: 4,
          use_beat_grid: false,
          scroll_mode: "free",
        },
      },
    });
    (window as any).workspaceTimelineUid = timelineUid;
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window as any).appStores.timelines.get()[
            (window as any).workspaceTimelineUid
          ],
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.clear();
    api.addPanel({
      id: "workspace-timeline",
      component: "Timeline",
      title: "Retained timeline",
      params: { initialTimelineUid: (window as any).workspaceTimelineUid },
    });
    api.addPanel({
      id: "panel-Visualizer",
      component: "Visualizer",
      title: "3D Visualizer",
      position: { referencePanel: "workspace-timeline", direction: "right" },
    });
  });
  await expect(
    page.locator('[data-timeline-scroll-container="true"]'),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean((window as any).visualizerApis?.["panel-Visualizer"]),
      ),
    )
    .toBe(true);
  await saveLayout(page, "Measurement");
  await page.evaluate(async () => {
    const { getShowfilePanelLayouts } = await import("/lib/layoutStorage.ts");
    const { editLayouts } = await import("/lib/layout-management.ts");
    const layout = getShowfilePanelLayouts().find(
      (entry: any) => entry.name === "Measurement",
    );
    if (!layout) throw new Error("Missing measurement layout");
    await editLayouts((layouts) => [
      ...layouts,
      ...Array.from({ length: 4 }, (_, index) => ({
        ...layout,
        id: `measure-${index}`,
        name: `Measurement ${index}`,
      })),
    ]);
  });

  /** Recalls a slot and times activation through the next rendered frame. */
  const recall = (index: number) =>
    page.evaluate(async (slot) => {
      const { activateStoredLayout } = await import(
        "/lib/layout-activation.ts"
      );
      const start = performance.now();
      const ok = await activateStoredLayout(
        (window as any).appStores.dockApi.get(),
        `measure-${slot}`,
      );
      if (!ok) throw new Error("Workspace recall failed");
      const activationMs = performance.now() - start;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      return { activationMs, paintedMs: performance.now() - start };
    }, index);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  /** Samples post-GC heap and main-thread task time over a two-second idle window. */
  const measure = async (label: string) => {
    await cdp.send("HeapProfiler.collectGarbage");
    const before = Object.fromEntries(
      (await cdp.send("Performance.getMetrics")).metrics.map((metric) => [
        metric.name,
        metric.value,
      ]),
    );
    await page.waitForTimeout(2000);
    const after = Object.fromEntries(
      (await cdp.send("Performance.getMetrics")).metrics.map((metric) => [
        metric.name,
        metric.value,
      ]),
    );
    return {
      label,
      heapMiB: before.JSHeapUsedSize / 1024 / 1024,
      nodes: before.Nodes,
      taskMsPerSecond:
        ((after.TaskDuration - before.TaskDuration) * 1000) /
        (after.Timestamp - before.Timestamp),
    };
  };

  await recall(0);
  const scroll = page.locator(
    '[data-workspace-active="true"] [data-timeline-scroll-container="true"]',
  );
  await expect(scroll).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).visualizerApis?.["panel-Visualizer"]?.isPaused(),
      ),
    )
    .toBe(false);
  await page.evaluate(async () => {
    await (window as any).appStores.sendAndAwait({
      module: "TimecodeCommand",
      command: {
        type: "SeekTimecode",
        data: { id: 990001, position: { secs: 5, nanos: 0 } },
      },
    });
  });
  await scroll.evaluate((element) => {
    element.scrollLeft = 347;
    (window as any).retainedTimelineScroll = element;
  });
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollLeft))
    .toBe(347);
  await page.evaluate(() => {
    (window as any).retainedWorkspaceApi = (
      window as any
    ).appStores.dockApi.get();
    (window as any).retainedVisualizerApi = (window as any).visualizerApis?.[
      "panel-Visualizer"
    ];
  });
  const measurements = [await measure("one workspace")];
  await recall(1);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).retainedVisualizerApi.isPaused()),
    )
    .toBe(true);
  measurements.push(await measure("two workspaces"));
  await recall(2);
  await recall(3);
  measurements.push(await measure("four workspaces"));
  const switches = [];
  for (let index = 0; index < 20; index += 1)
    switches.push(await recall(index % 4));
  await recall(0);
  await expect(scroll).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as any).retainedTimelineScroll ===
        document.querySelector(
          '[data-workspace-active="true"] [data-timeline-scroll-container="true"]',
        ),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () =>
        (window as any).retainedWorkspaceApi ===
        (window as any).appStores.dockApi.get(),
    ),
  ).toBe(true);
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollLeft))
    .toBe(347);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).retainedVisualizerApi.isPaused()),
    )
    .toBe(false);
  await expect(page.locator("[data-layout-workspace]")).toHaveCount(5);
  measurements.push(await measure("five workspaces after 20 switches"));
  await page.screenshot({
    path: testInfo.outputPath("retained-timeline-workspace.png"),
  });
  const measurementPath = testInfo.outputPath("workspace-performance.json");
  await writeFile(
    measurementPath,
    JSON.stringify({ measurements, switches }, null, 2),
  );
  await testInfo.attach("workspace-performance.json", {
    path: measurementPath,
    contentType: "application/json",
  });
  await page.setViewportSize({ width: 1100, height: 800 });
  await recall(1);
  await recall(0);
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollLeft))
    .toBe(347);
  const timeDisplay = page
    .locator('[data-workspace-active="true"] .timeline-position-display')
    .filter({ hasText: "SMPTE" });
  await page
    .getByRole("button", { name: "Play timeline", exact: true })
    .click();
  try {
    await expect(
      page.getByRole("button", { name: "Pause timeline", exact: true }),
    ).toBeVisible();
    await recall(1);
    const parkedDisplay = page
      .locator('[data-workspace-active="false"] .timeline-position-display')
      .filter({ hasText: "SMPTE" })
      .first();
    const parkedTime = await parkedDisplay.textContent();
    await page.waitForTimeout(400);
    expect(await parkedDisplay.textContent()).toBe(parkedTime);
    await recall(0);
    await expect(timeDisplay).not.toHaveText(parkedTime!);
  } finally {
    await page
      .getByRole("button", { name: "Stop timeline", exact: true })
      .click();
  }
  await slotAction(page, 2, "Save");
  await expect(page.locator("[data-layout-workspace]")).toHaveCount(5);
  await recall(1);
  await expect(page.locator("[data-layout-workspace]")).toHaveCount(5);
  expect(errors).toEqual([]);
});

/** Dragging changes slot order without recalling or remounting the active workspace. */
test("drags slots in both directions while preserving the active workspace", async ({
  page,
  backendSlot,
}, testInfo) => {
  await setupSlots(page, backendSlot.backendPort);
  await page
    .getByRole("button", { name: "Layout 1: Programming", exact: true })
    .click();
  await page.evaluate(() => {
    (window as any).slotDragApi = (window as any).appStores.dockApi.get();
    (window as any).slotDragApi
      .getPanel("panel-Visualizer")
      .api.setTitle("Retained while dragging");
  });
  const playback = page.getByRole("button", {
    name: "Layout 2: Playback",
    exact: true,
  });
  const bounds = await playback.boundingBox();
  if (!bounds) throw new Error("Playback slot is not visible");
  await page
    .getByRole("button", { name: "Layout 1: Programming", exact: true })
    .dragTo(playback, { targetPosition: { x: bounds.width - 2, y: 16 } });
  const moved = page.getByRole("button", {
    name: "Layout 2: Programming",
    exact: true,
  });
  await expect(moved).toHaveAttribute("aria-pressed", "true");
  expect(
    await page.evaluate(
      () =>
        (window as any).slotDragApi === (window as any).appStores.dockApi.get(),
    ),
  ).toBe(true);
  await expect(
    page.getByRole("tab", { name: "Retained while dragging" }),
  ).toBeVisible();
  await settleSlotMotion(page);
  await page.screenshot({
    path: testInfo.outputPath("layout-slots-dragged-right.png"),
  });
  await moved.dragTo(
    page.getByRole("button", { name: "Layout 1: Playback", exact: true }),
    { targetPosition: { x: 2, y: 16 } },
  );
  const restored = page.getByRole("button", {
    name: "Layout 1: Programming",
    exact: true,
  });
  await expect(restored).toHaveAttribute("aria-pressed", "true");
  expect(
    await page.evaluate(
      () =>
        (window as any).slotDragApi === (window as any).appStores.dockApi.get(),
    ),
  ).toBe(true);
  await settleSlotMotion(page);
  await restored.hover();
  await page
    .getByRole("button", { name: "Options for layout 1", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Move left", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Move right", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("layout-slot-menu-without-move-actions.png"),
  });
});

/** Reorder previews move before drop, cancellation restores order, and workspace motion honors reduced motion. */
test("animates drag previews and layout changes with a reduced-motion fallback", async ({
  page,
  backendSlot,
}, testInfo) => {
  await setupSlots(page, backendSlot.backendPort);
  const orderBefore = await page.evaluate(() =>
    (window as any).appStores.settings
      .get()
      .panel_layouts.filter((layout: any) => layout.shownInSwitcher)
      .map((layout: any) => layout.id),
  );
  const first = page.getByRole("button", {
    name: "Layout 1: Programming",
    exact: true,
  });
  const second = page.getByRole("button", {
    name: "Layout 2: Playback",
    exact: true,
  });
  const source = await first.boundingBox();
  const target = await second.boundingBox();
  if (!source || !target) throw new Error("Expected both layout slots");
  await page.mouse.move(source.x + 20, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + 30, source.y + source.height / 2, {
    steps: 3,
  });
  await page.mouse.move(
    target.x + target.width - 2,
    target.y + target.height / 2,
    { steps: 10 },
  );
  await expect(
    page.getByRole("button", {
      name: "Layout 2: Programming",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).appStores.settings
        .get()
        .panel_layouts.filter((layout: any) => layout.shownInSwitcher)
        .map((layout: any) => layout.id),
    ),
  ).toEqual(orderBefore);
  await page.screenshot({
    path: testInfo.outputPath("layout-slot-drag-preview.png"),
  });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(first).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).appStores.settings
        .get()
        .panel_layouts.filter((layout: any) => layout.shownInSwitcher)
        .map((layout: any) => layout.id),
    ),
  ).toEqual(orderBefore);

  /** Recalls a slot and reads browser animations after their first scheduled frame. */
  const switchWithMotion = () =>
    page.evaluate(async () => {
      const { activateStoredLayout } = await import(
        "/lib/layout-activation.ts"
      );
      const { activeLayoutId } = await import("/state/layout-switcher.ts");
      const { getShowfilePanelLayouts } = await import("/lib/layoutStorage.ts");
      const slot = getShowfilePanelLayouts().find(
        (entry: any) =>
          entry.shownInSwitcher && entry.id !== activeLayoutId.get(),
      );
      if (!slot) throw new Error("Expected another visible layout");
      if (
        !(await activateStoredLayout(
          (window as any).appStores.dockApi.get(),
          slot.id,
        ))
      )
        throw new Error("Recall failed");
      await new Promise(requestAnimationFrame);
      const element = document.querySelector('[data-workspace-active="true"]')!;
      return element.getAnimations().map((animation) => animation.playState);
    });
  expect(await switchWithMotion()).toContain("running");
  await page
    .locator('[data-workspace-active="true"]')
    .evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      );
    });
  await page.screenshot({
    path: testInfo.outputPath("layout-workspace-after-transition.png"),
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await switchWithMotion()).toEqual([]);
});

/** Slot clicks paint directional motion using the current order, including after drag reordering. */
test("paints content transitions during repeated slot clicks", async ({
  page,
  backendSlot,
}, testInfo) => {
  await setupSlots(page, backendSlot.backendPort);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  // Finish the setup activation before measuring an idle click on the active layout.
  await expect(page.locator('[data-workspace-active="true"]')).toHaveCSS(
    "transform",
    "none",
  );
  for (const [index, name] of [
    "Programming",
    "Playback",
    "Programming",
    "Playback",
  ].entries()) {
    if (index === 2) {
      const target = page.getByRole("button", {
        name: "Layout 2: Playback",
        exact: true,
      });
      const bounds = await target.boundingBox();
      if (!bounds) throw new Error("Expected the destination tab");
      await page
        .getByRole("button", {
          name: "Layout 1: Programming",
          exact: true,
        })
        .dragTo(target, { targetPosition: { x: bounds.width - 2, y: 16 } });
      await expect(
        page.getByRole("button", {
          name: "Layout 2: Programming",
          exact: true,
        }),
      ).toBeVisible();
      await settleSlotMotion(page);
    }
    const direction = await page
      .locator('[aria-label="Layout switcher"]')
      .evaluate((element, destination) => {
        const tabs = [
          ...element.querySelectorAll<HTMLButtonElement>("[aria-pressed]"),
        ];
        const source = tabs.findIndex(
          (tab) => tab.getAttribute("aria-pressed") === "true",
        );
        const target = tabs.findIndex((tab) =>
          tab.getAttribute("aria-label")?.endsWith(`: ${destination}`),
        );
        return source < 0 ? 0 : Math.sign(target - source);
      }, name);
    await page.evaluate(() => {
      (window as any).layoutMotionFrames = undefined;
      document.addEventListener(
        "click",
        () => {
          const frames: object[] = [];
          const start = performance.now();
          /** Samples actual rendered styles after click activation on successive frames. */
          const sample = () => {
            const element = document.querySelector(
              '[data-workspace-active="true"]',
            );
            if (element) {
              const style = getComputedStyle(element);
              frames.push({
                time: performance.now() - start,
                opacity: Number(style.opacity),
                visibleWorkspaces: [
                  ...document.querySelectorAll("[data-layout-workspace]"),
                ].filter(
                  (workspace) =>
                    getComputedStyle(workspace).visibility === "visible" &&
                    getComputedStyle(workspace).display !== "none",
                ).length,
                x: new DOMMatrixReadOnly(style.transform).m41,
                y: new DOMMatrixReadOnly(style.transform).m42,
                width: element.getBoundingClientRect().width,
              });
            } else {
              const visible = [
                ...document.querySelectorAll("[data-layout-workspace]"),
              ].filter(
                (workspace) =>
                  getComputedStyle(workspace).visibility === "visible" &&
                  getComputedStyle(workspace).display !== "none",
              );
              frames.push({
                opacity: 1,
                x: 0,
                y: 0,
                width: visible[0]?.getBoundingClientRect().width ?? 0,
                visibleWorkspaces: visible.length,
              });
            }
            if (performance.now() - start < 400) requestAnimationFrame(sample);
            else (window as any).layoutMotionFrames = frames;
          };
          requestAnimationFrame(sample);
        },
        { once: true },
      );
    });
    await page
      .getByRole("button", { name: new RegExp(`^Layout [12]: ${name}$`) })
      .click();
    await page.waitForFunction(() => (window as any).layoutMotionFrames);
    const frames = await page.evaluate(
      () => (window as any).layoutMotionFrames,
    );
    await testInfo.attach(`motion-${name}`, {
      body: JSON.stringify(frames),
      contentType: "application/json",
    });
    expect(
      frames.every((frame: any) => frame.opacity === 1),
      JSON.stringify(frames),
    ).toBe(true);
    expect(frames.every((frame: any) => frame.visibleWorkspaces >= 1)).toBe(
      true,
    );
    expect(frames.at(-1).opacity).toBe(1);
    expect(frames[0].width).toBeGreaterThan(500);
    expect(frames.every((frame: any) => frame.y === 0)).toBe(true);
    if (direction === 0)
      expect(frames.every((frame: any) => frame.x === 0)).toBe(true);
    else
      expect(
        frames.some(
          (frame: any) =>
            Math.abs(frame.x) > 1 && Math.sign(frame.x) === direction,
        ),
        JSON.stringify({
          name,
          index,
          direction,
          x: frames.map((frame: any) => frame.x),
        }),
      ).toBe(true);
  }
  await page.evaluate(async () => {
    const button = document.querySelector<HTMLButtonElement>(
      '[aria-label$=": Programming"]',
    )!;
    button.click();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const element = document.querySelector('[data-workspace-active="true"]')!;
    for (const animation of element.getAnimations()) {
      animation.pause();
      animation.currentTime = 80;
    }
  });
  await page.screenshot({
    path: testInfo.outputPath("layout-transition-midpoint.png"),
  });
  await page
    .locator('[data-workspace-active="true"]')
    .evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => {
          animation.play();
          return animation.finished;
        }),
      );
    });
  await page.screenshot({
    path: testInfo.outputPath("layout-transition-complete.png"),
  });
});

/** A retained panel dialog cannot cover another layout, lock scrolling, or consume its Escape key. */
test("suspends workspace dialogs while another layout is selected", async ({
  page,
  backendSlot,
}, testInfo) => {
  await setupSlots(page, backendSlot.backendPort);
  await page
    .getByRole("button", { name: "Layout 1: Programming", exact: true })
    .click();
  await page.getByRole("tab", { name: "FX List", exact: true }).click();
  await page.getByRole("button", { name: "Add effect", exact: true }).click();
  await page.getByRole("button", { name: "Module FX", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Add Module FX",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("heading", { name: "Add Module FX", exact: true })
    .click();
  await page.keyboard.press("F2");
  await expect(
    page.getByRole("button", { name: "Layout 2: Playback", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe(
    "hidden",
  );
  await page.keyboard.press("Escape");
  await page.keyboard.press("F1");
  await expect(dialog).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("restored-workspace-dialog.png"),
  });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});

/** Shared Properties registration follows workspace ownership, reactive labels, and instance cleanup. */
test("isolates Properties registrations for retained duplicate panel IDs", async ({
  page,
  backendSlot,
}) => {
  await openFreshWorkspace(page, backendSlot.backendPort);
  const result = await page.evaluate(async () => {
    const solidUrl = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((url) => new URL(url).pathname.endsWith("/solid-js.js"));
    if (!solidUrl) throw new Error("Expected the application's Solid runtime");
    const {
      createRoot,
      createComponent,
      createSignal,
    }: typeof import("solid-js") = await import(solidUrl);
    const { WorkspaceActivityContext } = await import(
      "/lib/workspace-activity.ts"
    );
    const { PropertiesContext, usePropertiesInspector } = await import(
      "/features/property-inspector/context/context-core.ts"
    );
    const providers = new Map<string, any>();
    const [active, setActive] = createSignal("first");
    const [label, setLabel] = createSignal("Second");
    const disposers: (() => void)[] = [];
    /** Provides the same ID-keyed registration semantics as the inspector without rendering editor controls. */
    const context = {
      activeProvider: () => providers.get("duplicate"),
      registerProvider: (provider: any) => {
        providers.set(provider.id, provider);
        return () => providers.delete(provider.id);
      },
      unregisterProvider: (id: string) => providers.delete(id),
      activateProvider: () => {},
      deactivateProvider: () => {},
    };
    for (const name of ["first", "second"]) {
      createRoot((dispose) => {
        disposers.push(dispose);
        createComponent(WorkspaceActivityContext.Provider, {
          value: () => active() === name,
          get children() {
            return createComponent(PropertiesContext.Provider, {
              value: context,
              get children() {
                usePropertiesInspector(
                  "duplicate",
                  name === "first" ? "First" : label,
                  () => name,
                );
                return null;
              },
            });
          },
        });
      });
    }
    const observed: Array<[string, string] | null> = [];
    /** Reads the active provider's owner and reactive label after each lifecycle operation. */
    const record = () => {
      const provider = providers.get("duplicate");
      observed.push(provider ? [provider.component(), provider.label] : null);
    };
    record();
    setActive("");
    setActive("second");
    record();
    setLabel("Renamed");
    record();
    setActive("");
    setActive("first");
    record();
    disposers[1]();
    record();
    disposers[0]();
    record();
    return observed;
  });
  expect(result).toEqual([
    ["first", "First"],
    ["second", "Second"],
    ["second", "Renamed"],
    ["first", "First"],
    ["first", "First"],
    null,
  ]);
});

/** Management edits visibility without activating layouts and protects the active layout in both menus. */
test("unifies management, visibility, saving and deletion", async ({
  page,
  backendSlot,
}, testInfo) => {
  await setupSlots(page, backendSlot.backendPort);
  const programming = page.getByRole("button", {
    name: "Layout 1: Programming",
    exact: true,
  });
  const playback = page.getByRole("button", {
    name: "Layout 2: Playback",
    exact: true,
  });
  await programming.hover();
  await page
    .getByRole("button", { name: "Options for layout 1", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Hide from switcher", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Delete", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    (window as any).appStores.dockApi
      .get()
      .getPanel("panel-Visualizer")
      .api.setTitle("Unsaved Programming"),
  );
  await playback.click();
  await slotAction(page, 1, "Save");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem("nightfall-ui-layouts")!);
        return state.layouts
          .find((layout: any) => layout.name === "Programming")
          .panels.find((panel: any) => panel.id === "panel-Visualizer").title;
      }),
    )
    .toBe("Unsaved Programming");
  await expect(playback).toHaveAttribute("aria-pressed", "true");
  await slotAction(page, 1, "Hide from switcher");
  await expect(programming).toHaveCount(0);
  await page
    .getByRole("button", { name: "Manage layouts", exact: true })
    .click();
  const manager = page.getByRole("dialog", { name: "Manage layouts" });
  await expect(manager.getByRole("button", { name: /^Load / })).toHaveCount(0);
  await expect(
    manager.getByRole("checkbox", {
      name: "Show Playback in switcher",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    manager.getByRole("button", { name: "Delete Playback", exact: true }),
  ).toBeDisabled();
  await expect(
    manager.getByRole("checkbox", {
      name: "Show Programming in switcher",
      exact: true,
    }),
  ).not.toBeChecked();
  await page.screenshot({
    path: testInfo.outputPath("unified-layout-manager.png"),
  });
  await manager
    .getByRole("checkbox", {
      name: "Show Programming in switcher",
      exact: true,
    })
    .check();
  await expect(
    manager.getByRole("checkbox", {
      name: "Show Programming in switcher",
      exact: true,
    }),
  ).toBeChecked();
  await manager.getByRole("button", { name: "Close layouts" }).click();
  await programming.click();
  await expect(
    page.getByRole("tab", { name: "Unsaved Programming", exact: true }),
  ).toBeVisible();
  await slotAction(page, 2, "Delete");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(playback).toHaveCount(0);
  await expect(programming).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await waitForDockviewApp(page);
  await expect(programming).toHaveAttribute("aria-pressed", "true");
  await expect(playback).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("unified-layout-switcher.png"),
  });
});

/** Fresh workspaces always have an active layout, and blank creation leaves that layout selected. */
test("creates visible blank layouts through management without replacing the active layout", async ({
  page,
  backendSlot,
}, testInfo) => {
  await openFreshWorkspace(page, backendSlot.backendPort);
  const initial = page.getByRole("button", {
    name: "Layout 1: Your Layout",
    exact: true,
  });
  await expect(initial).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("button", { name: "Manage layouts", exact: true })
    .click();
  const manager = page.getByRole("dialog", { name: "Manage layouts" });
  await manager.getByPlaceholder("Layout name").fill("Blank");
  await manager
    .getByRole("button", { name: "New blank layout", exact: true })
    .click();
  await expect(manager.getByText("Blank", { exact: true })).toBeVisible();
  await expect(initial).toHaveAttribute("aria-pressed", "true");
  await manager
    .getByRole("button", { name: "Rename Blank", exact: true })
    .click();
  await manager.locator("form").last().getByRole("textbox").fill("Empty desk");
  await manager
    .getByRole("button", { name: "Save layout name", exact: true })
    .click();
  await manager.getByRole("button", { name: "Close layouts" }).click();
  const blank = page.getByRole("button", {
    name: "Layout 2: Empty desk",
    exact: true,
  });
  await blank.click();
  await expect(blank).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.dockApi.get().panels.length,
      ),
    )
    .toBe(0);
  await slotAction(page, 1, "Hide from switcher");
  await expect(
    page.getByRole("button", { name: "Layout 1: Empty desk", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Manage layouts", exact: true })
    .click();
  await page.screenshot({
    path: testInfo.outputPath("unified-layout-manager-mobile.png"),
  });
});

/** Saving must retain switcher DOM nodes and the header height at both responsive breakpoints. */
test("keeps switcher nodes and header height stable while saving", async ({
  page,
  backendSlot,
}, testInfo) => {
  await setupSlots(page, backendSlot.backendPort);
  for (const width of [1366, 700]) {
    await page.setViewportSize({ width, height: 900 });
    await settleSlotMotion(page);
    await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>(".nf-app-header")!;
      const nodes = [...header.querySelectorAll(".nf-layout-slot")];
      const heights: number[] = [header.getBoundingClientRect().height];
      let removed = false;
      const observer = new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.removedNodes) {
            if (nodes.some((entry) => node === entry || node.contains(entry)))
              removed = true;
          }
      });
      const resize = new ResizeObserver(() =>
        heights.push(header.getBoundingClientRect().height),
      );
      observer.observe(header, { childList: true, subtree: true });
      resize.observe(header);
      (window as any).headerSaveProbe = () => {
        observer.disconnect();
        resize.disconnect();
        return {
          removed,
          sameNodes: nodes.every((node) => node.isConnected),
          heights,
        };
      };
    });
    await slotAction(page, 1, "Save");
    await expect(
      page.getByRole("button", { name: "Options for layout 1", exact: true }),
    ).toBeEnabled();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const result = await page.evaluate(() => (window as any).headerSaveProbe());
    expect(result.removed).toBe(false);
    expect(result.sameNodes).toBe(true);
    expect(new Set(result.heights).size).toBe(1);
    await page.screenshot({
      path: testInfo.outputPath(`stable-save-header-${width}.png`),
    });
  }
});

/** Queued manager edits retain existing rows and leave unrelated controls usable throughout a delayed save. */
test("manager saves preserve rows and keep unrelated actions enabled", async ({
  page,
  backendSlot,
}, testInfo) => {
  await setupSlots(page, backendSlot.backendPort);
  await page
    .getByRole("button", { name: "Manage layouts", exact: true })
    .click();
  const manager = page.getByRole("dialog", { name: "Manage layouts" });
  await page.evaluate(async () => {
    const { engineRuntime } = await import("/lib/engine-runtime.ts");
    const original = engineRuntime.sendCommandAndAwait.bind(engineRuntime);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    engineRuntime.sendCommandAndAwait = async (
      ...args: Parameters<typeof original>
    ) => {
      if (
        (args[0] as { command?: { type: string } }).command?.type ===
        "SetPanelLayouts"
      )
        await gate;
      return original(...args);
    };
    const rows = [...document.querySelectorAll("[data-layout-id]")];
    (window as any).releaseLayoutSave = release;
    (window as any).finishManagerProbe = () => {
      engineRuntime.sendCommandAndAwait = original;
      return rows.every((row) => row.isConnected);
    };
  });
  await manager
    .getByRole("button", { name: "Save Programming", exact: true })
    .click();
  await expect(
    manager.getByRole("button", { name: "Save Programming", exact: true }),
  ).toBeDisabled();
  await expect(
    manager.getByRole("button", { name: "Save Playback", exact: true }),
  ).toBeEnabled();
  await expect(
    manager.getByRole("button", { name: "Rename Playback", exact: true }),
  ).toBeEnabled();
  await expect(
    manager.getByRole("button", { name: "Save current as new", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Manage layouts", exact: true }),
  ).toBeEnabled();
  await manager
    .getByRole("checkbox", { name: "Show Playback in switcher", exact: true })
    .uncheck();
  await page.screenshot({
    path: testInfo.outputPath("manager-saving-one-layout.png"),
  });
  await page.evaluate(() => (window as any).releaseLayoutSave());
  await expect(
    manager.getByRole("button", { name: "Save Programming", exact: true }),
  ).toBeEnabled();
  await expect(
    manager.getByRole("checkbox", {
      name: "Show Playback in switcher",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    manager.getByRole("checkbox", {
      name: "Show Playback in switcher",
      exact: true,
    }),
  ).not.toBeChecked();
  expect(await page.evaluate(() => (window as any).finishManagerProbe())).toBe(
    true,
  );
});
