// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.use({ sampleDataOnly: true });

const pageErrors = new WeakMap<Page, string[]>();
/** Matches the forward button, labelled Skip on steps that advance automatically. */
const NEXT_STEP = /^(Continue|Skip)$/;

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
      [6, "Red Chase"],
    ]),
  );
  expect(targets.timelines).toContainEqual([1, "Lo-fi"]);
}

/**
 * Starts a lesson from the open library and waits until it has switched to the Lesson layout
 * and shows its first step, so later clicks cannot land while the switch is still in progress.
 */
async function openLesson(guide: Locator, lesson: RegExp) {
  await guide.getByRole("button", { name: lesson }).click();
  await expect(
    guide.getByRole("progressbar", { name: "Lesson progress" }),
  ).toBeVisible();
}

/** Closes a panel in the Lesson layout, which every lesson starts from in its default arrangement. */
async function removeLessonPanel(page: Page, panelId: string) {
  await page.evaluate((id) => {
    const api = (window as any).appStores.dockApi.get();
    api.removePanel(api.getPanel(id));
  }, panelId);
}

/** Scopes queries to the visible layout, since switching layouts keeps the previous one mounted but hidden. */
function activeLayout(page: Page) {
  return page.locator('[data-workspace-active="true"]');
}

/** Moves through guide instructions without pretending skipped actions succeeded. */
async function reachStep(page: Page, title: string | RegExp) {
  const guide = page.getByTestId("welcome-guide");
  for (let index = 0; index < 20; index += 1) {
    if (
      await guide.getByRole("heading", { name: title, exact: true }).isVisible()
    )
      return;
    await guide.getByRole("button", { name: NEXT_STEP }).click();
  }
  throw new Error(`Did not reach guide step: ${title}`);
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
  const visualizer = activeLayout(page).getByLabel("3D visualizer viewport", {
    exact: true,
  });
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
  const panel = activeLayout(page).locator(
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
  // Narrower windows move some bottom tabs into the overflow menu, which is covered elsewhere.
  for (const width of [1440, 1280]) {
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
        const fixtures = activeLayout(page).locator(
          '[data-panel-kind="fixtures"]',
        );
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
  const panel = activeLayout(page).locator(
    '[data-panel-kind="programmer"]:visible',
  );
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
  await openLesson(guide, /Welcome to Nightfall/);
  await guide.getByRole("button", { name: NEXT_STEP }).click();
  await guide
    .getByRole("button", { name: "Open Timeline 1: Lo-fi", exact: true })
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
  await openLesson(guide, /Welcome to Nightfall/);
  await expect(page.locator(".nf-guide-highlight")).toBeVisible();
  const visualizer = activeLayout(page).locator(
    '[data-component="Visualizer"][data-panel-id]',
  );
  await expect
    .poll(async () => {
      const target = await visualizer.boundingBox();
      const highlight = await page.locator(".nf-guide-highlight").boundingBox();
      return target && highlight ? Math.abs(target.x - highlight.x) : Infinity;
    })
    .toBeLessThanOrEqual(5);
  await guide.getByRole("button", { name: NEXT_STEP }).click();
  await guide
    .getByRole("button", { name: "Open Timeline 1: Lo-fi", exact: true })
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
    .getByRole("button", { name: "Open Timeline 1: Lo-fi", exact: true })
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
  const tile = activeLayout(page).locator(`[data-crud-select-id="${uid}"]`);
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
  const properties = activeLayout(page).locator(
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
  await activeLayout(page)
    .locator(".dv-tab")
    .filter({ hasText: "Timeline 1: Lo-fi" })
    .click();
  await expect(
    properties.getByText("Timeline Properties", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("welcome-basics-properties.png"),
  });
  await guide.getByRole("button", { name: NEXT_STEP }).click();
  await expect(
    guide.getByRole("heading", {
      name: "A shortcut for lighting instructions",
    }),
  ).toBeVisible();
  await expect(page.locator("#header-cmdline")).toBeFocused();
  await guide.getByRole("button", { name: NEXT_STEP }).click();
  await expect(
    guide.getByRole("heading", { name: "Arrange your workspace" }),
  ).toBeVisible();
  await guide.getByRole("button", { name: NEXT_STEP }).click();
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
  // The highlight mounts inside the Settings dialog, sharing its top layer.
  await expect(
    page
      .getByRole("dialog", { name: "Settings", exact: true })
      .getByTestId("guide-target"),
  ).toBeVisible();
  // The card moves into the Settings dialog so its top layer neither covers nor disables it.
  await expect(
    page
      .getByRole("dialog", { name: "Settings", exact: true })
      .getByTestId("welcome-guide"),
  ).toBeVisible();
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
  await guide.getByRole("button", { name: NEXT_STEP }).click();
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
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(
    guide.getByRole("heading", { name: "Ready to explore", exact: true }),
  ).toBeVisible();
});

/** Replaces native saving instructions when the runtime has no disk storage for showfiles. */
test("welcome saving explains unavailable disk storage", async ({
  page,
}, testInfo) => {
  await openSample(page);
  await page.evaluate(() => {
    const store = (window as any).appStores.runtimeCapabilities;
    store.set({ ...store.get(), disk_storage: false });
  });
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await openLesson(guide, /Welcome to Nightfall/);
  await reachStep(page, "Demo edits are temporary");
  await expect(
    guide.getByText(
      /Automatic draft recovery and Save Showfile are unavailable here/,
    ),
  ).toBeVisible();
  await expect(
    guide.getByText(/Open Menu at the bottom left and choose Save Showfile/),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("welcome-no-persistence.png"),
  });
  await guide.getByRole("button", { name: NEXT_STEP }).click();
  await expect(
    guide.getByRole("heading", { name: "Discover keyboard shortcuts" }),
  ).toBeVisible();
});

/** Requires both sample panels and skips setup when those panels are already open. */
test("sample setup waits for both panels and recognizes an existing workspace", async ({
  page,
}, testInfo) => {
  await openSample(page);
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await openLesson(guide, /Welcome to Nightfall/);
  await removeLessonPanel(page, "panel-Visualizer");
  await guide.getByRole("button", { name: NEXT_STEP }).click();
  await guide
    .getByRole("button", { name: "Open Timeline 1: Lo-fi", exact: true })
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
  // Starting again rebuilds the Lesson layout, so reopen the timeline before reaching its step.
  await openLesson(guide, /Welcome to Nightfall/);
  await activeLayout(page)
    .getByRole("button", { name: /^Timeline 1: Lo-fi/ })
    .dblclick();
  await expect(
    page.getByRole("button", { name: "Play timeline", exact: true }),
  ).toBeVisible();
  await guide.getByRole("button", { name: NEXT_STEP }).click();
  await expect(
    guide.getByRole("heading", { name: "Start the sample show" }),
  ).toBeVisible();
});

/** Opens the lesson library and starts the named lesson from its first step. */
async function startLesson(page: Page, lesson: RegExp) {
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await openLesson(guide, lesson);
  return guide;
}

/** Submits one command through the header command input. */
async function submitCommand(page: Page, command: string) {
  const input = page.getByRole("textbox", {
    name: "Command input",
    exact: true,
  });
  await input.fill(command);
  await input.press("Enter");
}

/** Waits for a lesson heading, confirming the step's highlight resolved when expected. */
async function expectStep(
  page: Page,
  title: string,
  options: { target?: boolean } = {},
) {
  const guide = page.getByTestId("welcome-guide");
  await expect(
    guide.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  if (options.target)
    await expect(page.getByTestId("guide-target").first()).toBeVisible();
}

/**
 * Starting a lesson keeps the card and target highlight out of sight while the Lesson layout
 * slides in, then shows the card already beside its first target so it never jumps after appearing.
 */
test("lesson launch reveals the card after the layout transition", async ({
  page,
}, testInfo) => {
  await openSample(page);
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await expect(
    guide.getByRole("button", { name: /Welcome to Nightfall/ }),
  ).toBeVisible();
  await page.evaluate(() => {
    const state = window as unknown as {
      guideFrames: Array<Record<string, unknown>>;
      sampleGuideFrames: boolean;
    };
    state.guideFrames = [];
    state.sampleGuideFrames = true;
    /** Records the card, highlight and layout entrance state on every frame. */
    const sample = () => {
      if (!state.sampleGuideFrames) return;
      const card = document.querySelector<HTMLElement>(
        '[data-testid="welcome-guide"]',
      );
      const rect = card?.getBoundingClientRect();
      state.guideFrames.push({
        cardShown:
          !!card &&
          card.classList.contains("nf-guide-floating") &&
          getComputedStyle(card).visibility !== "hidden",
        x: rect?.x,
        y: rect?.y,
        highlight: !!document.querySelector('[data-testid="guide-target"]'),
        entering: document
          .getAnimations()
          .some(
            (animation) =>
              animation instanceof CSSAnimation &&
              animation.animationName === "nf-layout-enter" &&
              animation.playState === "running",
          ),
      });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await guide.getByRole("button", { name: /Welcome to Nightfall/ }).click();
  await expectStep(page, "Meet your sample rig", { target: true });
  await page.waitForTimeout(600);
  await page.screenshot({ path: testInfo.outputPath("lesson-launch.png") });
  const frames = await page.evaluate(() => {
    const state = window as unknown as {
      guideFrames: Array<{
        cardShown: boolean;
        x: number;
        y: number;
        highlight: boolean;
        entering: boolean;
      }>;
      sampleGuideFrames: boolean;
    };
    state.sampleGuideFrames = false;
    return state.guideFrames;
  });
  expect(frames.some((frame) => frame.entering)).toBe(true);
  expect(frames.filter((frame) => frame.cardShown && frame.entering)).toEqual(
    [],
  );
  expect(frames.filter((frame) => frame.highlight && !frame.cardShown)).toEqual(
    [],
  );
  const shown = frames.filter((frame) => frame.cardShown);
  expect(shown.length).toBeGreaterThan(0);
  const final = shown[shown.length - 1];
  for (const frame of shown) {
    expect(Math.abs(frame.x - final.x)).toBeLessThan(1);
    expect(Math.abs(frame.y - final.y)).toBeLessThan(1);
  }
});

/**
 * Runs an action that opens a panel and records, on every frame, the guide's step heading, card
 * position and highlight box, until the expected next step has been showing for a while.
 */
async function recordStepMotion(
  page: Page,
  action: () => Promise<void>,
  nextStep: string,
) {
  await page.evaluate(() => {
    const state = window as unknown as {
      guideMotion: Array<{ step: string; card: string; highlight: string }>;
      sampleGuideMotion: boolean;
    };
    state.guideMotion = [];
    state.sampleGuideMotion = true;
    /** Serializes a box so frames can be compared exactly. */
    const key = (box: DOMRect | undefined) =>
      box ? `${box.x},${box.y},${box.width},${box.height}` : "";
    /** Records the step heading, card and highlight on every frame. */
    const sample = () => {
      if (!state.sampleGuideMotion) return;
      const card = document.querySelector('[data-testid="welcome-guide"]');
      state.guideMotion.push({
        step: card?.querySelector("h2")?.textContent ?? "",
        card: key(card?.getBoundingClientRect()),
        highlight: key(
          document
            .querySelector('[data-testid="guide-target"] .nf-guide-highlight')
            ?.getBoundingClientRect(),
        ),
      });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await action();
  await expectStep(page, nextStep, { target: true });
  // Watch the new step over enough rendered frames to catch late layout, however slow the runner.
  await expect
    .poll(() =>
      page.evaluate(
        (step) =>
          (
            window as unknown as { guideMotion: Array<{ step: string }> }
          ).guideMotion.filter((frame) => frame.step === step).length,
        nextStep,
      ),
    )
    .toBeGreaterThanOrEqual(20);
  const frames = await page.evaluate(() => {
    const state = window as unknown as {
      guideMotion: Array<{ step: string; card: string; highlight: string }>;
      sampleGuideMotion: boolean;
    };
    state.sampleGuideMotion = false;
    return state.guideMotion;
  });
  return frames.filter((frame) => frame.step === nextStep);
}

/**
 * A step that opens a panel advances only once the next target has mounted and laid out, so the
 * next step's card and highlight appear where they stay instead of jumping as the panel fills in.
 */
test("opening a panel advances once its content has laid out", async ({
  page,
}) => {
  await openSample(page);
  const guide = await startLesson(page, /Welcome to Nightfall/);
  await reachStep(page, "Open the sample timeline");
  const frames = await recordStepMotion(
    page,
    () =>
      guide
        .getByRole("button", { name: "Open Timeline 1: Lo-fi", exact: true })
        .click(),
    "Start the sample show",
  );
  const highlights = frames.map((frame) => frame.highlight).filter(Boolean);
  expect(highlights.length).toBeGreaterThan(0);
  expect(new Set(highlights)).toEqual(new Set([highlights[0]]));
  expect(new Set(frames.map((frame) => frame.card)).size).toBe(1);
});

/** Detected steps label the forward button Skip and advance as soon as the action happens. */
test("observed steps offer Skip instead of Continue", async ({ page }) => {
  await openSample(page);
  const guide = await startLesson(page, /Welcome to Nightfall/);
  await expectStep(page, "Meet your sample rig");
  await expect(
    guide.getByRole("button", { name: "Continue", exact: true }),
  ).toBeVisible();
  await guide.getByRole("button", { name: "Continue", exact: true }).click();
  await expectStep(page, "Open the sample timeline");
  await expect(
    guide.getByRole("button", { name: "Skip", exact: true }),
  ).toBeVisible();
  await expect(
    guide.getByRole("button", { name: "Continue", exact: true }),
  ).toHaveCount(0);
  await guide
    .getByRole("button", { name: "Open Timeline 1: Lo-fi", exact: true })
    .click();
  await expectStep(page, "Start the sample show");
});

/** The orientation command step advances once the suggested command is submitted. */
test("orientation command step advances on the suggested command", async ({
  page,
}) => {
  await openSample(page);
  await startLesson(page, /Welcome to Nightfall/);
  await reachStep(page, "A shortcut for lighting instructions");
  await submitCommand(page, "fix 310");
  await expectStep(page, "A shortcut for lighting instructions");
  await submitCommand(page, "fix 601>606 green @ 100; sleep 2; clear");
  await expectStep(page, "Arrange your workspace");
});

/** The lesson end offers to stop playback that is still running and hides once it stops. */
test("lesson end stops leftover playback", async ({ page }) => {
  await openSample(page);
  await submitCommand(page, "clip 6 start");
  const guide = await startLesson(page, /Welcome to Nightfall/);
  await reachStep(page, "Ready to explore");
  await guide
    .getByRole("button", { name: "Stop all playback", exact: true })
    .click();
  await expect(
    guide.getByRole("button", { name: "Stop all playback", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (Object.values((window as any).appStores.clips.get()) as any[]).some(
          ([clip, active]) => clip.identifiers.id === 6 && active,
        ),
      ),
    )
    .toBe(false);
});

/** The lesson end clears a held selection and live values in a single press. */
test("lesson end clears the programmer in one press", async ({ page }) => {
  await openSample(page);
  await submitCommand(page, "fix 310>313 red @ 100");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.programmerState.get().length,
      ),
    )
    .toBeGreaterThan(0);
  const guide = await startLesson(page, /Welcome to Nightfall/);
  await reachStep(page, "Ready to explore");
  await expect(guide).toContainText("The Programmer still holds values.");
  await expect(
    guide.getByRole("button", { name: "Stop all playback", exact: true }),
  ).toHaveCount(0);
  await guide
    .getByRole("button", { name: "Clear programmer", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return (
          stores.programmerState.get().length +
          stores.programmerSelection.get().length
        );
      }),
    )
    .toBe(0);
  await expect(
    guide.getByRole("button", { name: "Clear programmer", exact: true }),
  ).toHaveCount(0);
});

/** A user layout that happens to be named Lesson is left alone; lessons get their own layout. */
test("lessons never take over a user layout named Lesson", async ({ page }) => {
  await openSample(page);
  await page.evaluate(async () => {
    const { createNamedLayout } = (await window.__nightfallHarness.load("app"))
      .layoutManagement;
    await createNamedLayout((window as any).appStores.dockApi.get(), "Lesson", {
      blank: true,
    });
  });
  await expect(
    page.getByRole("button", { name: "Layout 2: Lesson", exact: true }),
  ).toBeVisible();
  await startLesson(page, /Welcome to Nightfall/);
  await expect(
    page.getByRole("button", { name: "Layout 3: Lesson 2", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Layout 2: Lesson", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
});

/**
 * Lessons start from the default panels in their own layout and stay in it through the save
 * step, since saving leaves the transient Lesson layout out of the show.
 */
test("lessons use the Lesson layout through the save step", async ({
  page,
}, testInfo) => {
  await openSample(page);
  const userLayout = page.getByRole("button", { name: /^Layout 1: / });
  const lessonLayout = page.getByRole("button", {
    name: /^Layout \d+: Lesson$/,
  });
  await page.getByRole("tab", { name: "Clips", exact: true }).click();
  await expect(
    activeLayout(page).locator('[data-component="ClipList"]'),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await expect(guide.getByTestId("guide-layout-notice")).toContainText(
    "Lesson layout",
  );
  await openLesson(guide, /Welcome to Nightfall/);
  await expect(
    guide.getByRole("heading", { name: "Meet your sample rig" }),
  ).toBeVisible();
  await expect(lessonLayout).toHaveAttribute("aria-pressed", "true");
  // The default arrangement keeps Clips collapsed, unlike the user's layout above.
  await expect(
    activeLayout(page).locator('[data-component="ClipList"]'),
  ).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("lesson-layout.png") });
  await reachStep(page, "Edits apply as you work");
  // The undo card sits above the status bar buttons rather than beside them.
  const undoTarget = page.locator('[data-guide-target="undo-redo"]');
  await expect
    .poll(async () => {
      const card = (await guide.boundingBox())!;
      const target = (await undoTarget.boundingBox())!;
      return card.y + card.height <= target.y;
    })
    .toBe(true);
  await page.screenshot({ path: testInfo.outputPath("undo-step.png") });
  await reachStep(page, "Keep a saved version of your show");
  await expect(lessonLayout).toHaveAttribute("aria-pressed", "true");
  await expect(userLayout).toHaveAttribute("aria-pressed", "false");
  await expect(guide).not.toContainText("switched back to your own layout");
  await page.screenshot({ path: testInfo.outputPath("save-step.png") });
  await reachStep(page, "Discover keyboard shortcuts");
  await guide.getByRole("button", { name: NEXT_STEP }).click();
  await expect(
    guide.getByRole("button", { name: "Finish lesson", exact: true }),
  ).toBeVisible();
  // Looking around changes nothing, so the last page doesn't suggest saving.
  await expect(guide).not.toContainText("Save your practice show");
  await page.screenshot({ path: testInfo.outputPath("final-page.png") });
});

/** Finishing a lesson switches back to the layout the user had before it and deletes the Lesson layout, with no separate return button. */
test("finishing a lesson restores the user's layout and removes the Lesson layout", async ({
  page,
}) => {
  await openSample(page);
  const userLayout = page.getByRole("button", { name: /^Layout 1: / });
  const lessonLayout = page.getByRole("button", {
    name: /^Layout \d+: Lesson$/,
  });
  await page.getByRole("tab", { name: "Clips", exact: true }).click();
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await openLesson(guide, /Welcome to Nightfall/);
  await expect(lessonLayout).toHaveAttribute("aria-pressed", "true");
  await reachStep(page, "Ready to explore");
  await expect(guide.getByRole("button", { name: /^Return to / })).toHaveCount(
    0,
  );
  await guide
    .getByRole("button", { name: "Finish lesson", exact: true })
    .click();
  await expect(userLayout).toHaveAttribute("aria-pressed", "true");
  await expect(
    activeLayout(page).locator('[data-component="ClipList"]'),
  ).toBeVisible();
  await expect(lessonLayout).toHaveCount(0);
});
