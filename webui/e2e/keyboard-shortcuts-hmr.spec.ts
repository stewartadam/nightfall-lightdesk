// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, test } from "./playwright-fixtures";

/** Verifies shortcut startup can be repeated after a hot reload remount. */
test("keyboard shortcuts restart without duplicate global undo handlers", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await page.goto("/?e2e=keyboard-shortcuts-hmr");

  await page.evaluate(async () => {
    const shortcuts = await import("/lib/keyboardShortcuts.ts");
    const firstCleanup = shortcuts.initKeyboardShortcuts();
    const secondCleanup = shortcuts.initKeyboardShortcuts();

    secondCleanup();
    firstCleanup();
  });

  expect(pageErrors).toEqual([]);
});

/** Verifies stale cleanup handles do not remove the active shortcut root. */
test("stale shortcut cleanup keeps current global undo handlers", async ({
  page,
}) => {
  await page.goto("/?e2e=keyboard-shortcuts-hmr-stale-cleanup");

  const counts = await page.evaluate(async () => {
    const shortcuts = await import("/lib/keyboardShortcuts.ts");
    const firstCleanup = shortcuts.initKeyboardShortcuts();
    const secondCleanup = shortcuts.initKeyboardShortcuts();

    firstCleanup();
    const afterStaleCleanup = shortcuts
      .allShortcuts()
      .filter(
        (shortcut) =>
          shortcut.description === "Undo" || shortcut.description === "Redo",
      ).length;

    secondCleanup();
    const afterCurrentCleanup = shortcuts
      .allShortcuts()
      .filter(
        (shortcut) =>
          shortcut.description === "Undo" || shortcut.description === "Redo",
      ).length;

    return { afterCurrentCleanup, afterStaleCleanup };
  });

  expect(counts).toEqual({
    afterCurrentCleanup: 0,
    afterStaleCleanup: 2,
  });
});
