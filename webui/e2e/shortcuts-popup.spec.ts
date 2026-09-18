// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, test } from "./playwright-fixtures";

/** Verifies natural shortcut ordering, scroll hints, and Escape dismissal. */
test("opens and closes the shortcuts popup from the command palette", async ({
  page,
}, testInfo) => {
  await page.goto("/?e2e=1");

  await expect(page.locator("button[title='Menu']")).toBeVisible();

  await page.keyboard.press("Meta+Shift+P");

  const commandPaletteInput = page.getByPlaceholder(
    "Type a command or search...",
  );
  await expect(commandPaletteInput).toBeVisible();
  await commandPaletteInput.fill("Show Keyboard Shortcuts");
  await commandPaletteInput.press("Enter");

  const shortcutsHeading = page.getByRole("heading", {
    name: "Keyboard Shortcuts",
  });
  await expect(shortcutsHeading).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("shortcuts-key-sequences.png"),
  });
  await page.setViewportSize({ width: 600, height: 800 });
  await page.screenshot({
    path: testInfo.outputPath("shortcuts-narrow.png"),
  });
  await page.setViewportSize({ width: 1000, height: 420 });
  const scrollArea = page.locator(
    '[data-dialog-kind="shortcuts"] .nf-scroll-area',
  );
  await expect(scrollArea.locator('[data-edge="bottom"]')).toHaveAttribute(
    "data-visible",
    "true",
  );
  await scrollArea.locator(".nf-scroll-viewport").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(scrollArea.locator('[data-edge="top"]')).toHaveAttribute(
    "data-visible",
    "true",
  );
  await expect(scrollArea.locator('[data-edge="bottom"]')).toHaveAttribute(
    "data-visible",
    "false",
  );
  await page.screenshot({
    path: testInfo.outputPath("shortcuts-scrolled.png"),
  });
  await expect(page.getByText(/^Switch to layout \d+$/)).toHaveText(
    Array.from({ length: 10 }, (_, index) => `Switch to layout ${index + 1}`),
  );
  await page
    .getByText("Switch to layout 10", { exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("shortcut-natural-order.png"),
  });

  await page.keyboard.press("Escape");
  await expect(shortcutsHeading).not.toBeVisible();
});

/** Verifies command palette shortcuts still work while text inputs are focused. */
test("command palette opens from focused text input", async ({ page }) => {
  await page.goto("/?e2e=1");

  await expect(page.locator("button[title='Menu']")).toBeVisible();
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.setAttribute("aria-label", "Shortcut target");
    document.body.append(input);
    input.focus();
  });

  const modKey = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modKey}+Shift+P`);

  await expect(
    page.getByPlaceholder("Type a command or search..."),
  ).toBeVisible();
});

/** Verifies printable shell shortcuts keep normal text input behavior. */
test("command palette input receives question mark instead of shell help", async ({
  page,
}) => {
  await page.goto("/?e2e=1");

  await expect(page.locator("button[title='Menu']")).toBeVisible();

  await page.keyboard.press("Meta+Shift+P");

  const commandPaletteInput = page.getByPlaceholder(
    "Type a command or search...",
  );
  await expect(commandPaletteInput).toBeVisible();
  await commandPaletteInput.focus();

  await page.keyboard.press("Shift+Slash");

  await expect(commandPaletteInput).toHaveValue("?");
  await expect(
    page.getByRole("heading", { name: "Keyboard Shortcuts" }),
  ).not.toBeVisible();
});
