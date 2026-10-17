// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.use({ sampleDataOnly: true });

/** Sample show clips in control slots 1 and 2; slot 3 holds the Rainbow Cycle clip. */
const RGB_FULL = 1;
const RGB_HALF = 2;

/** Reads every fixture element's displayed colour, keyed by fixture UID and element index. */
async function fixtureColours(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const rows = (window as any).appStores.parameters.get() as Map<
      string,
      {
        color: string;
        elements?: { elementIndex: number; color: string }[];
      }
    >;
    return Object.fromEntries(
      Array.from(rows.entries()).flatMap(([uid, row]) =>
        row.elements?.length
          ? row.elements.map((element) => [
              `${uid}/${element.elementIndex}`,
              element.color,
            ])
          : [[uid, row.color]],
      ),
    );
  });
}

/** Collects the fixture elements whose colour differs from `idle` across several samples. */
async function changedFixtures(
  page: Page,
  idle: Record<string, string>,
): Promise<Set<string>> {
  const changed = new Set<string>();
  for (let sample = 0; sample < 6; sample += 1) {
    const colours = await fixtureColours(page);
    for (const [uid, colour] of Object.entries(colours)) {
      if (idle[uid] !== colour) changed.add(uid);
    }
    await page.waitForTimeout(250);
  }
  return changed;
}

/** Starts or stops one sample clip through the clip command module. */
async function setClipRunning(
  page: Page,
  id: number,
  running: boolean,
): Promise<void> {
  await page.evaluate(
    ([id, running]) =>
      (window as any).appStores.sendAndAwait({
        module: "ClipCommand",
        command: {
          type: running ? "StartClip" : "StopClip",
          data: { type: "Single", data: id },
        },
      }),
    [id, running] as const,
  );
}

/** Opens a panel through the command palette. */
async function openPanel(page: Page, panelName: string): Promise<void> {
  await page.getByRole("button", { name: "Open command palette" }).click();
  const commandInput = page.getByPlaceholder("Type a command or search...");
  await commandInput.fill(`Open ${panelName}`);
  await page.keyboard.press("Enter");
}

/** Returns whether every listed element shows the colour it has in `look`. */
async function showsLook(
  page: Page,
  look: Record<string, string>,
  keys: string[],
): Promise<boolean> {
  const colours = await fixtureColours(page);
  return keys.every((key) => colours[key] === look[key]);
}

/**
 * Verifies a held Swop on the Rainbow slot takes the running RGB cycles out entirely: the RGB
 * cycles hold a steady colour on the rainbow's fixtures, which gives way to the moving rainbow
 * while the button is held and comes back once it is let go.
 */
test("Swop shows the swopped clip on its own", async ({ page }) => {
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () => ((window as any).appStores?.parameters?.get?.()?.size ?? 0) > 0,
  );
  await page.waitForTimeout(1000);
  const idle = await fixtureColours(page);

  await setClipRunning(page, RGB_FULL, true);
  await setClipRunning(page, RGB_HALF, true);
  const cycleKeys = [...(await changedFixtures(page, idle))];
  expect(cycleKeys.length).toBeGreaterThan(0);
  const cycleLook = await fixtureColours(page);
  expect(await showsLook(page, cycleLook, cycleKeys)).toBe(true);

  await openPanel(page, "Clips");
  const button = page.locator('[data-control-button-index="3"]');
  await page.getByRole("button", { name: "Button mode of control 3" }).click();
  await page.locator('[data-control-button-mode-option="Swop"]').click();
  await expect(button).toHaveText("Swop");
  await page.screenshot({
    path: test.info().outputPath("swop-before.png"),
  });

  const box = await button.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await expect(button).toHaveAttribute("data-control-button-flashing", "true");
  await page.waitForTimeout(500);
  let cycleLookSamples = 0;
  for (let sample = 0; sample < 6; sample += 1) {
    if (await showsLook(page, cycleLook, cycleKeys)) cycleLookSamples += 1;
    await page.waitForTimeout(250);
  }
  await page.screenshot({ path: test.info().outputPath("swop-held.png") });
  const level = await page
    .locator('[data-control-index="3"]')
    .locator(".vertical-range-slider .noUi-handle")
    .getAttribute("aria-valuenow");

  await page.mouse.up();
  await expect(button).toHaveAttribute("data-control-button-flashing", "false");
  await expect.poll(() => showsLook(page, cycleLook, cycleKeys)).toBe(true);
  await setClipRunning(page, RGB_FULL, false);
  await setClipRunning(page, RGB_HALF, false);

  expect(Number(level)).toBe(0);
  expect(cycleLookSamples).toBe(0);
});

/** Sends one control slot command straight to the engine, as a controller would. */
async function sendControlCommand(
  page: Page,
  command: Record<string, unknown>,
): Promise<void> {
  await page.evaluate(
    (command) =>
      (window as any).appStores.sendAndAwait({
        module: "ControlCommand",
        command,
      }),
    command,
  );
}

/** Runs a command palette action by its name. */
async function runPaletteAction(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Open command palette" }).click();
  await page.getByPlaceholder("Type a command or search...").fill(name);
  await page.keyboard.press("Enter");
}

/**
 * Verifies a Swop left held, as by a controller that never sent its release, is never silent:
 * the slots, Status Display and Layers tag the swop clip and every playback it takes out, and
 * the "Release held buttons" palette action lets go of it.
 */
test("a stuck Swop is shown and can be released", async ({ page }) => {
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () => ((window as any).appStores?.parameters?.get?.()?.size ?? 0) > 0,
  );
  await setClipRunning(page, RGB_FULL, true);
  await setClipRunning(page, RGB_HALF, true);

  await openPanel(page, "Clips");
  await page.getByRole("button", { name: "Button mode of control 3" }).click();
  await page.locator('[data-control-button-mode-option="Swop"]').click();
  await expect(page.locator('[data-control-button-index="3"]')).toHaveText(
    "Swop",
  );

  await sendControlCommand(page, {
    type: "PressButton",
    data: { control_index: 3 },
  });
  for (const index of [1, 2]) {
    const slot = page.locator(`[data-control-index="${index}"]`);
    await expect(slot).toHaveAttribute(
      "data-control-held-button",
      "SwoppedOut",
    );
    await expect(slot.getByTestId("held-button-badge")).toHaveText("Swopped");
  }
  const swopSlot = page.locator('[data-control-index="3"]');
  await expect(swopSlot).toHaveAttribute(
    "data-control-held-button",
    "Swopping",
  );
  await expect(swopSlot.getByTestId("held-button-badge")).toHaveText("Swop");
  await page.screenshot({
    path: test.info().outputPath("swop-stuck-slots.png"),
  });

  await openPanel(page, "Status Display");
  const instancesTable = page.getByRole("table", { name: "Active instances" });
  const statusBadges = instancesTable.locator(
    '[data-held-button="SwoppedOut"]',
  );
  await expect(statusBadges).toHaveCount(2);
  await expect(statusBadges.first()).toHaveText("Swopped");
  await expect(statusBadges.first()).toHaveAttribute(
    "title",
    "Taken out by the Swop held on slot 3",
  );
  await expect(
    instancesTable.locator('[data-held-button="Swopping"]'),
  ).toHaveText("Swop");
  await expect(
    instancesTable.getByText("Running", { exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("swop-stuck-status.png"),
  });

  await openPanel(page, "Layers");
  const layerBadge = page
    .locator('summary [data-held-button="SwoppedOut"]')
    .first();
  await expect(layerBadge).toBeVisible();
  await layerBadge.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath("swop-stuck-layers.png"),
  });

  await runPaletteAction(page, "Release held buttons");
  await expect(page.locator("[data-held-button]")).toHaveCount(0);
  await expect(page.locator("[data-control-held-button]")).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("swop-released.png"),
  });

  await setClipRunning(page, RGB_FULL, false);
  await setClipRunning(page, RGB_HALF, false);
});
