// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.use({ sampleDataOnly: true });

const pageErrors = new WeakMap<Page, string[]>();

/** Records asynchronous errors that can otherwise be missed during automatic step changes. */
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});

/** Fails on stale tooltip callbacks and other unexpected browser errors. */
test.afterEach(({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

/** Opens the sample_data.rs-generated show and waits for its practice rig. */
async function openSample(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    localStorage.removeItem("nightfall.e2eAutoOpenStartupShowfile");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
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

/** Verifies palette backdrops exclude the guide, including the stacked narrow layout. */
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
  expect(
    backdrop!.x + backdrop!.width <= guide!.x + 1 ||
      backdrop!.y + backdrop!.height <= guide!.y + 1,
  ).toBe(true);
}

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

/** Gives each guide step a brief cue, then settles; reduced-motion users get the same static emphasis. */
test("guide hints bounce briefly and respect reduced motion", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openSample(page);
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await guide.getByRole("button", { name: /START HERE/ }).click();
  await reachStep(page, "Select lights by number");
  await expect(
    page.getByRole("textbox", { name: "Command input", exact: true }),
  ).toBeFocused();
  const hint = page.locator('[role="tooltip"].nf-guide-tooltip');
  await expect(hint).toBeVisible();
  await expect
    .poll(() =>
      hint.evaluate((element) =>
        element
          .getAnimations()
          .some(
            (animation) =>
              animation instanceof CSSAnimation &&
              animation.animationName === "nf-guide-tooltip-bounce" &&
              animation.playState === "running",
          ),
      ),
    )
    .toBe(true);
  await expect(hint).toHaveCSS("pointer-events", "auto");
  await expect(hint).toHaveCSS("user-select", "text");
  await expect
    .poll(() => hint.evaluate((element) => element.getAnimations().length))
    .toBe(0);
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
  await expect
    .poll(() =>
      hint.evaluate((element) =>
        element
          .getAnimations()
          .some(
            (animation) =>
              animation instanceof CSSAnimation &&
              animation.animationName === "nf-guide-tooltip-bounce" &&
              animation.playState === "running",
          ),
      ),
    )
    .toBe(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(hint).toHaveCSS("animation-name", "none");
  await expect(hint).toHaveCSS("transition-duration", "0s");
  await expect(hint).toBeVisible();
  await command.fill("@ 100");
  await command.press("Enter");
  await expect(hint.locator("code")).toHaveText("red @ 100 green @ 0 blue @ 0");
  await expect(hint).toHaveCSS("animation-name", "none");
  await guide.getByRole("button", { name: "All lessons" }).hover();
  const regular = page
    .getByRole("tooltip")
    .filter({ hasText: /^All lessons$/ });
  await expect(regular).toBeVisible();
  expect(
    await regular.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  ).not.toBe(
    await hint.evaluate((element) => getComputedStyle(element).backgroundColor),
  );
  await page.screenshot({
    path: testInfo.outputPath("guide-reduced-motion.png"),
  });
});

/** Drives sample playback and navigation through automatic steps while preserving modal usability. */
test("sample timeline actions advance and pop-outs leave the guide undimmed", async ({
  page,
}, testInfo) => {
  await openSample(page);
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await guide.getByRole("button", { name: /START HERE/ }).click();
  await expect(guide).toContainText("Lo-fi");
  await expect(
    guide.locator("header").getByRole("button", { name: "All lessons" }),
  ).toBeVisible();
  await expect(guide.getByRole("button", { name: "Start lesson" })).toHaveCount(
    0,
  );
  await expect(
    guide.getByRole("button", { name: "Back", exact: true }),
  ).toBeDisabled();
  await guide
    .getByRole("button", { name: "Open Timelines", exact: true })
    .click();
  await page.getByRole("button", { name: /Timeline 1: Lo-fi/ }).click();
  await expect(
    guide.getByRole("heading", { name: "Start the sample show" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Play timeline", exact: true })
    .click();
  await expect(
    guide.getByRole("heading", { name: "Watch, then stop" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Stop timeline", exact: true })
    .click();
  await expect(
    guide.getByRole("heading", { name: "Find your way around" }),
  ).toBeVisible();
  await expect(page.locator(".nf-guide-tooltip")).toHaveText(
    "Use the Command Palette to open panels",
  );
  await page
    .getByRole("button", { name: "Open command palette", exact: true })
    .click();
  await expectGuideOutsideBackdrop(page);
  await expect(page.locator(".nf-guide-tooltip")).toHaveText(
    "Open the Programmer panel",
  );
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
  const hint = page.getByRole("tooltip").filter({ hasText: "fix 310>313" });
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
  await guide.getByRole("button", { name: /START HERE/ }).click();
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
  await guide
    .getByRole("button", { name: "Open Programmer", exact: true })
    .click();
  await page.getByRole("button", { name: "Store cue", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Store Cue" });
  await dialog.getByLabel("Sequence ID", { exact: true }).fill("1");
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
    guide.getByRole("heading", { name: "Put RGB cycle (full) on control 6" }),
  ).toBeVisible();
});

/** Keeps the lesson visible while assigning a clip, starting it, and changing its fader. */
test("clip lesson permits drag assignment, Go and fader playback", async ({
  page,
}, testInfo) => {
  await openSample(page);
  await page.getByRole("button", { name: "Open Welcome Guide" }).click();
  const guide = page.getByTestId("welcome-guide");
  await guide.getByRole("button", { name: /START HERE/ }).click();
  await expect(guide.getByRole("button", { name: "Start lesson" })).toHaveCount(
    0,
  );
  await expect(
    guide.getByRole("button", { name: "Back", exact: true }),
  ).toBeDisabled();
  await reachStep(page, "Put RGB cycle (full) on control 6");
  await guide.getByRole("button", { name: "Open Clips", exact: true }).click();
  const expand = page.getByRole("button", {
    name: "Expand controls",
    exact: true,
  });
  if (await expand.isVisible()) await expand.click();
  const clipUid = await page.evaluate(
    () =>
      (Object.values((window as any).appStores.clips.get()) as any[]).find(
        ([clip]) => clip.identifiers.id === 1,
      )[0].identifiers.uid,
  );
  await page
    .locator(`[data-crud-select-id="${clipUid}"]`)
    .dragTo(page.locator('[data-clip-dropzone-index="6"]'));
  await expect(page.locator('[data-control-go-index="6"]')).toBeEnabled();
  await expect(
    guide.getByRole("heading", { name: "Start RGB cycle (full)" }),
  ).toBeVisible();
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
  const command = page.getByRole("textbox", {
    name: "Command input",
    exact: true,
  });
  await guide.getByRole("button", { name: "Continue", exact: true }).click();
  await command.fill("clip 1 stop");
  await command.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.keys((window as any).appStores.activeInstances.get()).length,
      ),
    )
    .toBe(0);
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
    await guide.getByRole("button", { name: "Skip step" }).click();
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
  await guide.getByRole("button", { name: "All lessons" }).click();
  await guide.getByRole("button", { name: /Patching fixtures/ }).click();
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
  await guide.getByRole("button", { name: "All lessons" }).click();
  await page.getByRole("button", { name: "Exit welcome guide" }).click();
  await page
    .getByRole("button", { name: "Open Welcome Guide", exact: true })
    .click();
  await expect(
    guide.getByRole("button", { name: /Transports and output/ }),
  ).toContainText("Completed");
});
