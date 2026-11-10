// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Locator, type Page, test } from "./playwright-fixtures";

interface Point {
  x: number;
  y: number;
}

/**
 * Finds a point inside Dockview's splitter chrome for overlay stacking checks.
 */
async function dockviewSashPoint(page: Page): Promise<Point> {
  return page
    .locator(".dv-sash")
    .first()
    .evaluate((sash) => {
      const rect = sash.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    });
}

/**
 * Verifies the topmost element at a Dockview sash point belongs to the overlay.
 */
async function expectTopElementInside(
  page: Page,
  point: Point,
  selector: string,
): Promise<void> {
  const topElement = await page.evaluate(
    ({ point, selector }) => {
      const element = document.elementFromPoint(point.x, point.y);
      return {
        className:
          typeof element?.className === "string" ? element.className : "",
        isInsideOverlay: Boolean(element?.closest(selector)),
        isInsideSash: Boolean(element?.closest(".dv-sash")),
      };
    },
    { point, selector },
  );

  expect(topElement.isInsideOverlay, topElement.className).toBe(true);
  expect(topElement.isInsideSash, topElement.className).toBe(false);
}

/**
 * Verifies a modal has the shared surface shadow applied to its dialog panel.
 */
async function expectModalSurfaceShadow(dialog: Locator): Promise<void> {
  const surface = dialog.locator(".nightfall-modal-surface").first();
  await expect(surface).toBeVisible();

  const styles = await surface.evaluate((element) => {
    const computed = window.getComputedStyle(element);
    return {
      boxShadow: computed.boxShadow,
      filter: computed.filter,
    };
  });

  expect(styles.boxShadow).not.toBe("none");
  expect(styles.filter).not.toBe("none");
}

/**
 * Opens the command palette through the registered app helper.
 */
async function openCommandPalette(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).nightfallShowPalette();
  });
}

/**
 * Opens a command palette command by name.
 */
async function openCommandPaletteCommand(
  page: Page,
  commandName: string,
): Promise<void> {
  await openCommandPalette(page);

  const commandInput = page.getByPlaceholder("Type a command or search...");
  await expect(commandInput).toBeVisible();
  await commandInput.fill(commandName);
  await page.keyboard.press("Enter");
}

test("modal and popup overlays render above dockview sashes", async ({
  page,
}) => {
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();

  await expect
    .poll(async () =>
      page.evaluate(() => Boolean((window as any).appStores?.dockApi?.get?.())),
    )
    .toBe(true);

  const sashPoint = await dockviewSashPoint(page);

  await openCommandPalette(page);
  await expect(
    page.locator('[data-dialog-kind="command-palette"]'),
  ).toBeVisible();
  await expectTopElementInside(
    page,
    sashPoint,
    '[data-dialog-kind="command-palette"]',
  );
  await page.keyboard.press("Escape");

  await openCommandPaletteCommand(page, "Open Settings");
  const settingsDialog = page.getByRole("dialog", { name: "Settings" });
  await expect(settingsDialog).toBeVisible();
  await expectModalSurfaceShadow(settingsDialog);
  await expectTopElementInside(
    page,
    sashPoint,
    '[role="dialog"][aria-label="Settings"]',
  );
  await page.keyboard.press("Escape");
  await expect(settingsDialog).not.toBeVisible();

  await openCommandPaletteCommand(page, "Show Keyboard Shortcuts");
  await expect(page.locator('[data-dialog-kind="shortcuts"]')).toBeVisible();
  await expectTopElementInside(
    page,
    sashPoint,
    '[data-dialog-kind="shortcuts"]',
  );
  await page.keyboard.press("Escape");

  await openCommandPaletteCommand(page, "Manage Layouts");
  const layoutsDialog = page.getByRole("dialog", { name: "Manage layouts" });
  await expect(layoutsDialog).toBeVisible();
  await expectModalSurfaceShadow(layoutsDialog);
  await expectTopElementInside(
    page,
    sashPoint,
    '[role="dialog"][aria-label="Manage layouts"]',
  );
});

/**
 * Reports whether the topmost element at a toast's center belongs to that
 * toast, which fails while a modal dialog's top layer covers it.
 */
async function toastIsOnTop(toast: Locator): Promise<boolean> {
  return toast.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const top = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return top !== null && element.contains(top);
  });
}

/**
 * Checks that toasts stay visible and clickable above modal dialogs: one
 * raised before Settings opens moves on top of it, one raised while Settings
 * is open appears on top of it, and both return to the page when it closes.
 */
test("toasts render above open modal dialogs", async ({ page }, testInfo) => {
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as any).appStores?.dockApi?.get?.()),
  );

  await page.evaluate(() => {
    (window as any).appStores.pushToast("info", "Raised before Settings", 0);
  });
  const earlier = page
    .locator('[data-component="Toast"]')
    .filter({ hasText: "Raised before Settings" });
  await expect(earlier).toBeVisible();

  await openCommandPaletteCommand(page, "Open Settings");
  const settingsDialog = page.getByRole("dialog", { name: "Settings" });
  await expect(settingsDialog).toBeVisible();

  await page.evaluate(() => {
    (window as any).appStores.pushToast("warning", "Raised over Settings", 0);
  });
  const later = page
    .locator('[data-component="Toast"]')
    .filter({ hasText: "Raised over Settings" });
  await expect(later).toBeVisible();

  await expect.poll(() => toastIsOnTop(earlier)).toBe(true);
  await expect.poll(() => toastIsOnTop(later)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("toasts-over-settings.png"),
  });

  // Clicking requires the close button to be the hit target, so it proves the toast is not inert.
  await later.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(later).toHaveCount(0);
  await expect(settingsDialog).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(settingsDialog).not.toBeVisible();
  await expect(earlier).toBeVisible();
  await expect.poll(() => toastIsOnTop(earlier)).toBe(true);
  await earlier.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(earlier).toHaveCount(0);
});
