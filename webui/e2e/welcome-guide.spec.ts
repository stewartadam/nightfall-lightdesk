// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { utimes } from "node:fs/promises";
import { REQUIRES_DEV_SERVER, servesE2eBuild } from "./app-hooks";
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

/** Combines context and copyable commands in a movable card without reducing the app viewport. */
test("floating lessons provide context, selectable commands and manual placement", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openSample(page);
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await openLesson(guide, /Your first lights/);
  await reachStep(page, "Select lights");
  // Skipping "Open the Programmer" leaves it closed, so the step offers to open it first.
  await guide
    .getByRole("button", { name: "Open Programmer", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Command input", exact: true }),
  ).toBeFocused();
  const hint = guide;
  await expect(hint).toBeVisible();
  await expect(page.locator(".nf-app-viewport")).toHaveCSS("width", "1440px");
  await expect(hint).toContainText("inclusive range");
  const before = (await hint.boundingBox())!;
  const commandBounds = (await page.locator("#header-cmdline").boundingBox())!;
  // The card may sit on any side of the command line, as long as it doesn't cover it.
  expect(
    before.y >= commandBounds.y + commandBounds.height ||
      before.x >= commandBounds.x + commandBounds.width ||
      before.x + before.width <= commandBounds.x,
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
    .toBe("fix 370>373");
  await page.screenshot({
    path: testInfo.outputPath("guide-emphasized-hint.png"),
  });
  const command = page.getByRole("textbox", {
    name: "Command input",
    exact: true,
  });
  await command.fill("fix 370>373");
  await command.press("Enter");
  await expect(hint.locator("code")).toHaveText("@ 100");
  const introduction = guide.getByText(
    "The Programmer holds live lighting instructions.",
    { exact: true },
  );
  const explanation = guide.getByText(
    "The @ command sets the selected strips’ intensity",
    { exact: false },
  );
  const action = guide.locator(".nf-guide-action");
  expect((await explanation.boundingBox())!.y).toBeGreaterThan(
    (await introduction.boundingBox())!.y,
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
  await guide
    .getByRole("button", { name: "Type command", exact: true })
    .click();
  await expect(command).toHaveValue("red @ 100 green @ 0 blue @ 0");
  await expect(command).toBeFocused();
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
  await command.fill("fix 370>373 @ 100 red @ 100 green @ 0 blue @ 0");
  await command.press("Enter");
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await openLesson(guide, /Your first lights/);
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
    const { GUIDE_LESSONS } = (await window.__nightfallHarness.load("app"))
      .welcomeGuideLessons;
    const intensity = GUIDE_LESSONS.find(
      (lesson) => lesson.id === "welcome",
    )!.steps.find((step) => step.id === "intensity")!;
    intensity.content.push({
      type: "text",
      text: "Text after the action callout.",
    });
  });
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await openLesson(guide, /Your first lights/);
  await removeLessonPanel(page, "panel-Visualizer");
  await reachStep(page, "Bring up the lights");
  await expect(guide).toContainText(
    "The Programmer holds live lighting instructions.",
  );
  await expect(guide.locator(".nf-guide-action")).toHaveCount(0);
  await expect(guide).not.toContainText("The @ command");
  await expect(guide).not.toContainText("Text after the action callout.");
  // The hidden action is not highlighted; the Programmer tab that reveals the missing panel is.
  const programmerTab = await activeLayout(page)
    .getByRole("tab", { name: "Programmer", exact: true })
    .boundingBox();
  await expect
    .poll(async () => {
      const highlight = await page
        .getByTestId("guide-target")
        .locator(".nf-guide-highlight")
        .boundingBox();
      return highlight && programmerTab
        ? Math.abs(highlight.x + 4 - programmerTab.x) < 2 &&
            Math.abs(highlight.y + 4 - programmerTab.y) < 2
        : false;
    })
    .toBe(true);
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
    .getByRole("button", { name: "Type command", exact: true })
    .click();
  const commandInput = page.getByRole("textbox", {
    name: "Command input",
    exact: true,
  });
  await expect(commandInput).toHaveValue("@ 100");
  await expect(commandInput).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath("guide-prerequisite-ready.png"),
  });
});

/** Shows prerequisite shortcuts again when their panels become hidden, collapsed, or closed. */
test("guide shortcuts follow panel visibility", async ({ page }, testInfo) => {
  await openSample(page);
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await openLesson(guide, /Your first lights/);
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
  // The card can briefly keep its pre-move offset, so wait for it to center over Stop.
  await expect
    .poll(async () => {
      const card = (await guide.boundingBox())!;
      const target = (await stop.boundingBox())!;
      return Math.abs(card.x + card.width / 2 - (target.x + target.width / 2));
    })
    .toBeLessThan(0.5);
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

/** Confirms overwriting an existing clip waits for Alt, preserves its identity, and advances the guide. */
test("clip overwrite holds for Alt and advances the guide", async ({
  page,
}, testInfo) => {
  await openSample(page);
  const input = page.locator("#header-cmdline");
  await input.fill("store clip 50");
  await input.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (Object.values((window as any).appStores.clips.get()) as any[]).some(
          ([clip]) => clip.identifiers.id === 50,
        ),
      ),
    )
    .toBe(true);
  await input.fill("set clip 50 target=sequence 1");
  await input.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (Object.values((window as any).appStores.clips.get()) as any[]).find(
            ([clip]) => clip.identifiers.id === 50,
          )?.[0].source?.type,
      ),
    )
    .toBe("Sequence");
  const original = await page.evaluate(
    () =>
      (Object.values((window as any).appStores.clips.get()) as any[]).find(
        ([clip]) => clip.identifiers.id === 50,
      )[0],
  );
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await openLesson(guide, /Your first lights/);
  await reachStep(page, /Create.*clip/);
  await guide.getByRole("button", { name: "Open Clips", exact: true }).click();
  await page.getByRole("button", { name: "Add clip", exact: true }).click();
  const create = page.getByRole("dialog", { name: "Create clip" });
  await create.getByLabel("Label", { exact: true }).fill("Replacement");
  await create.getByLabel("ID", { exact: true }).fill("50");
  const overwrite = create.getByRole("button", {
    name: "Overwrite",
    exact: true,
  });
  await expect(overwrite).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath("clip-overwrite-warning.png"),
  });
  expect(
    await page.evaluate(
      (uid) => (window as any).appStores.clips.get()[uid][0],
      original.identifiers.uid,
    ),
  ).toEqual(original);
  await page.keyboard.down("Alt");
  await overwrite.click();
  await page.keyboard.up("Alt");
  await expect(
    guide.getByRole("heading", { name: "Choose your clip’s sequence" }),
  ).toBeVisible();
  const updated = await page.evaluate(
    (uid) => (window as any).appStores.clips.get()[uid][0],
    original.identifiers.uid,
  );
  expect(updated.identifiers.uid).toBe(original.identifiers.uid);
  expect(updated.identifiers.label).toBe("Replacement");
  expect(updated.source == null).toBe(true);
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
    await openLesson(guide, /Your first lights/);
    await reachStep(page, "Find your way around");
    const keys = guide.locator(".nf-guide-inline-shortcut kbd[data-kbd-key]");
    await expect(keys).toHaveCount(3);
    await expect(keys.nth(0)).toHaveAttribute(
      "title",
      platform === "MacIntel" ? "Command" : "Control",
    );
    await expect(keys.nth(1)).toHaveAttribute("title", "Shift");
    await expect(keys.nth(2)).toHaveText("P");
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
    // The card joins the palette's top layer, so the modal neither covers nor disables it.
    await expect(
      page.locator(
        'dialog[open]:has([data-dialog-kind="command-palette"]) [data-testid="welcome-guide"]',
      ),
    ).toBeVisible();
    expect(
      await guide.evaluate((card) => {
        const rect = card.getBoundingClientRect();
        return card.contains(
          document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          ),
        );
      }),
    ).toBe(true);
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
    await paletteInput.fill("open programmer");
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
    await expect(guide.locator("code")).toHaveText("fix 370>373");
  });
}

/** Exercises Vite's file watcher and dependency graph while preserving the mounted workspace. */
test("lesson hot reload preserves the guide and Dockview layout", async ({
  page,
}, testInfo) => {
  test.skip(servesE2eBuild, REQUIRES_DEV_SERVER);
  // Worker CSS HMR currently throws in Vite's client (nightfall-lightdesk-bbg).
  await openSample(page, false);
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await openLesson(guide, /Your first lights/);
  await reachStep(page, "Bring up the lights");
  const stepLabel = await guide
    .getByRole("status", { name: "Current step" })
    .innerText();
  await guide
    .getByRole("button", { name: "Open Programmer", exact: true })
    .click();
  await expect(
    activeLayout(page).getByText("Programmer is empty.", { exact: true }),
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

/** Drives sample playback and navigation through automatic steps while preserving modal usability. */
test("sample timeline actions advance and pop-outs leave the guide undimmed", async ({
  page,
}, testInfo) => {
  await openSample(page);
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await openLesson(guide, /Welcome to Nightfall/);
  await expect(
    guide.getByRole("button", { name: "Back", exact: true }),
  ).toBeDisabled();
  await guide.getByRole("button", { name: NEXT_STEP }).click();
  await expect(guide).toContainText("Lo-fi");
  await expect(
    guide.locator("header").getByRole("button", { name: "All lessons" }),
  ).toHaveCount(0);
  await expect(guide.getByRole("button", { name: "Start lesson" })).toHaveCount(
    0,
  );
  await guide
    .getByRole("button", { name: "Open Timeline 1: Lo-fi", exact: true })
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
  await openLesson(guide, /Your first lights/);
  await expect(
    guide.getByRole("heading", { name: "Find your way around" }),
  ).toBeVisible();
  await expect(guide).toContainText("The Command Palette opens panels");
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
  await expect(guide).toContainText("Search for 'Programmer'");
  await page.screenshot({
    path: testInfo.outputPath("guide-palette-desktop.png"),
  });
  await page
    .getByPlaceholder("Type a command or search...")
    .fill("Open Programmer");
  await page.keyboard.press("Enter");
  await expect(
    guide.getByRole("heading", { name: "Select lights" }),
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
  await openLesson(guide, /Your first lights/);
  await expect(guide.getByRole("button", { name: "Start lesson" })).toHaveCount(
    0,
  );
  await expect(
    guide.getByRole("button", { name: "Back", exact: true }),
  ).toBeDisabled();
  await reachStep(page, "Select lights");
  await guide
    .getByRole("button", { name: "Open Programmer", exact: true })
    .click();
  await expect(page.getByTestId("guide-target")).toBeVisible();
  const command = page.getByRole("textbox", {
    name: "Command input",
    exact: true,
  });
  await command.fill("fix 370>373");
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
  await page.screenshot({
    path: testInfo.outputPath("welcome-guide-desktop.png"),
  });
  await reachStep(page, "Clear the Programmer");
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
});

/** Builds both looks and a dedicated clip without modifying the sample sequence. */
test("first lights builds its own Red and Blue sequence", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
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
  await openLesson(guide, /Your first lights/);
  await reachStep(page, "Store the red cue");
  await guide
    .getByRole("button", { name: "Open Programmer", exact: true })
    .click();
  const input = page.locator("#header-cmdline");
  for (const command of [
    "fix 370>373",
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
  await activeLayout(page)
    .locator(`[data-crud-select-id="${sequenceUid}"]`)
    .dblclick();
  await expect(
    guide.getByRole("heading", { name: "Let Go advance to Blue" }),
  ).toBeVisible();
  // Going Back to a step whose condition still holds stays there until the user moves on.
  await guide.getByRole("button", { name: "Back", exact: true }).click();
  const openSequence = guide.getByRole("heading", {
    name: "Edit your new sequence",
  });
  await expect(openSequence).toBeVisible();
  await page.waitForTimeout(500);
  await expect(openSequence).toBeVisible();
  await guide.getByRole("button", { name: NEXT_STEP }).click();
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
  const trigger = activeLayout(page).locator(
    `[data-grid-column-key="trigger"][data-grid-row-key="${cueUid}:cue"]`,
  );
  // The card sits just right of the Trigger cell, inside the editor and below its tab.
  await expect
    .poll(async () => {
      const card = (await guide.boundingBox())!;
      const cell = (await trigger.boundingBox())!;
      const tab = (await activeLayout(page)
        .locator('.dv-tab:has-text("Sequence 50")')
        .boundingBox())!;
      return (
        card.x >= cell.x + cell.width &&
        card.x - (cell.x + cell.width) <= 32 &&
        card.y >= tab.y + tab.height
      );
    })
    .toBe(true);
  const beside = (await guide.boundingBox())!;
  await trigger.dblclick();
  // Opening the Trigger menu slides the card sideways at most; it keeps its height.
  await expect(page.locator("[data-hs-select-dropdown].opened")).toBeVisible();
  await expect
    .poll(async () => {
      const card = (await guide.boundingBox())!;
      return Math.abs(card.y - beside.y) < 2 && card.x >= beside.x;
    })
    .toBe(true);
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
  await activeLayout(page).getByPlaceholder("Find a sequence...").fill("50");
  await activeLayout(page)
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
  const clipCard = activeLayout(page).locator(
    `[data-crud-select-id="${clipUid}"]`,
  );
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
  await activeLayout(page)
    .locator(`[data-crud-select-id="${clipUid}"]`)
    .dragTo(activeLayout(page).locator('[data-clip-dropzone-index="6"]'));
  await expect(
    activeLayout(page).locator('[data-control-button-index="6"]'),
  ).toBeEnabled();
  await expect(
    guide.getByRole("heading", { name: "Start First Lights" }),
  ).toBeVisible();
  const goTarget = activeLayout(page).locator(
    '[data-control-button-index="6"]',
  );
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
  await activeLayout(page).locator('[data-control-button-index="6"]').click();
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
  await activeLayout(page).locator('[data-control-button-index="6"]').click();
  await expect(
    guide.getByRole("heading", { name: "Control the level" }),
  ).toBeVisible();
  const fader = activeLayout(page).locator(
    '[data-control-index="6"] [role="slider"]',
  );
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
  await guide.getByRole("button", { name: NEXT_STEP }).click();
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
  await openLesson(guide, /Your first lights/i);
  await expect(guide.getByRole("button", { name: NEXT_STEP })).toBeVisible();
  await button.click();
  await expect(
    guide.getByRole("button", { name: /Your first lights/i }),
  ).toBeVisible();
  await openLesson(guide, /Your first lights/i);
  await guide.getByRole("button", { name: "Exit welcome guide" }).click();
  await button.click();
  await expect(
    guide.getByRole("button", { name: /Your first lights/i }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("guide-header-menu.png") });
});

/** Opens the lesson library and starts the named lesson from its first step. */
async function startLesson(page: Page, lesson: RegExp) {
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await openLesson(guide, lesson);
  return guide;
}

/** Runs a panel command from the Command Palette. */
async function paletteCommand(page: Page, name: string) {
  await page
    .getByRole("button", { name: "Open command palette", exact: true })
    .click();
  await page.getByPlaceholder("Type a command or search...").fill(name);
  await page.keyboard.press("Enter");
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

/** Exiting mid-lesson ends it like finishing does, so the user is never left in the Lesson layout. */
test("exiting a lesson restores the user's layout and removes the Lesson layout", async ({
  page,
}) => {
  await openSample(page);
  const userLayout = page.getByRole("button", { name: /^Layout 1: / });
  const lessonLayout = page.getByRole("button", {
    name: /^Layout \d+: Lesson$/,
  });
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await openLesson(guide, /Welcome to Nightfall/);
  await expect(lessonLayout).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Exit welcome guide" }).click();
  await expect(guide).toBeHidden();
  await expect(userLayout).toHaveAttribute("aria-pressed", "true");
  await expect(lessonLayout).toHaveCount(0);
});

/** A panel covered by an edge panel is not ready; its button collapses the covering edge panel. */
test("covered prerequisite panels offer Show and make room", async ({
  page,
}, testInfo) => {
  await openSample(page);
  const guide = await startLesson(page, /Your first lights/);
  await reachStep(page, "Select lights");
  await page.getByRole("tab", { name: "Clips", exact: true }).click();
  await page.getByRole("tab", { name: "Properties", exact: true }).click();
  const show = guide.getByRole("button", {
    name: "Show 3D Visualizer",
    exact: true,
  });
  await expect(show).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("covered-visualizer.png"),
  });
  await show.click();
  await expect(show).toHaveCount(0);
  await expect(
    activeLayout(page).locator('[data-component="ClipList"]'),
  ).toBeVisible();
  await expect(
    activeLayout(page).locator('[data-component="PropertiesInspector"]'),
  ).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("visualizer-shown.png") });
});

/** Edge panel collapses still advance the guide after a layout reset replaces the edge groups. */
test("collapsing Properties advances after the layout is reset", async ({
  page,
}) => {
  await openSample(page);
  await paletteCommand(page, "Reset Layout");
  const guide = await startLesson(page, /Your first lights/);
  await reachStep(page, "Choose your clip’s sequence");
  await page.getByRole("tab", { name: "Properties", exact: true }).click();
  await expect(
    activeLayout(page).locator('[data-component="PropertiesInspector"]'),
  ).toBeVisible();
  await guide.getByRole("button", { name: NEXT_STEP }).click();
  await expect(
    guide.getByRole("heading", { name: "Make room for the Visualizer" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Properties", exact: true }).click();
  await expect(
    guide.getByRole("heading", { name: "Put First Lights on control 6" }),
  ).toBeVisible();
});

/** Steps that ask for a typed command focus the command input, even without an explicit focus flag. */
test("command steps focus the command input", async ({ page }) => {
  await openSample(page);
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await openLesson(guide, /Your first lights/);
  await reachStep(page, "Bring up the lights");
  const programmer = guide.getByRole("button", {
    name: "Open Programmer",
    exact: true,
  });
  if (await programmer.isVisible()) await programmer.click();
  await page.getByRole("button", { name: "Open command palette" }).focus();
  await guide.getByRole("button", { name: NEXT_STEP }).click();
  await expect(
    guide.getByRole("heading", { name: "Make a red look" }),
  ).toBeVisible();
  await expect(page.locator("#header-cmdline")).toBeFocused();
  // The focused input shows its own focus ring, so the guide drops its pulse.
  await expect(page.locator(".nf-guide-highlight")).toHaveAttribute(
    "data-target-focused",
    "",
  );
});

/** First launch shows the invitation; dismissing it hides it and the app menu still opens the guide. */
test("first launch invites the user and Help reopens the guide", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("nightfall.e2e.guideReset")) {
      sessionStorage.setItem("nightfall.e2e.guideReset", "1");
      localStorage.removeItem("nightfall.guide.v1.dismissed");
    }
  });
  await openSample(page);
  const invitation = page.getByRole("complementary", {
    name: "Welcome to Nightfall",
  });
  await expect(invitation).toContainText("New to Nightfall?");
  await page.screenshot({
    path: testInfo.outputPath("guide-first-launch-invitation.png"),
  });
  await invitation.getByRole("button", { name: "Explore on my own" }).click();
  await expect(invitation).toHaveCount(0);
  await page.reload();
  await waitForDockviewApp(page);
  await expect(invitation).toHaveCount(0);

  await page.locator('[title="Menu"]').click();
  const welcomeItem = page
    .locator('[data-menu-kind="dropdown"]')
    .getByRole("button", { name: "Welcome Guide" });
  await expect(welcomeItem).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("guide-app-menu-entry.png"),
  });
  await welcomeItem.click();
  await expect(page.getByTestId("welcome-guide")).toBeVisible();
});

/**
 * Walks the Patch lesson end to end: selecting a row, adding four RGBW bars as 701–704 through the
 * Add fixture wizard after trying both modes, placing them, finding their routes, lighting them,
 * clearing, and deleting them again. Checks that multi-part steps move their highlight, and
 * screenshots each step's card beside its target.
 */
test("patch lesson adds, lights and removes practice fixtures", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await openSample(page);
  await page.evaluate(() =>
    localStorage.setItem("nightfall-patch-panel:active-tab", "fixtures"),
  );
  let shots = 0;
  /** Captures the whole app once the step's highlight has settled. */
  const shot = async (name: string) => {
    await expect(page.getByTestId("guide-target").first()).toBeVisible();
    shots += 1;
    await page.screenshot({
      path: testInfo.outputPath(
        `patch-${String(shots).padStart(2, "0")}-${name}.png`,
      ),
    });
  };
  const guide = await startLesson(page, /Patching fixtures/);
  const wizard = page.getByRole("dialog", { name: "Patch Wizard" });
  const patch = activeLayout(page).locator('[data-panel-kind="patch"]');

  /** Waits until the guide's highlight frames the center of `target`. */
  const expectHighlightOn = async (target: Locator) => {
    await expect
      .poll(async () => {
        const [frame, box] = await Promise.all([
          page.getByTestId("guide-target").first().boundingBox(),
          target.boundingBox(),
        ]);
        if (!frame || !box) return false;
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        return (
          x >= frame.x &&
          x <= frame.x + frame.width &&
          y >= frame.y &&
          y <= frame.y + frame.height
        );
      })
      .toBe(true);
  };
  /** Finds a fixture's cell in Patch by its user-facing ID and column key. */
  const patchCell = async (id: number, column: string) => {
    const uid = await page.evaluate(
      (fixtureId) =>
        (Object.values((window as any).appStores.fixtures.get()) as any[]).find(
          (fixture) => fixture.identifiers.id === fixtureId,
        )?.identifiers.uid as string,
      id,
    );
    return patch.locator(
      `[data-grid-row-key="${uid}"][data-grid-column-key="${column}"]`,
    );
  };

  await expectStep(page, "Open Patch", { target: true });
  await paletteCommand(page, "Open Patch");
  await expectStep(page, "Select a patched fixture", { target: true });
  await expect(
    guide.getByRole("button", { name: "Skip", exact: true }),
  ).toBeVisible();
  await shot("select-row");
  await (await patchCell(310, "id")).click();

  await expectStep(page, "Add fixtures", { target: true });
  const programmerSelection = await page.evaluate(() =>
    (window as any).appStores.programmerSelection.get(),
  );
  expect(programmerSelection).toEqual([]);
  const addFixture = patch.getByRole("button", {
    name: "Add fixture",
    exact: true,
  });
  await expectHighlightOn(addFixture);
  await patch.locator('[role="tab"][id$="-routes"]').click();
  await expectHighlightOn(patch.locator('[role="tab"][id$="-fixtures"]'));
  await shot("add-fixtures-tab");
  await patch.locator('[role="tab"][id$="-fixtures"]').click();
  await expectHighlightOn(addFixture);
  await shot("add-fixtures");
  await addFixture.click();

  await expectStep(page, "Pick a fixture definition", { target: true });
  const barEntry = wizard
    .locator('[data-grid-column-key="model"]')
    .filter({ hasText: /^12-segment RGBW Bar$/ })
    .first();
  await expectHighlightOn(barEntry);
  await shot("pick-definition");
  await barEntry.click();
  const next = wizard.getByRole("button", { name: "Next", exact: true });
  await expectHighlightOn(next);
  await shot("pick-definition-next");
  await next.click();

  await expectStep(page, "Pick a mode", { target: true });
  const modes = wizard.getByRole("region", { name: "Fixture modes" });
  await expectHighlightOn(modes.getByRole("button", { name: "Segments" }));
  await shot("pick-mode");
  await modes.getByRole("button", { name: "Segments" }).click();
  await expect(
    wizard.getByText("48 DMX channels", { exact: true }),
  ).toBeVisible();
  await expectHighlightOn(next);
  await shot("pick-mode-next");
  await next.click();

  await expectStep(page, "Choose quantity and IDs", { target: true });
  await expectHighlightOn(wizard.getByLabel("Quantity", { exact: true }));
  await shot("quantity");
  await wizard.getByLabel("Quantity", { exact: true }).fill("4");
  await expectHighlightOn(
    wizard.getByLabel("First fixture ID", { exact: true }),
  );
  await shot("first-id");
  await wizard.getByLabel("First fixture ID", { exact: true }).fill("701");
  await expect(
    wizard.getByText("New fixtures get IDs 701–704.", { exact: false }),
  ).toBeVisible();

  await expectStep(page, "Choose their DMX address", { target: true });
  const universe = wizard.getByLabel("Universe", { exact: true });
  const startAddress = wizard.getByLabel("Start address", { exact: true });
  await expect(universe).not.toHaveValue("");
  await expect(wizard.getByText(/conflicts with/)).toBeHidden();
  await expectHighlightOn(universe);
  await shot("address-suggested");
  const suggestedAddress = await startAddress.inputValue();
  await universe.fill("21");
  await expect(startAddress).toHaveValue(suggestedAddress);
  await expectHighlightOn(startAddress);
  await shot("address-universe");
  await startAddress.fill("1");
  await expect(wizard.getByText(/conflicts with/)).toBeHidden();
  await expectHighlightOn(next);
  await guide.getByText("Learn more", { exact: true }).click();
  await expect(
    guide.getByRole("link", { name: "Read more in the user guide" }),
  ).toHaveAttribute(
    "href",
    /^https:\/\/nightfall\.live\/docs\/\d+\.\d+\.\d+\/user-guide\/dmx-patching\.html$/,
  );
  await shot("address");
  await wizard.getByRole("button", { name: "Next", exact: true }).click();

  await expectStep(page, "Add them to the show", { target: true });
  await expect(wizard.getByText("IDs 701–704")).toBeVisible();
  await expect(wizard.getByText("Segments", { exact: true })).toBeVisible();
  /** Reports which side of the dialog the card sits on while level with Finish. */
  const finishCardSide = async () => {
    const [card, dialog, finish] = await Promise.all([
      guide.boundingBox(),
      wizard.locator('[role="document"]').first().boundingBox(),
      wizard.getByRole("button", { name: "Finish", exact: true }).boundingBox(),
    ]);
    if (!card || !dialog || !finish) return undefined;
    const finishY = finish.y + finish.height / 2;
    if (finishY < card.y || finishY > card.y + card.height) return undefined;
    if (card.x >= dialog.x + dialog.width - 2) return "right";
    if (card.x + card.width <= dialog.x + 2) return "left";
    return undefined;
  };
  // The card sits beside the dialog, level with Finish, instead of above or below it.
  await expect.poll(finishCardSide).toBe("left");
  await shot("finish");
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 1800, height: 1000 });
  await expect.poll(finishCardSide).toBe("right");
  await page.screenshot({
    path: testInfo.outputPath("patch-finish-wide.png"),
  });
  if (viewport) await page.setViewportSize(viewport);
  await expect.poll(finishCardSide).toBe("left");
  await wizard.getByRole("button", { name: "Finish", exact: true }).click();
  await expect(wizard).toBeHidden();

  await expectStep(page, "Place them on stage", { target: true });
  const patched = await page.evaluate(() =>
    (Object.values((window as any).appStores.fixtures.get()) as any[])
      .filter(
        (fixture) =>
          fixture.identifiers.id >= 701 && fixture.identifiers.id <= 704,
      )
      .map((fixture) => [fixture.identifiers.id, fixture.model])
      .sort(),
  );
  expect(patched).toEqual(
    [701, 702, 703, 704].map((id) => [id, "12-segment RGBW Bar"]),
  );
  const routed = await page.evaluate(() => {
    const stores = (window as any).appStores;
    const fixtures = Object.values(stores.fixtures.get()) as any[];
    const uidOf = (id: number) =>
      fixtures
        .find((fixture) => fixture.identifiers.id === id)
        ?.identifiers.uid.replace(/-/g, "");
    return [701, 702, 703, 704].map((id) => {
      const route = stores.routes
        .get()
        .output.find((entry: any) =>
          entry.source.data.uids?.some(
            (uid: string | number[]) =>
              (typeof uid === "string"
                ? uid.replace(/-/g, "")
                : Array.from(uid, (byte) =>
                    byte.toString(16).padStart(2, "0"),
                  ).join("")) === uidOf(id),
          ),
        );
      return [route?.target.data.universe?.start, route?.target.data.address];
    });
  });
  expect(routed).toEqual([
    [21, 1],
    [21, 49],
    [21, 97],
    [21, 145],
  ]);
  await expectHighlightOn(
    patch.locator('[data-grid-header-id="tanstack-header-pos_x"]'),
  );
  await shot("place");
  await (await patchCell(701, "pos_x")).click();
  await (await patchCell(704, "pos_x")).click({ modifiers: ["Shift"] });
  await page.keyboard.type("-2>2");
  await page.keyboard.press("Enter");
  await expectHighlightOn(
    patch.locator('[data-grid-header-id="tanstack-header-pos_y"]'),
  );
  await shot("place-height");
  await (await patchCell(701, "pos_y")).click();
  await (await patchCell(704, "pos_y")).click({ modifiers: ["Shift"] });
  await page.keyboard.type("3");
  await page.keyboard.press("Enter");
  await expectStep(page, "Switch to the DMX Routes view", { target: true });
  const positions = await page.evaluate(() =>
    (Object.values((window as any).appStores.fixtures.get()) as any[])
      .filter(
        (fixture) =>
          fixture.identifiers.id >= 701 && fixture.identifiers.id <= 704,
      )
      .sort((a, b) => a.identifiers.id - b.identifiers.id)
      .map((fixture) => [
        Math.round(fixture.placement?.position.x * 100) / 100,
        fixture.placement?.position.y,
      ]),
  );
  expect(positions).toEqual([
    [-2, 3],
    [-0.67, 3],
    [0.67, 3],
    [2, 3],
  ]);
  await expect
    .poll(() =>
      patch.evaluate((panel) =>
        [
          ...panel.querySelectorAll<HTMLElement>(
            '[role="gridcell"][data-grid-column-key^="pos_"] .truncate',
          ),
        ]
          .filter((text) => text.scrollWidth > text.clientWidth)
          .map((text) => text.textContent),
      ),
    )
    .toEqual([]);

  await expectStep(page, "Switch to the DMX Routes view", { target: true });
  await shot("routes-tab");
  await patch.locator('[role="tab"][id$="-routes"]').click();

  await expectStep(page, "Light up your new bars", { target: true });
  await shot("routes-and-command");
  await guide
    .getByRole("button", { name: "Type command", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Command input", exact: true })
    .press("Enter");

  await expectStep(page, "Clear the Programmer", { target: true });
  await expect(
    guide.getByRole("button", { name: "Open Programmer", exact: true }),
  ).toHaveCount(0);
  await shot("clear");
  const clear = page
    .getByRole("button", { name: "Clear programmer", exact: true })
    .first();
  await clear.click();
  await clear.click();

  await expectStep(page, "Remove the practice bars (optional)", {
    target: true,
  });
  const fixturesTab = patch.locator('[role="tab"][id$="-fixtures"]');
  await expectHighlightOn(fixturesTab);
  await shot("remove-tab");
  await fixturesTab.click();
  const deleteButton = patch.getByRole("button", {
    name: "Delete selected fixtures",
    exact: true,
  });
  await expectHighlightOn(deleteButton);
  await expect(deleteButton).toBeEnabled();
  await expect(await patchCell(701, "id")).toBeVisible();
  await shot("remove-selected");
  await deleteButton.click();
  await expect(
    page.getByRole("button", { name: "Finish lesson" }),
  ).toBeVisible();
  await expect(guide.getByText(/still holds values/)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("patch-99-done.png") });
  const left = await page.evaluate(
    () =>
      (Object.values((window as any).appStores.fixtures.get()) as any[]).filter(
        (fixture) =>
          fixture.identifiers.id >= 701 && fixture.identifiers.id <= 704,
      ).length,
  );
  expect(left).toBe(0);
});
