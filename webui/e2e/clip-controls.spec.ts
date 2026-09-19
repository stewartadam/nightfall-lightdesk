// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Page } from "./playwright-fixtures";
import { expect, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

const CONTROLS_HEIGHT_STORAGE_KEY = "nightfall-clip-panel:controls-height";
const CONTROLS_COLLAPSED_STORAGE_KEY =
  "nightfall-clip-panel:controls-collapsed";

/** Opens the clip panel through the command palette for controls tests. */
async function openClipPanel(page: Page) {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/?e2e=1");

  await expect(page.locator("main#app")).toBeVisible();
  await prepareStoreSeededTestApp(page);

  await page.getByRole("button", { name: "Open command palette" }).click();

  const commandInput = page.getByPlaceholder("Type a command or search...");
  await expect(commandInput).toBeVisible();
  await commandInput.fill("Open Clips");
  await page.keyboard.press("Enter");
}

/** Seeds control 3 with a known clip assignment for deterministic control UI checks. */
async function seedAssignedControl(page: Page, value = 0) {
  await page.evaluate((value) => {
    const stores = (window as any).appStores;
    const clipUid = "82828282828282828282828282828282";
    stores.clips.set({
      [clipUid]: [
        {
          identifiers: { id: 2, uid: clipUid, label: "128/0/0" },
          priority: 0,
          options: {
            auto_release: false,
            deactivate_on_sequence_end: false,
          },
        },
        false,
      ],
    });
    stores.controls.set([
      {
        index: 3,
        assigned_clip_id: 2,
        hardware_value: 0,
        console_value: value,
        display_value: value,
        is_grabbed: false,
        is_clip_active: false,
      },
    ]);
  }, value);
}

/** Verifies assigned controls keep an operable scenario-owned handle. */
test("assigned clip controls keep an enabled, visible handle", async ({
  page,
}) => {
  await openClipPanel(page);
  await seedAssignedControl(page);

  const assignedControl = page.locator('[data-control-index="3"]');
  await expect(assignedControl).toBeVisible();
  await expect(assignedControl.getByText("128/0/0")).toBeVisible();

  const sliderTarget = assignedControl.locator(".vertical-range-slider");
  await expect(sliderTarget).not.toHaveClass(/is-disabled/);
  await expect(sliderTarget).not.toHaveAttribute("disabled", "");

  const sliderHandle = assignedControl.locator(
    ".vertical-range-slider .noUi-handle",
  );
  await expect(sliderHandle).toBeVisible();

  await expect
    .poll(async () =>
      sliderHandle.evaluate((el) => getComputedStyle(el).bottom),
    )
    .toBe("-8px");

  await expect
    .poll(async () =>
      sliderHandle.evaluate((el) => {
        const computed = getComputedStyle(el);
        const color = document.createElement("span").style;
        color.color = computed.getPropertyValue("--accent").trim();
        return computed.borderColor === color.color;
      }),
    )
    .toBe(true);
  await assignedControl.screenshot({
    path: test.info().outputPath("shared-clip-control.png"),
  });
});

/** Verifies the clip controls can be resized and collapsed by an operator. */
test("clip controls section resizes and collapses", async ({ page }) => {
  await openClipPanel(page);
  await seedAssignedControl(page);

  const controlsSection = page.locator("[data-clip-controls-section]");
  const resizeHandle = page.locator("[data-clip-controls-resize-handle]");
  const toggleButton = page.locator("[data-clip-controls-toggle]");
  const assignedControl = page.locator('[data-control-index="3"]');

  await expect(controlsSection).toBeVisible();
  await expect(assignedControl).toBeVisible();

  const sectionBeforeResize = await controlsSection.boundingBox();
  const handleBox = await resizeHandle.boundingBox();
  expect(sectionBeforeResize).toBeTruthy();
  expect(handleBox).toBeTruthy();
  expect(sectionBeforeResize?.height ?? 0).toBeGreaterThan(250);

  await page.mouse.move(
    (handleBox?.x ?? 0) + (handleBox?.width ?? 0) / 2,
    (handleBox?.y ?? 0) + (handleBox?.height ?? 0) / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    (handleBox?.x ?? 0) + (handleBox?.width ?? 0) / 2,
    (handleBox?.y ?? 0) - 70,
  );
  await page.mouse.up();

  await expect
    .poll(async () => (await controlsSection.boundingBox())?.height ?? 0)
    .toBeGreaterThan((sectionBeforeResize?.height ?? 0) + 40);
  await expect
    .poll(() =>
      page.evaluate((storageKey) => {
        const stored = window.localStorage.getItem(storageKey);
        return stored ? Number(stored) : 0;
      }, CONTROLS_HEIGHT_STORAGE_KEY),
    )
    .toBeGreaterThan(sectionBeforeResize?.height ?? 0);

  await toggleButton.click();
  await expect(toggleButton).toHaveAttribute("aria-expanded", "false");
  await expect(assignedControl).toBeHidden();
  await expect
    .poll(async () => (await controlsSection.boundingBox())?.height ?? 0)
    .toBeLessThan(60);
  await expect
    .poll(() =>
      page.evaluate(
        (storageKey) => window.localStorage.getItem(storageKey),
        CONTROLS_COLLAPSED_STORAGE_KEY,
      ),
    )
    .toBe("true");

  await toggleButton.click();
  await expect(toggleButton).toHaveAttribute("aria-expanded", "true");
  await expect(assignedControl).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        (storageKey) => window.localStorage.getItem(storageKey),
        CONTROLS_COLLAPSED_STORAGE_KEY,
      ),
    )
    .toBe("false");
});

/** Prevents mounting, remounting and backend value refreshes from sending rounded console edits. */
test("fractional control values remain passive until the operator edits", async ({
  page,
}, testInfo) => {
  await openClipPanel(page);
  const toggle = page.locator("[data-clip-controls-toggle]");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.evaluate(async () => {
    const { engineRuntime } = await import("/lib/engine-runtime.ts");
    (window as any).__faderConsoleUpdates = [];
    const original = engineRuntime.sendUpdate.bind(engineRuntime);
    /** Captures edits at the transport boundary while store-seeded tests keep the worker stopped. */
    engineRuntime.sendUpdate = (
      module: string,
      update: object,
      shouldLog?: boolean,
    ) => {
      if (module === "ControlUpdate") {
        (window as any).__faderConsoleUpdates.push(update);
        return true;
      }
      return original(module, update, shouldLog);
    };
  });
  await seedAssignedControl(page, 42.4);
  await toggle.click();
  const control = page.locator('[data-control-index="3"]');
  const handle = control.getByRole("slider");
  await expect(handle).toHaveAttribute("aria-valuenow", "42.0");
  expect(
    await page.evaluate(() => (window as any).__faderConsoleUpdates),
  ).toEqual([]);

  await seedAssignedControl(page, 37.6);
  await expect(handle).toHaveAttribute("aria-valuenow", "38.0");
  await toggle.click();
  await expect(handle).toHaveCount(0);
  await toggle.click();
  await expect(handle).toHaveAttribute("aria-valuenow", "38.0");
  expect(
    await page.evaluate(() => (window as any).__faderConsoleUpdates),
  ).toEqual([]);

  await handle.press("ArrowUp");
  await expect
    .poll(() => page.evaluate(() => (window as any).__faderConsoleUpdates))
    .toEqual([
      { type: "SetConsoleValue", data: { control_index: 3, value: 39 } },
    ]);
  await control.screenshot({
    path: testInfo.outputPath("fractional-control-keyboard.png"),
  });
});

/** Keeps faders and actions inside both resize limits and honors motion preferences. */
test("clip controls fill bounded heights and animate only toggles", async ({
  page,
}) => {
  await openClipPanel(page);
  await seedAssignedControl(page);
  const section = page.locator("[data-clip-controls-section]");
  const resize = page.locator("[data-clip-controls-resize-handle]");
  const toggle = page.locator("[data-clip-controls-toggle]");
  const control = page.locator('[data-control-index="3"]');
  const track = control.locator(".vertical-range-slider");
  await resize.focus();
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowDown");
  expect((await section.boundingBox())?.height).toBe(300);
  const shortTrack = (await track.boundingBox())!;
  expect(shortTrack.height).toBeGreaterThan(50);
  const smallSection = (await section.boundingBox())!;
  const smallControl = (await control.boundingBox())!;
  expect(smallControl.y + smallControl.height).toBeLessThanOrEqual(
    smallSection.y + smallSection.height,
  );
  await expect(
    control.getByRole("button", { name: "Go control 3" }),
  ).toBeInViewport();
  await section.screenshot({
    path: test.info().outputPath("controls-minimum.png"),
  });

  for (let i = 0; i < 50; i++) await page.keyboard.press("ArrowUp");
  const tallSection = (await section.boundingBox())!;
  const tallTrack = (await track.boundingBox())!;
  expect(tallTrack.height - shortTrack.height).toBeCloseTo(
    tallSection.height - smallSection.height,
    0,
  );
  expect(
    await section.evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe("0s");
  await section.screenshot({
    path: test.info().outputPath("controls-maximum.png"),
  });

  await toggle.click();
  await expect
    .poll(() => section.evaluate((el) => el.getAnimations().length))
    .toBeGreaterThan(0);
  await expect(control).toHaveCount(0);
  await expect.poll(async () => (await section.boundingBox())?.height).toBe(46);
  await toggle.click();
  await expect
    .poll(() => section.evaluate((el) => el.getAnimations().length))
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await section.boundingBox())?.height)
    .toBe(tallSection.height);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await toggle.click();
  await expect(control).toHaveCount(0);
  expect(await section.evaluate((el) => el.getAnimations().length)).toBe(0);
  await toggle.click();
  await expect(control).toBeVisible();
  expect((await section.boundingBox())?.height).toBe(tallSection.height);
});
