// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { utimes } from "node:fs/promises";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.use({ sampleDataOnly: true });

const pageErrors = new WeakMap<Page, string[]>();

/** Records asynchronous errors that can otherwise be missed during automatic step changes. */
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
});

/** Fails on stale tooltip callbacks and other unexpected browser errors. */
test.afterEach(({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

/** Opens the sample_data.rs-generated show and waits for its practice rig. */
async function openSample(page: Page, offscreenCanvas = true) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    localStorage.removeItem("nightfall.e2eAutoOpenStartupShowfile");
  });
  await page.goto(
    `/?startup:draftRecovery=false&e2e=1&visualizer:offscreenCanvas=${offscreenCanvas}`,
  );
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      Object.keys((window as any).appStores?.fixtures?.get() ?? {}).length ===
      56,
  );
  const targets = await page.evaluate(() => {
    const stores = (window as any).appStores;
    return {
      fixtures: Object.values(stores.fixtures.get()).map(
        (entry: any) => entry.identifiers.id,
      ),
      clips: Object.values(stores.clips.get()).map(([clip]: any) => [
        clip.identifiers.id,
        clip.identifiers.label,
      ]),
      timelines: Object.values(stores.timelines.get()).map((entry: any) => [
        entry.identifiers.id,
        entry.identifiers.label,
      ]),
    };
  });
  expect(targets.fixtures).toEqual(
    expect.arrayContaining([310, 311, 312, 313]),
  );
  expect(targets.fixtures).not.toContain(1);
  expect(targets.clips).toEqual(
    expect.arrayContaining([
      [1, "RGB cycle (full)"],
      [6, "fx3"],
    ]),
  );
  expect(targets.timelines).toContainEqual([1, "Lo-fi"]);
}

/** Moves through guide instructions without pretending skipped actions succeeded. */
async function reachStep(page: Page, title: string) {
  const guide = page.getByTestId("welcome-guide");
  for (let index = 0; index < 20; index += 1) {
    if (
      await guide.getByRole("heading", { name: title, exact: true }).isVisible()
    )
      return;
    await guide.getByRole("button", { name: "Continue", exact: true }).click();
  }
  throw new Error(`Did not reach guide step: ${title}`);
}

/** Verifies the floating lesson remains above app dialogs and within the viewport. */
async function expectGuideOutsideBackdrop(page: Page) {
  const app = await page.locator(".nf-app-viewport").boundingBox();
  const guide = await page.getByTestId("welcome-guide").boundingBox();
  const backdrop = await page
    .locator('[data-dialog-kind="command-palette"]')
    .boundingBox();
  expect(guide).not.toBeNull();
  expect(backdrop).not.toBeNull();
  expect(app).not.toBeNull();
  expect(backdrop!.width).toBeCloseTo(app!.width, 0);
  expect(backdrop!.height).toBeCloseTo(app!.height, 0);
  const handle = page.getByRole("button", { name: "Move guide", exact: true });
  await handle.click({ trial: true });
  await expect
    .poll(async () => {
      const card = (await page.getByTestId("welcome-guide").boundingBox())!;
      const input = (await page
        .getByPlaceholder("Type a command or search...")
        .boundingBox())!;
      return (
        card.x >= input.x + input.width ||
        card.x + card.width <= input.x ||
        card.y >= input.y + input.height ||
        card.y + card.height <= input.y
      );
    })
    .toBe(true);
  const viewport = page.viewportSize()!;
  expect(guide!.x).toBeGreaterThanOrEqual(0);
  expect(guide!.y).toBeGreaterThanOrEqual(0);
  expect(guide!.x + guide!.width).toBeLessThanOrEqual(viewport.width);
  expect(guide!.y + guide!.height).toBeLessThanOrEqual(viewport.height);
}

/** Keeps constrained divider grips visible when the guide reduces the workspace width. */
test("guide preserves divider grips at panel minimum widths", async ({
  page,
}, testInfo) => {
  await openSample(page);
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const divider = page
    .locator(
      ".dv-dockview .dv-horizontal > .dv-sash-container > .dv-sash.dv-disabled",
    )
    .first();
  await expect(divider).toBeVisible();
  await expect
    .poll(() =>
      divider.evaluate(
        (element) => getComputedStyle(element, "::after").content,
      ),
    )
    .toBe('""');
  await expect
    .poll(() =>
      divider.evaluate(
        (element) => getComputedStyle(element, "::after").opacity,
      ),
    )
    .toBe("0.45");
  await page.screenshot({
    path: testInfo.outputPath("guide-constrained-divider.png"),
  });
  await page.getByRole("button", { name: "Exit welcome guide" }).click();
  await expect(divider).toHaveCount(0);
});

/** Keeps the complete shell and right-hand Dockview content inside the app's own viewport. */
test("guide resizes the whole app and leaves right-hand panels clickable", async ({
  page,
}, testInfo) => {
  await openSample(page);
  const app = page.locator(".nf-app-viewport");
  const original = await app.boundingBox();
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await expect
    .poll(async () => (await app.boundingBox())!.width)
    .toBeLessThan(original!.width);
  const viewport = (await app.boundingBox())!;
  const lesson = (await guide.boundingBox())!;
  expect(viewport.x + viewport.width).toBeCloseTo(lesson.x, 0);
  expect(lesson.y).toBe(0);
  expect(lesson.height).toBe(1000);
  const header = (await page
    .getByRole("navigation", { name: "Global", exact: true })
    .boundingBox())!;
  expect(header.x + header.width).toBeLessThanOrEqual(lesson.x);
  const visualizer = page.getByLabel("3D visualizer viewport", { exact: true });
  await expect(visualizer).toBeVisible();
  const canvas = (await visualizer.boundingBox())!;
  expect(canvas.x + canvas.width).toBeLessThanOrEqual(lesson.x + 1);
  await visualizer.click({
    position: { x: canvas.width - 20, y: canvas.height / 2 },
    trial: true,
  });
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.addPanel({
      id: "guide-right-fixtures",
      component: "FixtureGrid",
      title: "Guide right fixtures",
      position: { referencePanel: "panel-Visualizer", direction: "within" },
    });
  });
  const panel = page.locator(
    '[data-panel-id="guide-right-fixtures"][data-component="FixtureGrid"]',
  );
  await expect(panel).toBeVisible();
  await expect
    .poll(async () => {
      const bounds = (await panel.boundingBox())!;
      return bounds.x + bounds.width;
    })
    .toBeLessThanOrEqual(lesson.x + 1);
  await panel.getByRole("button").first().click({ trial: true });
  await page.screenshot({
    path: testInfo.outputPath("guide-full-app-desktop.png"),
  });
  await page.setViewportSize({ width: 700, height: 900 });
  await expect
    .poll(async () => (await app.boundingBox())!.height)
    .toBeLessThan(900);
  const narrowApp = (await app.boundingBox())!;
  const narrowGuide = (await guide.boundingBox())!;
  expect(narrowApp.y + narrowApp.height).toBeCloseTo(narrowGuide.y, 0);
  expect(narrowGuide.y + narrowGuide.height).toBeCloseTo(900, 0);
  await page.screenshot({
    path: testInfo.outputPath("guide-full-app-narrow.png"),
  });
  await guide.getByRole("button", { name: "Exit welcome guide" }).click();
  await expect.poll(async () => (await app.boundingBox())!.height).toBe(900);
  await expect.poll(async () => (await app.boundingBox())!.width).toBe(700);
});

/** Clipped grid focus wrappers must not steal clicks from the right edge tabs. */
test("guide leaves Status Display and Fixtures edge tabs reachable", async ({
  page,
}, testInfo) => {
  await openSample(page);
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  for (const width of [1440, 1100, 1000]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const name of ["Status Display", "Fixtures"]) {
      const tab = page.getByRole("tab", { name, exact: true });
      await expect(tab).toBeVisible();
      await expect
        .poll(() =>
          tab.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            );
            return hit !== null && element.contains(hit);
          }),
        )
        .toBe(true);
      await tab.click();
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as any).appStores.dockApi.get().activePanel?.title,
          ),
        )
        .toBe(name);
      if (name === "Fixtures") {
        const fixtures = page.locator('[data-panel-kind="fixtures"]');
        await fixtures.getByRole("button").first().click({ trial: true });
        await expect(
          fixtures.getByText("RGBPixelTape 120ch RGB", { exact: true }).first(),
        ).toBeVisible();
      }
    }
  }
  await page.screenshot({ path: testInfo.outputPath("guide-edge-tabs.png") });
  await page.getByRole("button", { name: "Exit welcome guide" }).click();
  await page.getByRole("tab", { name: "Status Display", exact: true }).click();
});

/** Combines context and copyable commands in a movable card without reducing the app viewport. */
test("floating lessons provide context, selectable commands and manual placement", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openSample(page);
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await guide.getByRole("button", { name: /Your first lights/ }).click();
  await reachStep(page, "Select lights by number");
  await expect(
    page.getByRole("textbox", { name: "Command input", exact: true }),
  ).toBeFocused();
  const hint = guide;
  await expect(hint).toBeVisible();
  await expect(page.locator(".nf-app-viewport")).toHaveCSS("width", "1440px");
  await expect(hint).toContainText("inclusive range");
  const before = (await hint.boundingBox())!;
  const commandBounds = (await page.locator("#header-cmdline").boundingBox())!;
  expect(
    before.y >= commandBounds.y + commandBounds.height ||
      before.x >= commandBounds.x + commandBounds.width,
  ).toBe(true);
  const handle = guide.getByRole("button", { name: "Move guide", exact: true });
  const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    grip.x + grip.width / 2 + 100,
    grip.y + grip.height / 2 + 60,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => (await hint.boundingBox())!.x)
    .toBeCloseTo(before.x + 100, 0);
  await handle.focus();
  await handle.press("ArrowDown");
  await expect
    .poll(async () => (await hint.boundingBox())!.y)
    .toBeCloseTo(before.y + 80, 0);
  await expect(hint).toHaveCSS("pointer-events", "auto");
  await expect(hint).toHaveCSS("user-select", "text");
  await hint.locator("code").click({ clickCount: 3 });
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString().trim()))
    .toBe("fix 310>313");
  await page.screenshot({
    path: testInfo.outputPath("guide-emphasized-hint.png"),
  });
  const command = page.getByRole("textbox", {
    name: "Command input",
    exact: true,
  });
  await command.fill("fix 310>313");
  await command.press("Enter");
  await expect(hint.locator("code")).toHaveText("@ 100");
  const introduction = guide.getByText(
    "The Programmer holds live lighting instructions.",
    { exact: true },
  );
  const prerequisite = guide.getByRole("button", {
    name: "Open Programmer",
    exact: true,
  });
  const explanation = guide.getByText(
    "The @ command sets the selected strips’ intensity.",
    { exact: false },
  );
  const action = guide.locator(".nf-guide-action");
  expect((await prerequisite.boundingBox())!.y).toBeGreaterThan(
    (await introduction.boundingBox())!.y,
  );
  expect((await explanation.boundingBox())!.y).toBeGreaterThan(
    (await prerequisite.boundingBox())!.y,
  );
  expect((await action.boundingBox())!.y).toBeGreaterThan(
    (await explanation.boundingBox())!.y,
  );
  await expect(action).not.toContainText("full brightness");
  await expect(guide).toHaveCSS(
    "border-top-color",
    await page
      .locator(".dv-groupview.dv-active-group")
      .first()
      .evaluate((element) => getComputedStyle(element).borderTopColor),
  );
  await page.screenshot({
    path: testInfo.outputPath("guide-action-hierarchy.png"),
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(hint).toHaveCSS("animation-name", "none");
  await expect(hint).toBeVisible();
  await command.fill("@ 100");
  await command.press("Enter");
  await expect(hint.locator("code")).toHaveText("red @ 100 green @ 0 blue @ 0");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await guide
    .getByRole("button", { name: "Copy command", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("red @ 100 green @ 0 blue @ 0");
  await expect(hint).toHaveCSS("animation-name", "none");
  await expect(guide.getByRole("button", { name: "All lessons" })).toHaveCount(
    0,
  );
  await expect(guide.locator(".nf-guide-pointer")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("guide-reduced-motion.png"),
  });
});

/** Advances after storing cue 1.1 with an arbitrary label. */
test("guide accepts stored cue identity without its suggested label", async ({
  page,
}) => {
  await openSample(page);
  const command = page.getByRole("textbox", {
    name: "Command input",
    exact: true,
  });
  await command.fill("fix 310>313 @ 100 red @ 100 green @ 0 blue @ 0");
  await command.press("Enter");
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await guide.getByRole("button", { name: /Your first lights/ }).click();
  await reachStep(page, "Store the red cue");
  await guide
    .getByRole("button", { name: "Open Programmer", exact: true })
    .click();
  await page.getByRole("button", { name: "Store cue", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Store Cue" });
  await dialog.getByLabel("Sequence ID", { exact: true }).fill("50");
  await dialog.getByLabel("Cue ID", { exact: true }).fill("1");
  await dialog.getByLabel("Label", { exact: true }).fill("My red look");
  await dialog.getByRole("button", { name: "Store Cue", exact: true }).click();
  await expect(guide.locator("code")).toHaveText(
    "red @ 0 green @ 0 blue @ 100",
  );
});

/** Gates later text and actions until every prerequisite is usable, preserving authored order. */
test("guide content waits for prerequisites and renders text after actions", async ({
  page,
}, testInfo) => {
  await openSample(page);
  await page.evaluate(async () => {
    const path = "/features/welcome-guide/lessons.ts";
    const { GUIDE_LESSONS } = await import(path);
    const intensity = GUIDE_LESSONS.find(
      (lesson: any) => lesson.id === "welcome",
    ).steps.find((step: any) => step.id === "intensity");
    intensity.content.push({
      type: "text",
      text: "Text after the action callout.",
    });
    const api = (window as any).appStores.dockApi.get();
    api.removePanel(api.getPanel("panel-Visualizer"));
  });
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await guide.getByRole("button", { name: /Your first lights/ }).click();
  await reachStep(page, "Bring up the lights");
  await expect(guide).toContainText(
    "The Programmer holds live lighting instructions.",
  );
  await expect(guide.locator(".nf-guide-action")).toHaveCount(0);
  await expect(guide).not.toContainText("The @ command");
  await expect(guide).not.toContainText("Text after the action callout.");
  await expect(page.getByTestId("guide-target")).toHaveCount(0);
  await guide
    .getByRole("button", { name: "Open Programmer", exact: true })
    .click();
  await expect(guide.locator(".nf-guide-action")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("guide-prerequisite-pending.png"),
  });
  await guide
    .getByRole("button", { name: "Open 3D Visualizer", exact: true })
    .click();
  await expect(guide.locator("code")).toHaveText("@ 100");
  const after = guide.getByText("Text after the action callout.", {
    exact: true,
  });
  await expect(after).toBeVisible();
  const action = (await guide.locator(".nf-guide-action").boundingBox())!;
  expect((await after.boundingBox())!.y).toBeGreaterThanOrEqual(
    action.y + action.height,
  );
  await guide
    .getByRole("button", { name: "Copy command", exact: true })
    .click();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("@ 100");
  await page.screenshot({
    path: testInfo.outputPath("guide-prerequisite-ready.png"),
  });
});

/** Shows prerequisite shortcuts again when their panels become hidden, collapsed, or closed. */
test("guide shortcuts follow panel visibility", async ({ page }, testInfo) => {
  await openSample(page);
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await guide.getByRole("button", { name: /Your first lights/ }).click();
  await reachStep(page, "Bring up the lights");
  const shortcut = guide.getByRole("button", {
    name: "Open Programmer",
    exact: true,
  });
  await expect(shortcut).toBeVisible();
  await shortcut.click();
  await expect(shortcut).toHaveCount(0);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const panel = api.panels.find(
      (entry: any) => entry.api.component === "ProgrammerGrid",
    );
    api.getEdgeGroup(panel.api.location.position).collapse();
  });
  await expect(shortcut).toBeVisible();
  await shortcut.click();
  await expect(shortcut).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Store cue", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("guide-visible-programmer.png"),
  });
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const panel = api.panels.find(
      (entry: any) => entry.api.component === "ProgrammerGrid",
    );
    const sibling = panel.group.panels.find(
      (entry: any) => entry.id !== panel.id,
    );
    sibling.api.setActive();
  });
  await expect(shortcut).toBeVisible();
  await shortcut.click();
  await expect(shortcut).toHaveCount(0);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.removePanel(
      api.panels.find((entry: any) => entry.api.component === "ProgrammerGrid"),
    );
  });
  await expect(shortcut).toBeVisible();
});

/** Keeps sample fixture identities and swatches readable in the Programmer's compact dock. */
test("programmer columns fit selected sample fixtures", async ({
  page,
}, testInfo) => {
  await openSample(page);
  await page
    .getByRole("button", { name: "Open command palette", exact: true })
    .click();
  const search = page.locator('[data-dialog-kind="command-palette"] input');
  await search.fill("Open Programmer");
  await search.press("Enter");
  const command = page.getByRole("textbox", {
    name: "Command input",
    exact: true,
  });
  await command.fill("fix 310>313");
  await command.press("Enter");
  const panel = page.locator('[data-panel-kind="programmer"]:visible');
  await expect(panel).toBeVisible();
  for (const [id, width] of [
    ["id", 85],
    ["name", 240],
    ["color", 54],
  ] as const) {
    const header = panel.locator(
      `[data-grid-header-id="tanstack-header-${id}"]`,
    );
    await expect(header).toBeVisible();
    expect((await header.boundingBox())!.width).toBeGreaterThanOrEqual(width);
  }
  await page.screenshot({
    path: testInfo.outputPath("programmer-column-widths.png"),
  });
});

/** Places Stop guidance above the timeline, centered on its target without covering the panel. */
test("Stop guidance prefers above the timeline", async ({ page }, testInfo) => {
  await openSample(page);
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await guide.getByRole("button", { name: /Welcome to Nightfall/ }).click();
  await guide.getByRole("button", { name: "Continue", exact: true }).click();
  await guide
    .getByRole("button", { name: "Open Timeline 1: Lo-Fi", exact: true })
    .click();
  await reachStep(page, "Stop playback");
  await expect(
    page.getByRole("button", { name: "Stop timeline", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const timeline = api.getPanel(
      document
        .querySelector('[aria-label="Stop timeline"]')!
        .closest("[data-panel-id]")!
        .getAttribute("data-panel-id"),
    );
    timeline.api.moveTo({
      group: api.getPanel("panel-Visualizer").group,
      position: "bottom",
    });
  });
  const stop = page.getByRole("button", { name: "Stop timeline", exact: true });
  await expect(stop).toBeVisible();
  await expect
    .poll(async () => {
      const card = (await guide.boundingBox())!;
      const target = (await stop.boundingBox())!;
      return card.y + card.height <= target.y;
    })
    .toBe(true);
  const card = (await guide.boundingBox())!;
  const target = (await stop.boundingBox())!;
  expect(card.x + card.width / 2).toBeCloseTo(target.x + target.width / 2, 0);
  await page.screenshot({ path: testInfo.outputPath("guide-stop-above.png") });
});

/** Introduces direct clip playback and properties without using commands. */
test("welcome basics toggles a clip and opens properties", async ({
  page,
}, testInfo) => {
  await openSample(page);
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await guide.getByRole("button", { name: /Welcome to Nightfall/ }).click();
  await expect(page.locator(".nf-guide-highlight")).toBeVisible();
  const visualizer = page.locator(
    '[data-component="Visualizer"][data-panel-id]',
  );
  await expect
    .poll(async () => {
      const target = await visualizer.boundingBox();
      const highlight = await page.locator(".nf-guide-highlight").boundingBox();
      return target && highlight ? Math.abs(target.x - highlight.x) : Infinity;
    })
    .toBeLessThanOrEqual(5);
  await guide.getByRole("button", { name: "Continue", exact: true }).click();
  await guide
    .getByRole("button", { name: "Open Timeline 1: Lo-Fi", exact: true })
    .click();
  await expect(
    guide.getByRole("heading", { name: "Start the sample show" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Play timeline", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const id = document
      .querySelector('[aria-label="Play timeline"]')!
      .closest("[data-panel-id]")!
      .getAttribute("data-panel-id");
    api.removePanel(api.getPanel(id));
  });
  await guide
    .getByRole("button", { name: "Open Timeline 1: Lo-Fi", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Play timeline", exact: true })
    .click();
  await expect(
    guide.getByRole("heading", { name: "Stop playback", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Stop timeline", exact: true })
    .click();
  await expect(
    guide.getByRole("heading", { name: "Launch a clip" }),
  ).toBeVisible();
  await guide.getByRole("button", { name: "Open Clips", exact: true }).click();
  const uid = await page.evaluate(
    () =>
      (Object.values((window as any).appStores.clips.get()) as any[]).find(
        ([clip]) => clip.identifiers.id === 1,
      )[0].identifiers.uid,
  );
  const tile = page.locator(`[data-crud-select-id="${uid}"]`);
  await tile.click();
  await expect(
    guide.getByRole("heading", { name: "Stop a clip" }),
  ).toBeVisible();
  const pulse = page.locator(".nf-guide-highlight");
  expect(
    await pulse.evaluate(
      (element) => getComputedStyle(element, "::after").animationName,
    ),
  ).toBe("nf-guide-target-pulse");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await pulse.evaluate(
      (element) => getComputedStyle(element, "::after").animationName,
    ),
  ).toBe("none");
  await tile.click();
  await expect(
    guide.getByRole("heading", { name: "Explore clip properties" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Inspect clip 1", exact: true })
    .click();
  await expect(
    guide.getByRole("heading", { name: "Properties follows your focus" }),
  ).toBeVisible();
  const properties = page.locator(
    '[data-component="PropertiesInspector"][data-panel-id]',
  );
  await page.setViewportSize({ width: 2048, height: 1000 });
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const timeline = api.panels.find(
      (panel: any) => panel.api.component === "Timeline",
    );
    api
      .getPanel("panel-Visualizer")
      .api.moveTo({ group: timeline.group, position: "right" });
  });
  await page
    .getByRole("button", { name: "Inspect clip 1", exact: true })
    .click();
  await expect
    .poll(async () => {
      const card = (await guide.boundingBox())!;
      const panel = (await properties.boundingBox())!;
      return Math.abs(panel.x - card.x - card.width - 16);
    })
    .toBeLessThan(2);
  await expect(
    properties.getByText("Clip Properties", { exact: true }),
  ).toBeVisible();
  await page
    .locator(".dv-tab")
    .filter({ hasText: "Timeline 1: Lo-fi" })
    .click();
  await expect(
    properties.getByText("Timeline Properties", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("welcome-basics-properties.png"),
  });
  await guide.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    guide.getByRole("heading", {
      name: "A shortcut for lighting instructions",
    }),
  ).toBeVisible();
  await expect(page.locator("#header-cmdline")).toBeFocused();
  await guide.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    guide.getByRole("heading", { name: "Arrange your workspace" }),
  ).toBeVisible();
  await guide.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("button", { name: "Open command palette", exact: true })
    .click();
  await expect(
    guide.getByRole("heading", { name: "Open Settings", exact: true }),
  ).toBeVisible();
  const search = page.locator('[data-dialog-kind="command-palette"] input');
  await search.fill("Open Settings");
  await search.press("Enter");
  await expect(
    guide.getByRole("heading", { name: "Choose your accent color" }),
  ).toBeVisible();
  const appearanceTab = page.getByRole("tab", {
    name: "Appearance",
    exact: true,
  });
  await expect
    .poll(async () => {
      const tab = (await appearanceTab.boundingBox())!;
      const ring = await page.locator(".nf-guide-highlight").boundingBox();
      return ring
        ? Math.abs(ring.x - tab.x + 4) + Math.abs(ring.y - tab.y + 4)
        : Infinity;
    })
    .toBeLessThan(2);
  const highlightLayer = await page
    .getByTestId("guide-target")
    .evaluate((element) => Number(getComputedStyle(element).zIndex));
  const settingsLayer = await page
    .getByRole("dialog", { name: "Settings", exact: true })
    .evaluate((element) => Number(getComputedStyle(element).zIndex));
  expect(highlightLayer).toBeGreaterThan(settingsLayer);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect
    .poll(() =>
      page
        .locator(".nf-guide-highlight")
        .evaluate(
          (element) => getComputedStyle(element, "::after").animationName,
        ),
    )
    .toBe("nf-guide-target-pulse");
  await page.screenshot({
    path: testInfo.outputPath("welcome-appearance-tab.png"),
  });
  await appearanceTab.click();
  await page
    .getByRole("button", { name: "Violet accent", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Violet accent", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: testInfo.outputPath("welcome-accent.png") });
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await expect(
    guide.getByRole("heading", { name: "Edits apply as you work" }),
  ).toBeVisible();
  await guide.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: /Save Showfile/ }).click();
  await expect(
    guide.getByRole("heading", { name: "Discover keyboard shortcuts" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: /Keyboard Shortcuts/ }).click();
  await expect(
    page.getByRole("region", { name: "Keyboard shortcuts", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const reference = (await page
        .getByRole("region", { name: "Keyboard shortcuts", exact: true })
        .boundingBox())!;
      const ring = await page.locator(".nf-guide-highlight").boundingBox();
      return ring ? Math.abs(ring.x - reference.x + 4) : Infinity;
    })
    .toBeLessThan(2);
  await page.screenshot({
    path: testInfo.outputPath("welcome-keyboard-shortcuts.png"),
  });
  await page
    .locator('[data-dialog-kind="shortcuts"]')
    .getByTitle("Close", { exact: true })
    .click();
  await expect(
    guide.getByRole("heading", { name: "Ready to explore", exact: true }),
  ).toBeVisible();
});

for (const platform of ["MacIntel", "Win32"]) {
  /** Shows the platform modifier as shared keycaps and verifies the advertised binding opens the palette. */
  test(`guide palette shortcut matches ${platform}`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript((value) => {
      Object.defineProperty(navigator, "platform", { get: () => value });
    }, platform);
    await openSample(page);
    if (platform === "Win32")
      await page.setViewportSize({ width: 1100, height: 1000 });
    await page.getByRole("button", { name: "Open Welcome Guide" }).click();
    const guide = page.getByTestId("welcome-guide");
    await guide.getByRole("button", { name: /Your first lights/ }).click();
    await reachStep(page, "Find your way around");
    const keys = guide.locator(".nf-guide-inline-shortcut kbd");
    await expect(keys).toHaveCount(3);
    await expect(keys.nth(0)).toHaveAttribute(
      "title",
      platform === "MacIntel" ? "Command" : "Ctrl",
    );
    await expect(keys.nth(1)).toHaveAttribute("title", "Shift");
    await expect(keys.nth(2)).toHaveText("p");
    await expect(guide).not.toContainText("Ctrl/Cmd");
    await page.screenshot({ path: testInfo.outputPath("guide-shortcut.png") });
    await page.keyboard.press(
      platform === "MacIntel" ? "Meta+Shift+p" : "Control+Shift+p",
    );
    await expect(
      page.locator('[data-dialog-kind="command-palette"]'),
    ).toBeVisible();
    await expect(
      guide.getByRole("heading", { name: "Open the Programmer", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("guide-programmer-step.png"),
    });
    const paletteInput = page.locator(
      '[data-dialog-kind="command-palette"] input',
    );
    await expect(guide.locator(".nf-guide-pointer")).toBeVisible();
    const paletteHeight = (await page
      .locator('[data-dialog-kind="command-palette"] > :first-child')
      .boundingBox())!.height;
    await paletteInput.fill("Open Programmer");
    await expect
      .poll(
        async () =>
          (await page
            .locator('[data-dialog-kind="command-palette"] > :first-child')
            .boundingBox())!.height,
      )
      .toBeLessThan(paletteHeight);
    // Allow both the resize observer and dialog polling to reattach to the shortened palette.
    await page.waitForTimeout(600);
    const filteredPlacement = (await guide.boundingBox())!;
    const filteredPalette = (await page
      .locator('[data-dialog-kind="command-palette"] > :first-child')
      .boundingBox())!;
    const horizontalGap = Math.max(
      filteredPalette.x - filteredPlacement.x - filteredPlacement.width,
      filteredPlacement.x - filteredPalette.x - filteredPalette.width,
      0,
    );
    const verticalGap = Math.max(
      filteredPalette.y - filteredPlacement.y - filteredPlacement.height,
      filteredPlacement.y - filteredPalette.y - filteredPalette.height,
      0,
    );
    expect(Math.hypot(horizontalGap, verticalGap)).toBeLessThanOrEqual(64);
    expect(horizontalGap > 0 || verticalGap > 0).toBe(true);
    await paletteInput.fill("Programmer");
    await page.waitForTimeout(600);
    const stablePlacement = (await guide.boundingBox())!;
    expect(stablePlacement.x).toBeCloseTo(filteredPlacement.x, 0);
    expect(stablePlacement.y).toBeCloseTo(filteredPlacement.y, 0);
    await page.screenshot({
      path: testInfo.outputPath("guide-filtered-palette-stable.png"),
    });
    await expect(
      guide.getByRole("heading", { name: "Open the Programmer", exact: true }),
    ).toBeVisible();
    await paletteInput.press("Enter");
    await expect(guide.locator("code")).toHaveText("fix 310>313");
  });
}

/** Exercises Vite's file watcher and dependency graph while preserving the mounted workspace. */
test("lesson hot reload preserves the guide and Dockview layout", async ({
  page,
}, testInfo) => {
  // Worker CSS HMR currently throws in Vite's client (nightfall-lightdesk-bbg).
  await openSample(page, false);
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await guide.getByRole("button", { name: /Your first lights/ }).click();
  await reachStep(page, "Bring up the lights");
  const stepLabel = await guide
    .getByRole("status", { name: "Current step" })
    .innerText();
  await guide
    .getByRole("button", { name: "Open Programmer", exact: true })
    .click();
  await expect(
    page.getByText("Programmer is empty.", { exact: true }),
  ).toBeVisible();
  const workspace = await page.evaluateHandle(() => {
    const api = (window as any).appStores.dockApi.get();
    return {
      api,
      layout: JSON.stringify(api.toJSON()),
      shell: document.querySelector(".nf-app-viewport"),
      guide: document.querySelector('[data-testid="welcome-guide"]'),
    };
  });
  await page.route("**/features/welcome-guide/lessons.ts?*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text())
        .replace("Bring up the lights", "Preview edited copy")
        .replace("Your first lights", "Updated lesson title"),
    });
  });
  await page.screenshot({ path: testInfo.outputPath("guide-before-hmr.png") });
  // Trigger the real update graph without changing the author's lesson content.
  const modified = new Date();
  await utimes(
    new URL("../features/welcome-guide/lessons.ts", import.meta.url),
    modified,
    modified,
  );
  await expect(
    guide.getByRole("heading", { name: "Preview edited copy" }),
  ).toBeVisible();
  await expect(guide.getByRole("status", { name: "Current step" })).toHaveText(
    stepLabel,
  );
  await expect(guide.locator("code")).toHaveText("@ 100");
  expect(
    await workspace.evaluate((previous) => {
      const api = (window as any).appStores.dockApi.get();
      return {
        sameApi: api === previous.api,
        sameLayout: JSON.stringify(api.toJSON()) === previous.layout,
        sameShell:
          document.querySelector(".nf-app-viewport") === previous.shell,
        sameGuide:
          document.querySelector('[data-testid="welcome-guide"]') ===
          previous.guide,
      };
    }),
  ).toEqual({
    sameApi: true,
    sameLayout: true,
    sameShell: true,
    sameGuide: true,
  });
  await page.screenshot({ path: testInfo.outputPath("guide-after-hmr.png") });
  await guide.getByRole("button", { name: "Exit welcome guide" }).click();
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  await expect(
    guide.getByRole("button", { name: /Updated lesson title/ }),
  ).toBeVisible();
});

/** Requires both sample panels and skips setup when those panels are already open. */
test("sample setup waits for both panels and recognizes an existing workspace", async ({
  page,
}, testInfo) => {
  await openSample(page);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.removePanel(api.getPanel("panel-Visualizer"));
  });
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await guide.getByRole("button", { name: /Welcome to Nightfall/ }).click();
  await guide.getByRole("button", { name: "Continue", exact: true }).click();
  await guide
    .getByRole("button", { name: "Open Timeline 1: Lo-Fi", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Play timeline", exact: true }),
  ).toBeVisible();
  await expect(
    guide.getByRole("heading", { name: "Open the sample timeline" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("guide-open-sample-timeline.png"),
  });
  await guide
    .getByRole("button", { name: "Open 3D Visualizer", exact: true })
    .click();
  await expect(
    guide.getByRole("heading", { name: "Start the sample show" }),
  ).toBeVisible();
  await expect(guide.getByRole("button", { name: "Skip step" })).toHaveCount(0);
  await expect(guide.getByRole("status", { name: "Current step" })).toHaveText(
    "3/16",
  );
  await expect(
    guide
      .locator(".nf-guide-navigation")
      .getByRole("button", { name: "Back", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("tab", { name: "Timeline 1: Lo-fi", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Play timeline", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const card = (await guide.boundingBox())!;
      return page
        .getByRole("button", { name: "Play timeline", exact: true })
        .evaluate((button, bounds) => {
          const panel = button
            .closest("[data-panel-id]")!
            .getBoundingClientRect();
          return (
            Math.max(
              0,
              Math.min(bounds.x + bounds.width, panel.right) -
                Math.max(bounds.x, panel.left),
            ) *
            Math.max(
              0,
              Math.min(bounds.y + bounds.height, panel.bottom) -
                Math.max(bounds.y, panel.top),
            )
          );
        }, card);
    })
    .toBe(0);
  await page.screenshot({
    path: testInfo.outputPath("guide-timeline-clearance.png"),
  });
  await reachStep(page, "Ready to explore");
  await guide.getByRole("button", { name: "Finish lesson" }).click();
  await guide.getByRole("button", { name: /Welcome to Nightfall/ }).click();
  await guide.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    guide.getByRole("heading", { name: "Start the sample show" }),
  ).toBeVisible();
});

/** Drives sample playback and navigation through automatic steps while preserving modal usability. */
test("sample timeline actions advance and pop-outs leave the guide undimmed", async ({
  page,
}, testInfo) => {
  await openSample(page);
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await guide.getByRole("button", { name: /Welcome to Nightfall/ }).click();
  await guide.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(guide).toContainText("Lo-fi");
  await expect(
    guide.locator("header").getByRole("button", { name: "All lessons" }),
  ).toHaveCount(0);
  await expect(guide.getByRole("button", { name: "Start lesson" })).toHaveCount(
    0,
  );
  await expect(
    guide.getByRole("button", { name: "Back", exact: true }),
  ).toBeDisabled();
  await guide
    .getByRole("button", { name: "Open Timeline 1: Lo-Fi", exact: true })
    .click();
  await expect(
    guide.getByRole("heading", { name: "Start the sample show" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Play timeline", exact: true })
    .click();
  await expect(
    guide.getByRole("heading", { name: "Stop playback" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Stop timeline", exact: true })
    .click();
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  await guide.getByRole("button", { name: /Your first lights/ }).click();
  await expect(
    guide.getByRole("heading", { name: "Find your way around" }),
  ).toBeVisible();
  await expect(guide).toContainText("Use the Command Palette to open panels");
  await expect
    .poll(async () => {
      const card = (await guide.boundingBox())!;
      const button = (await page
        .getByRole("button", { name: "Open command palette", exact: true })
        .boundingBox())!;
      return Math.hypot(
        Math.max(
          0,
          card.x - button.x - button.width,
          button.x - card.x - card.width,
        ),
        Math.max(
          0,
          card.y - button.y - button.height,
          button.y - card.y - card.height,
        ),
      );
    })
    .toBeLessThanOrEqual(20);
  await page.screenshot({
    path: testInfo.outputPath("guide-palette-button.png"),
  });
  await page
    .getByRole("button", { name: "Open command palette", exact: true })
    .click();
  await expectGuideOutsideBackdrop(page);
  await expect(guide).toContainText("Open Programmer");
  await page.screenshot({
    path: testInfo.outputPath("guide-palette-desktop.png"),
  });
  await page
    .getByPlaceholder("Type a command or search...")
    .fill("Open Programmer");
  await page.keyboard.press("Enter");
  await expect(
    guide.getByRole("heading", { name: "Select lights by number" }),
  ).toBeVisible();
  const hint = guide.locator("code");
  await expect(hint).toBeVisible();
  await page.setViewportSize({ width: 700, height: 900 });
  await page
    .getByRole("button", { name: "Open command palette", exact: true })
    .click();
  await expectGuideOutsideBackdrop(page);
  await page.screenshot({
    path: testInfo.outputPath("guide-palette-narrow.png"),
  });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Exit welcome guide" }).click();
  await page
    .getByRole("button", { name: "Open command palette", exact: true })
    .click();
  const fullBackdrop = await page
    .locator('[data-dialog-kind="command-palette"]')
    .boundingBox();
  expect(fullBackdrop?.width).toBe(700);
  expect(fullBackdrop?.height).toBe(900);
});

/** Exercises selection, live programming, acknowledged storage, and resumable guide UI. */
test("welcome guide teaches live selection and cue storage without blocking the app", async ({
  page,
}, testInfo) => {
  await openSample(page);
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await expect(guide).toBeVisible();
  await expect(
    guide.getByRole("button", { name: /FOLLOW-ON LESSON/ }),
  ).toHaveCount(5);
  await guide.getByRole("button", { name: /Your first lights/ }).click();
  await expect(guide.getByRole("button", { name: "Start lesson" })).toHaveCount(
    0,
  );
  await expect(
    guide.getByRole("button", { name: "Back", exact: true }),
  ).toBeDisabled();
  await reachStep(page, "Select lights by number");
  await expect(page.getByTestId("guide-target")).toBeVisible();
  const command = page.getByRole("textbox", {
    name: "Command input",
    exact: true,
  });
  await command.fill("fix 310>313");
  await command.press("Enter");
  await expect(
    guide.getByRole("heading", { name: "Bring up the lights" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.programmerSelection.get().length,
      ),
    )
    .toBe(4);
  await command.fill("@ 100");
  await command.press("Enter");
  await expect(
    guide.getByRole("heading", { name: "Make a red look" }),
  ).toBeVisible();
  await command.fill("red @ 100 green @ 0 blue @ 0");
  await command.press("Enter");
  await expect(
    guide.getByRole("heading", { name: "Store the red cue" }),
  ).toBeVisible();
  await expect(
    guide.getByRole("button", { name: "Open Programmer", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Store cue", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Store Cue" });
  await dialog.getByLabel("Sequence ID", { exact: true }).fill("50");
  await dialog.getByLabel("Cue ID", { exact: true }).fill("1");
  await dialog.getByLabel("Label", { exact: true }).fill("Guide Red");
  await dialog.getByRole("button", { name: "Store Cue", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    guide.getByRole("heading", { name: "Make a blue look" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Exit welcome guide" }).click();
  await expect(guide).toBeHidden();
  await expect(page.getByTestId("guide-target")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Open Welcome Guide", exact: true })
    .click();
  await expect(
    guide.getByRole("heading", { name: "Make a blue look" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("welcome-guide-desktop.png"),
  });
  await reachStep(page, "Release the Programmer");
  await page
    .getByRole("button", { name: "Clear programmer", exact: true })
    .first()
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.programmerSelection.get().length,
      ),
    )
    .toBe(0);
  await page
    .getByRole("button", { name: "Clear programmer", exact: true })
    .first()
    .click();
  await expect(
    guide.getByRole("heading", { name: "Edit your new sequence" }),
  ).toBeVisible();
  await guide
    .getByRole("button", { name: "Open Sequences", exact: true })
    .click();
  const sequenceUid = await page.evaluate(
    () =>
      (Object.values((window as any).appStores.sequences.get()) as any[]).find(
        (s) => s.identifiers.id === 50,
      ).identifiers.uid,
  );
  await page.locator(`[data-crud-select-id="${sequenceUid}"]`).dblclick();
  const cueUid = await page.evaluate(
    (uid) => (window as any).appStores.sequences.get()[uid].steps[1],
    sequenceUid,
  );
  await page
    .locator(
      `[data-grid-column-key="trigger"][data-grid-row-key="${cueUid}:cue"]`,
    )
    .dblclick();
  await page
    .locator("[data-hs-select-dropdown].opened")
    .getByText("Manual", { exact: true })
    .click();
  await expect(
    guide.getByRole("heading", { name: /Create.*clip/ }),
  ).toBeVisible();
});

/** Builds both looks and a dedicated clip without modifying the sample sequence. */
test("first lights builds its own Red and Blue sequence", async ({
  page,
}, testInfo) => {
  await openSample(page);
  const original = await page.evaluate(() =>
    JSON.stringify(
      (Object.values((window as any).appStores.sequences.get()) as any[]).find(
        (s) => s.identifiers.id === 1,
      ),
    ),
  );
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await guide.getByRole("button", { name: /Your first lights/ }).click();
  await reachStep(page, "Store the red cue");
  await guide
    .getByRole("button", { name: "Open Programmer", exact: true })
    .click();
  const input = page.locator("#header-cmdline");
  for (const command of [
    "fix 310>313",
    "@ 100",
    "red @ 100 green @ 0 blue @ 0",
  ]) {
    await input.fill(command);
    await input.press("Enter");
  }
  for (const [id, label] of [
    ["1", "Red"],
    ["2", "Blue"],
  ]) {
    if (id === "2") {
      await expect(
        guide.getByRole("heading", { name: "Make a blue look" }),
      ).toBeVisible();
      await input.fill("red @ 0 green @ 0 blue @ 100");
      await input.press("Enter");
      await expect(
        guide.getByRole("heading", { name: "Store the blue cue" }),
      ).toBeVisible();
    }
    await page.getByRole("button", { name: "Store cue", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Store Cue" });
    await dialog.getByLabel("Sequence ID", { exact: true }).fill("50");
    await dialog.getByLabel("Cue ID", { exact: true }).fill(id);
    await dialog.getByLabel("Label", { exact: true }).fill(label);
    await dialog
      .getByRole("button", { name: "Store Cue", exact: true })
      .click();
    await expect(dialog).toBeHidden();
  }
  await expect(
    guide.getByRole("heading", { name: "Clear the Programmer" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Clear programmer", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Clear programmer", exact: true })
    .first()
    .click();
  await expect(
    guide.getByRole("heading", { name: "Edit your new sequence" }),
  ).toBeVisible();
  await guide
    .getByRole("button", { name: "Open Sequences", exact: true })
    .click();
  const sequenceUid = await page.evaluate(
    () =>
      (Object.values((window as any).appStores.sequences.get()) as any[]).find(
        (s) => s.identifiers.id === 50,
      ).identifiers.uid,
  );
  await page.locator(`[data-crud-select-id="${sequenceUid}"]`).dblclick();
  await expect(
    guide.getByRole("heading", { name: "Let Go advance to Blue" }),
  ).toBeVisible();
  await expect(page.getByTestId("guide-target")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("guide-blue-trigger.png"),
  });
  const cueUid = await page.evaluate(
    (uid) => (window as any).appStores.sequences.get()[uid].steps[1],
    sequenceUid,
  );
  await page
    .locator(
      `[data-grid-column-key="trigger"][data-grid-row-key="${cueUid}:cue"]`,
    )
    .dblclick();
  await page
    .locator("[data-hs-select-dropdown].opened")
    .getByText("Manual", { exact: true })
    .click();
  await expect(
    guide.getByRole("heading", { name: /Create.*clip/ }),
  ).toBeVisible();
  await guide.getByRole("button", { name: "Open Clips", exact: true }).click();
  await page.getByRole("button", { name: "Add clip", exact: true }).click();
  const create = page.getByRole("dialog", { name: "Create clip" });
  await create.getByLabel("Label", { exact: true }).fill("First Lights");
  await create.getByLabel("ID", { exact: true }).fill("50");
  await expect(create.getByLabel("ID", { exact: true })).toHaveValue("50");
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (Object.values((window as any).appStores.clips.get()) as any[]).some(
          ([clip]) => clip.identifiers.id === 50,
        ),
      ),
    )
    .toBe(true);
  await expect(
    guide.getByRole("heading", { name: "Choose your clip’s sequence" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Inspect clip 50", exact: true })
    .click();
  await page.getByPlaceholder("Find a sequence...").fill("50");
  await page
    .locator('[data-component="PropertiesInspector"]')
    .getByText(/^50:/)
    .click();
  await expect(
    guide.getByRole("heading", { name: "Make room for the Visualizer" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Properties", exact: true }).click();
  await expect(
    guide.getByRole("heading", { name: "Put First Lights on control 6" }),
  ).toBeVisible();
  const state = await page.evaluate(() => {
    const stores = (window as any).appStores;
    const sequences = Object.values(stores.sequences.get()) as any[];
    const sequence = sequences.find((s) => s.identifiers.id === 50);
    return {
      original: JSON.stringify(sequences.find((s) => s.identifiers.id === 1)),
      cues: sequence.steps.map(
        (uid: string) => stores.cues.get()[uid].identifiers.label,
      ),
    };
  });
  expect(state.original).toBe(original);
  expect(state.cues).toEqual(["Red", "Blue"]);
  await page.screenshot({
    path: testInfo.outputPath("first-lights-sequence.png"),
  });
  const expand = page.getByRole("button", {
    name: "Expand controls",
    exact: true,
  });
  if (await expand.isVisible()) await expand.click();
  const clipUid = await page.evaluate(
    () =>
      (Object.values((window as any).appStores.clips.get()) as any[]).find(
        ([clip]) => clip.identifiers.id === 50,
      )[0].identifiers.uid,
  );
  const clipCard = page.locator(`[data-crud-select-id="${clipUid}"]`);
  await expect
    .poll(async () => {
      const card = await clipCard.boundingBox();
      if (!card) return false;
      return page.locator(".nf-guide-highlight").evaluateAll(
        (highlights, rect) =>
          highlights.some((highlight) => {
            const bounds = highlight.getBoundingClientRect();
            return (
              Math.abs(bounds.left - (rect.x - 4)) < 1 &&
              Math.abs(bounds.top - (rect.y - 4)) < 1 &&
              Math.abs(bounds.width - (rect.width + 8)) < 1
            );
          }),
        card,
      );
    })
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("guide-clip-source-highlight.png"),
  });
  await page
    .locator(`[data-crud-select-id="${clipUid}"]`)
    .dragTo(page.locator('[data-clip-dropzone-index="6"]'));
  await expect(page.locator('[data-control-go-index="6"]')).toBeEnabled();
  await expect(
    guide.getByRole("heading", { name: "Start First Lights" }),
  ).toBeVisible();
  const goTarget = page.locator('[data-control-go-index="6"]');
  const scrollChange = await goTarget.evaluate((element) => {
    let scroller = element.parentElement;
    while (
      scroller &&
      !(
        scroller.scrollWidth > scroller.clientWidth &&
        /auto|scroll/.test(getComputedStyle(scroller).overflowX)
      )
    ) {
      scroller = scroller.parentElement;
    }
    if (!scroller) throw new Error("Expected horizontally scrolling controls");
    const previous = scroller.scrollLeft;
    const max = scroller.scrollWidth - scroller.clientWidth;
    scroller.scrollLeft =
      previous < max - 20
        ? Math.min(max, previous + 40)
        : Math.max(0, previous - 40);
    return Math.abs(scroller.scrollLeft - previous);
  });
  expect(scrollChange).toBeGreaterThan(0);
  await expect
    .poll(async () => {
      const target = (await goTarget.boundingBox())!;
      const highlight = await page.locator(".nf-guide-highlight").boundingBox();
      return highlight ? Math.abs(highlight.x - (target.x - 4)) : 999;
    })
    .toBeLessThan(1);
  await expect
    .poll(async () => {
      const target = (await goTarget.boundingBox())!;
      const card = (await guide.boundingBox())!;
      return Math.max(
        card.y - target.y - target.height,
        target.y - card.y - card.height,
        0,
      );
    })
    .toBeLessThanOrEqual(20);
  await expect(guide.locator(".nf-guide-pointer")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("guide-scrolled-controls.png"),
  });
  await page.locator('[data-control-go-index="6"]').click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.keys((window as any).appStores.activeInstances.get()).length,
      ),
    )
    .toBeGreaterThan(0);
  await expect(
    guide.getByRole("heading", { name: "Advance to blue" }),
  ).toBeVisible();
  await page.locator('[data-control-go-index="6"]').click();
  await expect(
    guide.getByRole("heading", { name: "Control the level" }),
  ).toBeVisible();
  const fader = page.locator('[data-control-index="6"] [role="slider"]');
  await fader.focus();
  await fader.press("Home");
  await expect(fader).toHaveAttribute("aria-valuenow", "0.0");
  await fader.press("ArrowUp");
  await expect
    .poll(async () => Number(await fader.getAttribute("aria-valuenow")))
    .toBeGreaterThan(0);
  await expect(page.getByTestId("guide-target")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("welcome-guide-clips.png"),
  });
  await guide.getByRole("button", { name: "Continue", exact: true }).click();
  await clipCard.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.keys((window as any).appStores.activeInstances.get()).length,
      ),
    )
    .toBe(0);
});

/** Keeps header actions equally tall and makes Guide return to the menu from active or closed lessons. */
test("Guide always opens the lesson menu and matches header button height", async ({
  page,
}, testInfo) => {
  await openSample(page);
  const button = page.getByRole("button", {
    name: "Open Welcome Guide",
    exact: true,
  });
  const search = page.getByRole("button", {
    name: "Open command palette",
    exact: true,
  });
  expect((await button.boundingBox())!.height).toBe(
    (await search.boundingBox())!.height,
  );
  await button.click();
  const guide = page.getByTestId("welcome-guide");
  await guide.getByRole("button", { name: /Your first lights/i }).click();
  await expect(
    guide.getByRole("button", { name: "Continue", exact: true }),
  ).toBeVisible();
  await button.click();
  await expect(
    guide.getByRole("button", { name: /Your first lights/i }),
  ).toBeVisible();
  await guide.getByRole("button", { name: /Your first lights/i }).click();
  await guide.getByRole("button", { name: "Exit welcome guide" }).click();
  await button.click();
  await expect(
    guide.getByRole("button", { name: /Your first lights/i }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("guide-header-menu.png") });
});

/** Covers optional entry, independent lessons, capability messaging, narrow screens and persistence. */
test("lesson library starts sample lessons immediately and preserves completion", async ({
  page,
}, testInfo) => {
  await openSample(page);
  await expect(page.getByTestId("welcome-guide")).toHaveCount(0);
  await page.getByRole("button", { name: "Open command palette" }).click();
  await page
    .getByPlaceholder("Type a command or search...")
    .fill("Open Welcome Guide");
  await page.keyboard.press("Enter");
  const guide = page.getByTestId("welcome-guide");
  await expect(guide).toBeVisible();
  await guide.getByRole("button", { name: /Transports and output/ }).click();
  await expect(
    guide.getByRole("heading", { name: "Open I/O Transports" }),
  ).toBeVisible();
  await expect(guide.getByRole("button", { name: "Start lesson" })).toHaveCount(
    0,
  );
  await expect(
    guide.getByRole("button", { name: "Back", exact: true }),
  ).toBeDisabled();
  for (let index = 0; index < 3; index += 1)
    await guide.getByRole("button", { name: "Continue", exact: true }).click();
  await guide.getByRole("button", { name: "Finish lesson" }).click();
  await expect(
    guide.getByRole("button", { name: /Transports and output/ }),
  ).toContainText("Completed");
  await guide.getByRole("button", { name: /Step FX designer/ }).click();
  await expect(guide.getByRole("button", { name: "Start lesson" })).toHaveCount(
    0,
  );
  await expect(
    guide.getByRole("button", { name: "Back", exact: true }),
  ).toBeDisabled();
  await guide.getByRole("button", { name: "Open FX List" }).click();
  await page.getByRole("button", { name: "Add effect", exact: true }).click();
  await page.getByRole("button", { name: "Step FX", exact: true }).click();
  await expect(page.getByRole("tab", { name: /Step FX/ })).toBeVisible();
  await reachStep(page, "Ready to explore");
  await guide.getByRole("button", { name: "Finish lesson" }).click();
  await guide.getByRole("button", { name: /Patching fixtures/ }).click();
  await expect(guide.locator(".nf-guide-action")).toHaveCount(0);
  await guide.getByRole("button", { name: "Open Patch", exact: true }).click();
  await expect(guide).toContainText("pixel strip 310");
  await page.setViewportSize({ width: 700, height: 900 });
  await expect(guide).toBeVisible();
  const dimensions = await guide.evaluate((element) => ({
    width: element.clientWidth,
    scrollWidth: element.scrollWidth,
    height: element.getBoundingClientRect().height,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
  expect(dimensions.height).toBeLessThan(450);
  await page.screenshot({
    path: testInfo.outputPath("welcome-guide-narrow.png"),
  });
  await reachStep(page, "Ready to explore");
  await guide.getByRole("button", { name: "Finish lesson" }).click();
  await page.getByRole("button", { name: "Exit welcome guide" }).click();
  await page
    .getByRole("button", { name: "Open Welcome Guide", exact: true })
    .click();
  await expect(
    guide.getByRole("button", { name: /Transports and output/ }),
  ).toContainText("Completed");
});
