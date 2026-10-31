// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Page } from "./playwright-fixtures";
import { expect, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

const FADERS_HEIGHT_STORAGE_KEY = "nightfall-clip-panel:faders-height";
const FADERS_COLLAPSED_STORAGE_KEY = "nightfall-clip-panel:faders-collapsed";

/** Opens the clip panel through the command palette for faders tests. */
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

/** Returns the disclosure toggle in the faders section header. */
function controlsToggle(page: Page) {
  return page
    .locator("[data-clip-faders-section]")
    .getByRole("button", { name: "Faders", exact: true });
}

/** Seeds fader 3 with a known clip assignment for deterministic fader UI checks. */
async function seedAssignedFader(page: Page, value = 0) {
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
    stores.faders.set([
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

/** Verifies assigned faders keep an operable scenario-owned handle. */
test("assigned clip faders keep an enabled, visible handle", async ({
  page,
}) => {
  await openClipPanel(page);
  await seedAssignedFader(page);

  const assignedFader = page.locator('[data-fader-index="3"]');
  await expect(assignedFader).toBeVisible();
  await expect(assignedFader.getByText("128/0/0")).toBeVisible();

  const sliderTarget = assignedFader.locator(".vertical-range-slider");
  await expect(sliderTarget).not.toHaveClass(/is-disabled/);
  await expect(sliderTarget).not.toHaveAttribute("disabled", "");

  const sliderHandle = assignedFader.locator(
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
        const track = el
          .closest(".vertical-range-slider")!
          .querySelector(".noUi-connect")!;
        return (
          getComputedStyle(el).borderColor ===
          getComputedStyle(track).backgroundColor
        );
      }),
    )
    .toBe(true);
  await assignedFader.screenshot({
    path: test.info().outputPath("shared-clip-fader.png"),
  });
});

/** Verifies the clip faders can be resized and collapsed by an operator. */
test("clip faders section resizes and collapses", async ({ page }) => {
  await openClipPanel(page);
  await seedAssignedFader(page);

  const fadersSection = page.locator("[data-clip-faders-section]");
  const resizeHandle = page.locator("[data-clip-faders-resize-handle]");
  const toggleButton = controlsToggle(page);
  const assignedFader = page.locator('[data-fader-index="3"]');

  await expect(fadersSection).toBeVisible();
  await expect(assignedFader).toBeVisible();

  const sectionBeforeResize = await fadersSection.boundingBox();
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
    .poll(async () => (await fadersSection.boundingBox())?.height ?? 0)
    .toBeGreaterThan((sectionBeforeResize?.height ?? 0) + 40);
  await expect
    .poll(() =>
      page.evaluate((storageKey) => {
        const stored = window.localStorage.getItem(storageKey);
        return stored ? Number(stored) : 0;
      }, FADERS_HEIGHT_STORAGE_KEY),
    )
    .toBeGreaterThan(sectionBeforeResize?.height ?? 0);

  await toggleButton.click();
  await expect(toggleButton).toHaveAttribute("aria-expanded", "false");
  await expect(assignedFader).toBeHidden();
  await expect
    .poll(async () => (await fadersSection.boundingBox())?.height ?? 0)
    .toBeLessThan(60);
  await expect
    .poll(() =>
      page.evaluate(
        (storageKey) => window.localStorage.getItem(storageKey),
        FADERS_COLLAPSED_STORAGE_KEY,
      ),
    )
    .toBe("true");

  await toggleButton.click();
  await expect(toggleButton).toHaveAttribute("aria-expanded", "true");
  await expect(assignedFader).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        (storageKey) => window.localStorage.getItem(storageKey),
        FADERS_COLLAPSED_STORAGE_KEY,
      ),
    )
    .toBe("false");
});

/** Prevents mounting, remounting and backend value refreshes from sending rounded console edits. */
test("fractional fader values remain passive until the operator edits", async ({
  page,
}, testInfo) => {
  await openClipPanel(page);
  const toggle = controlsToggle(page);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.evaluate(async () => {
    const { engineRuntime } = window.__nightfallTest.runtime;
    (window as any).__faderConsoleUpdates = [];
    const original = engineRuntime.sendUpdate.bind(engineRuntime);
    /** Captures edits at the transport boundary while store-seeded tests keep the worker stopped. */
    engineRuntime.sendUpdate = (
      module: string,
      update: object,
      shouldLog?: boolean,
    ) => {
      if (module === "FaderUpdate") {
        (window as any).__faderConsoleUpdates.push(update);
        return true;
      }
      return original(module, update, shouldLog);
    };
  });
  await seedAssignedFader(page, 42.4);
  await toggle.click();
  const fader = page.locator('[data-fader-index="3"]');
  const handle = fader.getByRole("slider");
  await expect(handle).toHaveAttribute("aria-valuenow", "42.0");
  expect(
    await page.evaluate(() => (window as any).__faderConsoleUpdates),
  ).toEqual([]);

  await seedAssignedFader(page, 37.6);
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
      { type: "SetConsoleValue", data: { fader_index: 3, value: 39 } },
    ]);
  await fader.screenshot({
    path: testInfo.outputPath("fractional-fader-keyboard.png"),
  });
});

/** Keeps faders and actions inside both resize limits and honors motion preferences. */
test("clip faders fill bounded heights and animate only toggles", async ({
  page,
}) => {
  await openClipPanel(page);
  await seedAssignedFader(page);
  const section = page.locator("[data-clip-faders-section]");
  const resize = page.locator("[data-clip-faders-resize-handle]");
  const toggle = controlsToggle(page);
  const fader = page.locator('[data-fader-index="3"]');
  const track = fader.locator(".vertical-range-slider");
  await resize.focus();
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowDown");
  expect((await section.boundingBox())?.height).toBe(300);
  const shortTrack = (await track.boundingBox())!;
  expect(shortTrack.height).toBeGreaterThan(50);
  const smallSection = (await section.boundingBox())!;
  const smallFader = (await fader.boundingBox())!;
  expect(smallFader.y + smallFader.height).toBeLessThanOrEqual(
    smallSection.y + smallSection.height,
  );
  await expect(
    fader.getByRole("button", { name: "Go fader 3" }),
  ).toBeInViewport();
  await section.screenshot({
    path: test.info().outputPath("faders-minimum.png"),
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
    path: test.info().outputPath("faders-maximum.png"),
  });

  await toggle.click();
  await expect
    .poll(() => section.evaluate((el) => el.getAnimations().length))
    .toBeGreaterThan(0);
  await expect(fader).toHaveCount(0);
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
  await expect(fader).toHaveCount(0);
  expect(await section.evaluate((el) => el.getAnimations().length)).toBe(0);
  await toggle.click();
  await expect(fader).toBeVisible();
  expect((await section.boundingBox())?.height).toBe(tallSection.height);
});
