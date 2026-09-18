// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Locator, type Page, test } from "./playwright-fixtures";

const PROBE_INPUT_LABEL = "Editable shortcut probe";
const GRID_SEQUENCE_CELL_LABEL = "Grid shortcut sequence probe";

type ShortcutSequenceProbeWindow = Window & {
  __keyboardShortcutSequenceHits?: number;
  __keyboardShortcutSequenceUnregister?: () => void;
};

/** Adds a plain input to the app so browser-native editing behavior is isolated. */
async function addProbeInput(page: Page): Promise<Locator> {
  await page.evaluate((label) => {
    const existing = document.querySelector<HTMLInputElement>(
      `[aria-label="${label}"]`,
    );
    if (existing) {
      existing.remove();
    }

    const input = document.createElement("input");
    input.setAttribute("aria-label", label);
    input.style.position = "fixed";
    input.style.left = "16px";
    input.style.top = "64px";
    input.style.zIndex = "10000";
    document.body.append(input);
  }, PROBE_INPUT_LABEL);

  const input = page.getByRole("textbox", { name: PROBE_INPUT_LABEL });
  await expect(input).toBeVisible();
  return input;
}

/** Seeds the input, replaces its content through real typing, and leaves it focused. */
async function replaceProbeInputValue(input: Locator): Promise<void> {
  await input.evaluate((element) => {
    const textInput = element as HTMLInputElement;
    textInput.value = "alpha";
    textInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await input.focus();
  await input.press("ControlOrMeta+A");
  await input.pressSequentially("beta");
  await expect(input).toHaveValue("beta");
}

/** Initializes the real global shortcut root for the isolated browser probe. */
async function initializeGlobalShortcuts(page: Page): Promise<void> {
  const hasUndoShortcut = await page.evaluate(async () => {
    const shortcuts = await import("/lib/keyboardShortcuts.ts");
    shortcuts.initKeyboardShortcuts();
    return shortcuts
      .allShortcuts()
      .some((shortcut) => shortcut.description === "Undo");
  });

  expect(hasUndoShortcut).toBe(true);
}

/** Adds a focused TanStack data-grid cell surrogate that consumes keydown events. */
async function addFocusedGridSequenceCell(page: Page): Promise<Locator> {
  await page.evaluate((label) => {
    const existing = document.querySelector<HTMLElement>(
      `[aria-label="${label}"]`,
    );
    if (existing) {
      existing.closest('[data-grid-kind="tanstack"]')?.remove();
    }

    const grid = document.createElement("div");
    grid.dataset.gridKind = "tanstack";
    grid.style.position = "fixed";
    grid.style.left = "16px";
    grid.style.top = "112px";
    grid.style.zIndex = "10000";

    const cell = document.createElement("div");
    cell.setAttribute("aria-label", label);
    cell.setAttribute("role", "gridcell");
    cell.tabIndex = 0;
    cell.textContent = "Selected grid cell";
    cell.addEventListener("keydown", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    });

    grid.append(cell);
    document.body.append(grid);
    cell.focus();
  }, GRID_SEQUENCE_CELL_LABEL);

  const cell = page.getByRole("gridcell", { name: GRID_SEQUENCE_CELL_LABEL });
  await expect(cell).toBeVisible();
  await expect(cell).toBeFocused();
  return cell;
}

/** Registers a global command sequence probe through the app shortcut manager. */
async function registerSequenceShortcutProbe(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const probeWindow = window as ShortcutSequenceProbeWindow;
    probeWindow.__keyboardShortcutSequenceHits = 0;
    probeWindow.__keyboardShortcutSequenceUnregister?.();

    const shortcuts = await import("/lib/keyboardShortcuts.ts");
    probeWindow.__keyboardShortcutSequenceUnregister =
      shortcuts.registerKeyboardShortcut(
        {
          key: "$mod+k x",
          handler: () => {
            probeWindow.__keyboardShortcutSequenceHits =
              (probeWindow.__keyboardShortcutSequenceHits ?? 0) + 1;
          },
          description: "Keyboard shortcut sequence probe",
        },
        { global: true },
      );
  });
}

/** Reads how many times the command sequence probe fired. */
async function countSequenceShortcutHits(page: Page): Promise<number> {
  return await page.evaluate(
    () =>
      (window as ShortcutSequenceProbeWindow).__keyboardShortcutSequenceHits ??
      0,
  );
}

/** Verifies global undo yields to browser-native undo for editable controls. */
test("mod z in an editable input uses native text undo", async ({ page }) => {
  await page.goto("/?e2e=keyboard-shortcuts-editable-undo");
  await initializeGlobalShortcuts(page);

  const input = await addProbeInput(page);
  await replaceProbeInputValue(input);

  await input.press("ControlOrMeta+Z");

  await expect(input).toHaveValue("alpha");
});

/** Verifies selected data-grid cells cannot hide command-chord prefixes. */
test("mod k sequences work from selected data-grid cells", async ({ page }) => {
  await page.goto("/?e2e=keyboard-shortcuts-grid-sequence");
  await initializeGlobalShortcuts(page);
  await registerSequenceShortcutProbe(page);
  await addFocusedGridSequenceCell(page);

  await page.keyboard.press("ControlOrMeta+K");
  await page.keyboard.press("X");

  await expect.poll(() => countSequenceShortcutHits(page)).toBe(1);
});
