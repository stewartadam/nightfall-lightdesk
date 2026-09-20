// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Persists structural changes and resizing without rewriting storage when focus changes. */
test("Dockview persists layout mutations without focus-only writes", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  // Leave room for all three groups above their content-driven minimum widths.
  await page.setViewportSize({ width: 2400, height: 1000 });
  await page.addInitScript(() => {
    if (sessionStorage.getItem("dockview-test-seeded")) return;
    localStorage.clear();
    localStorage.setItem("nightfall.currentShowfileName", "default");
    sessionStorage.setItem("dockview-test-seeded", "1");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await expect(page.locator(".dv-content-container:visible").first()).toHaveCSS(
    "color-scheme",
    "dark",
  );
  await page.screenshot({
    path: testInfo.outputPath("dockview-dark-theme.png"),
  });
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.clear();
    api.addPanel({
      id: "layout-test-a",
      component: "SequenceList",
      title: "Layout A",
    });
    api.addPanel({
      id: "layout-test-b",
      component: "SequenceList",
      title: "Layout B",
      position: { referencePanel: "layout-test-a", direction: "right" },
    });
    api.addPanel({
      id: "layout-test-c",
      component: "SequenceList",
      title: "Layout C",
      position: { referencePanel: "layout-test-b", direction: "within" },
    });
  });
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("nightfall-ui-layouts")),
    )
    .toContain("layout-test-b");
  const writes = await page.evaluate(async () => {
    const api = (window as any).appStores.dockApi.get();
    // Wait for rendering and resize observers from panel creation to settle.
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    const original = Storage.prototype.setItem;
    let count = 0;
    /** Counts only session-layout writes during focus changes. */
    Storage.prototype.setItem = function (key, value) {
      if (key === "nightfall-ui-layouts") count++;
      original.call(this, key, value);
    };
    try {
      api.getPanel("layout-test-a").api.setActive();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      api.getPanel("layout-test-b").api.setActive();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      api.getPanel("layout-test-c").api.setActive();
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      return count;
    } finally {
      Storage.prototype.setItem = original;
    }
  });
  expect(writes).toBe(0);
  await page.evaluate(() => {
    const panel = (window as any).appStores.dockApi
      .get()
      .getPanel("layout-test-a");
    panel.api.setTitle("Renamed layout panel");
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem("nightfall-ui-layouts")!);
        return state.sessionLayout.layout.panels["layout-test-a"].title;
      }),
    )
    .toBe("Renamed layout panel");
  await page.evaluate(() => {
    const panel = (window as any).appStores.dockApi
      .get()
      .getPanel("layout-test-a");
    panel.api.updateParameters({ persistenceMarker: "updated" });
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem("nightfall-ui-layouts")!);
        return state.sessionLayout.layout.panels["layout-test-a"];
      }),
    )
    .toMatchObject({
      title: "Renamed layout panel",
      params: { persistenceMarker: "updated" },
    });
  await page.evaluate(() => {
    const panel = (window as any).appStores.dockApi
      .get()
      .getPanel("layout-test-a");
    panel.api.maximize();
    panel.api.updateParameters({ persistenceMarker: "maximized" });
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem("nightfall-ui-layouts")!);
        return state.sessionLayout.layout.panels["layout-test-a"].params
          .persistenceMarker;
      }),
    )
    .toBe("maximized");
  // A rendering frame and real input must remain available after serialization.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(resolve)),
  );
  await page.locator("#header-cmdline").fill("clear");
  await expect(page.locator("#header-cmdline")).toHaveValue("clear");
  await page.screenshot({ path: testInfo.outputPath("maximized-layout.png") });
  await page.locator("#header-cmdline").clear();
  await page.evaluate(() => {
    (window as any).appStores.dockApi
      .get()
      .getPanel("layout-test-a")
      .api.exitMaximized();
  });
  const beforeResize = await page.evaluate(() =>
    localStorage.getItem("nightfall-ui-layouts"),
  );
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("layout-test-a").group.api.setSize({ width: 700 });
  });
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("nightfall-ui-layouts")),
    )
    .not.toBe(beforeResize);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.removePanel(api.getPanel("layout-test-b"));
  });
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("nightfall-ui-layouts")),
    )
    .not.toContain("layout-test-b");
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.addFloatingGroup(api.getPanel("layout-test-c"), {
      x: 100,
      y: 100,
      width: 400,
      height: 300,
      dragHandle: "titlebar",
    });
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem("nightfall-ui-layouts")!);
        return state.sessionLayout.layout.floatingGroups?.[0]?.position;
      }),
    )
    .toMatchObject({ left: 100, top: 100 });
  const header = page.locator(".dv-floating-titlebar");
  const bounds = await header.boundingBox();
  if (!bounds) throw new Error("Floating group header is unavailable");
  await page.mouse.move(bounds.x + 120, bounds.y + 15);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 200, bounds.y + 75, { steps: 10 });
  await page.mouse.up();
  const movedPosition = await page.evaluate(
    () =>
      (window as any).appStores.dockApi.get().toJSON().floatingGroups[0]
        .position,
  );
  expect(movedPosition.left).toBeGreaterThan(100);
  expect(movedPosition.top).toBeGreaterThan(100);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem("nightfall-ui-layouts")!);
        return state.sessionLayout.layout.floatingGroups?.[0]?.position;
      }),
    )
    .toMatchObject(movedPosition);
  await page.screenshot({
    path: testInfo.outputPath("dockview-floating-layout.png"),
  });
  await page.reload();
  await waitForDockviewApp(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).appStores.dockApi.get().toJSON().floatingGroups?.[0]
            ?.position,
      ),
    )
    .toMatchObject(movedPosition);
});
