// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { resetToDefaultLayout, waitForDockviewApp } from "./showfile-startup";

/**
 * Walks the command palette, keyboard shortcuts overlay and Keyboard settings, checking that
 * each shows its shortcuts as shared key caps with the platform modifier resolved.
 */
test("shortcut hints render as shared key caps", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await resetToDefaultLayout(page);

  await page.keyboard.press("ControlOrMeta+Shift+P");
  const palette = page.locator('[data-dialog-kind="command-palette"]');
  const search = palette.getByPlaceholder("Type a command or search...");
  await expect(search).toBeFocused();
  const hint = palette.locator("[data-command-shortcut-hint]");
  await expect(hint.locator("kbd[data-kbd-key]")).toHaveText([
    "Ctrl",
    "Shift",
    "P",
  ]);
  await search.fill("settings");
  const settingsShortcut = palette.locator('kbd[data-kbd-shortcut="$mod+,"]');
  await expect(settingsShortcut.locator("kbd[data-kbd-key]")).toHaveText([
    "Ctrl",
    ",",
  ]);
  await page.screenshot({
    path: testInfo.outputPath("01-command-palette.png"),
  });

  await search.fill("Show Keyboard Shortcuts");
  await search.press("Enter");
  const overlay = page.locator('[data-dialog-kind="shortcuts"]');
  await expect(
    overlay.getByRole("heading", { name: "Keyboard Shortcuts" }),
  ).toBeVisible();
  await expect(
    overlay.locator('kbd[data-kbd-shortcut="$mod+Shift+p"] kbd[data-kbd-key]'),
  ).toHaveText(["Ctrl", "Shift", "P"]);
  await expect(
    overlay.locator('kbd[data-kbd-key="Escape"]').first(),
  ).toHaveText("Esc");
  await page.screenshot({
    path: testInfo.outputPath("02-shortcuts-overlay.png"),
  });
  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await search.fill("Open Settings");
  await search.press("Enter");
  await page.getByRole("tab", { name: "Keyboard" }).click();
  const settings = page.locator("[data-keybindings-settings]");
  await expect(settings).toBeVisible();
  await settings.getByText("Disable a built-in shortcut").click();
  const builtIn = settings.locator('[data-builtin-shortcut="$mod+Shift+p"]');
  await expect(builtIn.locator("kbd[data-kbd-key]")).toHaveText([
    "Ctrl",
    "Shift",
    "P",
  ]);
  await builtIn.getByRole("button", { name: /^Disable / }).click();
  const disabled = settings.locator('[data-disabled-shortcut="$mod+Shift+p"]');
  await expect(disabled.locator("kbd[data-kbd-key]")).toHaveText([
    "Ctrl",
    "Shift",
    "P",
  ]);
  await settings.getByRole("button", { name: "Record keys" }).click();
  await page.keyboard.press("Alt+Shift+KeyM");
  await settings
    .getByRole("combobox", { name: "Keybinding action" })
    .selectOption("ui.panel-MidiInput");
  await settings.getByRole("button", { name: "Add", exact: true }).click();
  const binding = settings.locator('[data-keybinding="Alt+Shift+KeyM"]');
  await expect(binding.locator("kbd[data-kbd-key]")).toHaveText([
    "Alt",
    "Shift",
    "M",
  ]);

  await settings.getByRole("button", { name: "Record keys" }).click();
  await page.keyboard.press("Alt+Shift+KeyM");
  const recordButton = settings.getByRole("button", {
    name: "Record keys, recorded Alt + Shift + M",
  });
  await expect(recordButton.locator("kbd[data-kbd-key]")).toHaveText([
    "Alt",
    "Shift",
    "M",
  ]);
  const conflict = settings.locator("[data-keybinding-conflicts]");
  await expect(conflict).toContainText("is already used");
  await expect(conflict.locator("kbd[data-kbd-key]")).toHaveText([
    "Alt",
    "Shift",
    "M",
  ]);
  await page.screenshot({
    path: testInfo.outputPath("03-keyboard-settings.png"),
  });

  await disabled.getByRole("button", { name: /^Re-enable / }).click();
  await binding
    .getByRole("button", { name: "Remove keybinding Alt + Shift + M" })
    .click();
  await expect(binding).toHaveCount(0);
});

/** Shows the design lab's key cap variants, including the Apple glyphs for modifier keys. */
test("design lab shows key cap variants", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
  });
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Shortcuts/ })
    .click();
  const variants = page.getByRole("definition").filter({
    has: page.locator('kbd[data-kbd-shortcut="$mod+Alt+Shift+KeyS"]'),
  });
  await expect(variants.locator("kbd[data-kbd-key] svg")).toHaveCount(3);
  await expect(variants.locator("kbd[data-kbd-key]")).toHaveText([
    "Command",
    "Option",
    "Shift",
    "S",
  ]);
  await expect(
    page.locator('kbd[data-kbd-shortcut="Shift++"] kbd[data-kbd-key]'),
  ).toHaveText(["Shift", "+"]);
  await page
    .getByRole("region", { name: "Shortcut examples" })
    .getByText("Key caps", { exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("04-design-lab-key-caps.png"),
  });
});
