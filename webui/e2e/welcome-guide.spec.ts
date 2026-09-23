// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  expect,
  type Page,
  frontendOnlyTest as test,
} from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

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

/** Opens the actual embedded engine and waits for its practice rig. */
async function openDemo(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      Object.keys((window as any).appStores?.fixtures?.get() ?? {}).length ===
      6,
  );
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
  const guide = await page.getByTestId("welcome-guide").boundingBox();
  const backdrop = await page
    .locator('[data-dialog-kind="command-palette"]')
    .boundingBox();
  expect(guide).not.toBeNull();
  expect(backdrop).not.toBeNull();
  expect(
    backdrop!.x + backdrop!.width <= guide!.x + 1 ||
      backdrop!.y + backdrop!.height <= guide!.y + 1,
  ).toBe(true);
}

/** Drives sample playback and navigation through automatic steps while preserving modal usability. */
test("sample timeline actions advance and pop-outs leave the guide undimmed", async ({
  page,
}, testInfo) => {
  await openDemo(page);
  await page.getByRole("button", { name: "Take the tour" }).click();
  const guide = page.getByTestId("welcome-guide");
  await guide.getByRole("button", { name: /START HERE/ }).click();
  await expect(guide).toContainText("Nightfall Demo");
  await expect(
    guide.locator("header").getByRole("button", { name: "All lessons" }),
  ).toBeVisible();
  await guide.getByRole("button", { name: "Start lesson" }).click();
  await guide
    .getByRole("button", { name: "Open Timelines", exact: true })
    .click();
  await page
    .getByRole("button", { name: /Timeline 1: Nightfall Demo/ })
    .click();
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
  await page
    .getByRole("button", { name: "Open command palette", exact: true })
    .click();
  await expectGuideOutsideBackdrop(page);
  await page.screenshot({
    path: testInfo.outputPath("guide-palette-desktop.png"),
  });
  await page
    .getByPlaceholder("Type a command or search...")
    .fill("Open Fixtures");
  await page.keyboard.press("Enter");
  await expect(
    guide.getByRole("heading", { name: "Select lights by number" }),
  ).toBeVisible();
  const hint = page.getByRole("tooltip").filter({ hasText: "Type fix 1>5" });
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
  await openDemo(page);
  await page.getByRole("button", { name: "Take the tour" }).click();
  const guide = page.getByTestId("welcome-guide");
  await expect(guide).toBeVisible();
  await expect(
    guide.getByRole("button", { name: /FOLLOW-ON LESSON/ }),
  ).toHaveCount(5);
  await guide.getByRole("button", { name: /START HERE/ }).click();
  await guide.getByRole("button", { name: "Start lesson" }).click();
  await reachStep(page, "Select lights by number");
  await expect(page.getByTestId("guide-target")).toBeVisible();
  const command = page.getByRole("textbox", {
    name: "Command input",
    exact: true,
  });
  await command.fill("fix 1>5");
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
    .toBe(5);
  await command.fill("@ 100");
  await command.press("Enter");
  await expect(
    guide.getByRole("heading", { name: "Make a red look" }),
  ).toBeVisible();
  await command.fill("fix 1>5 red @ 100 green @ 0 blue @ 0");
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
  await page
    .getByRole("button", { name: "Clear programmer", exact: true })
    .first()
    .click();
  await expect(
    guide.getByRole("heading", { name: "Put Nightfall Looks on control 1" }),
  ).toBeVisible();
});

/** Keeps the lesson visible while assigning a clip, starting it, and changing its fader. */
test("clip lesson permits drag assignment, Go and fader playback", async ({
  page,
}, testInfo) => {
  await openDemo(page);
  await page.getByRole("button", { name: "Take the tour" }).click();
  const guide = page.getByTestId("welcome-guide");
  await guide.getByRole("button", { name: /START HERE/ }).click();
  await guide.getByRole("button", { name: "Start lesson" }).click();
  await reachStep(page, "Put Nightfall Looks on control 1");
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
    .dragTo(page.locator('[data-clip-dropzone-index="1"]'));
  await expect(page.locator('[data-control-go-index="1"]')).toBeEnabled();
  await expect(
    guide.getByRole("heading", { name: "Start Nightfall Looks" }),
  ).toBeVisible();
  await page.locator('[data-control-go-index="1"]').click();
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
  await page.locator('[data-control-go-index="1"]').click();
  await expect(
    guide.getByRole("heading", { name: "Control the level" }),
  ).toBeVisible();
  const fader = page.locator('[data-control-index="1"] [role="slider"]');
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
test("lesson library remains optional and adapts to demo capabilities", async ({
  page,
}, testInfo) => {
  await openDemo(page);
  await page.getByRole("button", { name: "Explore on my own" }).click();
  await page.reload();
  await waitForDockviewApp(page);
  await expect(page.getByRole("button", { name: "Take the tour" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Open command palette" }).click();
  await page
    .getByPlaceholder("Type a command or search...")
    .fill("Open Welcome Guide");
  await page.keyboard.press("Enter");
  const guide = page.getByTestId("welcome-guide");
  await expect(guide).toBeVisible();
  await guide.getByRole("button", { name: /Transports and output/ }).click();
  await expect(guide).toContainText("Hardware output is unavailable here");
  await guide.getByRole("button", { name: "Start lesson" }).click();
  for (let index = 0; index < 3; index += 1)
    await guide.getByRole("button", { name: "Skip step" }).click();
  await guide.getByRole("button", { name: "Finish lesson" }).click();
  await expect(
    guide.getByRole("button", { name: /Transports and output/ }),
  ).toContainText("Completed");
  await guide.getByRole("button", { name: /Step FX designer/ }).click();
  await guide.getByRole("button", { name: "Start lesson" }).click();
  await guide.getByRole("button", { name: "Open FX List" }).click();
  await page.getByRole("button", { name: "Add effect", exact: true }).click();
  await page.getByRole("button", { name: "Step FX", exact: true }).click();
  await expect(page.getByRole("tab", { name: /Step FX/ })).toBeVisible();
  await guide.getByRole("button", { name: "All lessons" }).click();
  await guide.getByRole("button", { name: /Patching fixtures/ }).click();
  await expect(guide).toContainText(
    "Fixture-library import is unavailable here",
  );
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
  await page.reload();
  await waitForDockviewApp(page);
  await page
    .getByRole("button", { name: "Open Welcome Guide", exact: true })
    .click();
  await expect(
    guide.getByRole("button", { name: /Transports and output/ }),
  ).toContainText("Completed");
});
