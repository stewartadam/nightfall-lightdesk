// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const COMMAND_INPUT_PLACEHOLDER = "Type a command or search...";
const OBJECT_INPUT_PLACEHOLDER = "Search showfile objects...";

/** Verifies each header palette button opens its corresponding overlay. */
test("toolbar buttons open command and object palettes", async ({
  page,
  backendSlot,
}, testInfo) => {
  await openApp(page, backendSlot.backendPort);
  const header = page.getByRole("navigation", { name: "Global" });
  for (const name of [
    "Open command palette",
    "Open object palette",
    "Notification history",
  ]) {
    const button = header.getByRole("button", { name, exact: true });
    await button.hover();
    await expect(page.getByRole("tooltip")).toHaveText(name);
    await expect(button).not.toHaveAttribute("title");
  }
  await page.screenshot({ path: testInfo.outputPath("header-tooltip.png") });
  await page.mouse.move(0, 200);
  await expect(page.getByRole("tooltip")).not.toBeVisible();
  await header.screenshot({ path: testInfo.outputPath("palette-toolbar.png") });
  await header
    .getByRole("button", { name: "Open command palette", exact: true })
    .click();
  await expect(page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER)).toBeVisible();
  await page.keyboard.press("Escape");
  await header
    .getByRole("button", { name: "Open object palette", exact: true })
    .click();
  await expect(page.getByPlaceholder(OBJECT_INPUT_PLACEHOLDER)).toBeVisible();
  await expect(
    page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER),
  ).not.toBeVisible();
  await page.keyboard.press("Escape");
});

/** Opens a unique blank showfile before palette interactions. */
async function openApp(page: Page, backendPort: number): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
}

/** Opens the command palette and returns its search input. */
async function openCommandPalette(page: Page) {
  await page.keyboard.press("ControlOrMeta+Shift+P");

  const commandInput = page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER);
  await expect(commandInput).toBeVisible();
  return commandInput;
}

/** Opens the showfile object palette and returns its search input. */
async function openShowfileObjectPalette(page: Page) {
  await page.keyboard.press("ControlOrMeta+P");

  const objectInput = page.getByPlaceholder(OBJECT_INPUT_PLACEHOLDER);
  await expect(objectInput).toBeVisible();
  return objectInput;
}

test("command palette shortcut closes the showfile object palette", async ({
  page,
  backendSlot,
}) => {
  await openApp(page, backendSlot.backendPort);

  const objectInput = await openShowfileObjectPalette(page);
  const commandInput = await openCommandPalette(page);

  await expect(commandInput).toBeVisible();
  await expect(objectInput).not.toBeVisible();
  await expect(
    page.locator(
      '[data-dialog-kind="command-palette"][data-dialog-visible="true"]',
    ),
  ).toHaveCount(1);
  await expect(
    page.locator(
      '[data-dialog-kind="showfile-object-palette"][data-dialog-visible="true"]',
    ),
  ).toHaveCount(0);
});

test("showfile object palette shortcut closes the command palette", async ({
  page,
  backendSlot,
}) => {
  await openApp(page, backendSlot.backendPort);

  const commandInput = await openCommandPalette(page);
  const objectInput = await openShowfileObjectPalette(page);

  await expect(objectInput).toBeVisible();
  await expect(commandInput).not.toBeVisible();
  await expect(
    page.locator(
      '[data-dialog-kind="showfile-object-palette"][data-dialog-visible="true"]',
    ),
  ).toHaveCount(1);
  await expect(
    page.locator(
      '[data-dialog-kind="command-palette"][data-dialog-visible="true"]',
    ),
  ).toHaveCount(0);
});

test("command palette selects the best match when the search input changes", async ({
  page,
  backendSlot,
}) => {
  await openApp(page, backendSlot.backendPort);

  const commandInput = await openCommandPalette(page);
  const selectedCommand = page.locator(
    '[data-command-id][data-selected="true"]',
  );

  await commandInput.fill("Open");
  await page.keyboard.press("PageDown");
  const selectedAfterNavigation =
    await selectedCommand.getAttribute("data-command-id");
  expect(selectedAfterNavigation).not.toBe("panel-CommandLine");

  await commandInput.fill("console");
  await expect(
    page.locator('[data-command-id="panel-CommandLine"]'),
  ).toHaveAttribute("data-selected", "true");
});

test("command palette selects the best direct panel title match", async ({
  page,
  backendSlot,
}) => {
  await openApp(page, backendSlot.backendPort);

  const commandInput = await openCommandPalette(page);

  await commandInput.fill("fixture");
  await expect(
    page.locator('[data-command-id="panel-FixtureGrid"]'),
  ).toHaveAttribute("data-selected", "true");

  await commandInput.fill("console");
  await expect(
    page.locator('[data-command-id="panel-CommandLine"]'),
  ).toHaveAttribute("data-selected", "true");
});

test("command palette supports page key navigation", async ({
  page,
  backendSlot,
}) => {
  await openApp(page, backendSlot.backendPort);

  const commandInput = await openCommandPalette(page);
  await commandInput.fill("Open");
  const selectedCommand = page.locator(
    '[data-command-id][data-selected="true"]',
  );
  await expect(selectedCommand).toHaveCount(1);
  await expect
    .poll(() => page.locator("[data-command-id]").count())
    .toBeGreaterThan(1);
  const selectedIndex = async () =>
    Number(await selectedCommand.getAttribute("data-command-index"));
  const initialIndex = await selectedIndex();

  await page.keyboard.press("PageDown");
  await expect.poll(selectedIndex).toBeGreaterThan(initialIndex);

  await page.keyboard.press("PageUp");
  await expect.poll(selectedIndex).toBeLessThanOrEqual(initialIndex);
});

/** Shows panel placement previews while modifiers are held without hiding them in the shared field. */
test("command palette previews panel placement while modifiers are held", async ({
  page,
  backendSlot,
}) => {
  await openApp(page, backendSlot.backendPort);

  const commandInput = await openCommandPalette(page);
  await commandInput.fill("Open Patch");

  const patchCommand = page.locator('[data-command-id="panel-PatchEditor"]');
  const placementBadge = page.locator('[data-panel-placement-badge="true"]');
  await expect(patchCommand).toHaveAttribute("data-selected", "true");
  await page.keyboard.down("Alt");
  await expect(placementBadge).toHaveText("split below");
  await expect(placementBadge).toBeVisible();

  await page.keyboard.up("Alt");
  await expect(placementBadge).toHaveCount(0);

  await page.keyboard.down("Control");
  await expect(placementBadge).toHaveText("new group right");
  await expect(placementBadge).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("panel-placement-preview.png"),
  });

  await page.keyboard.up("Control");
});

test("command palette restores the submitted command when reopened", async ({
  page,
  backendSlot,
}) => {
  await openApp(page, backendSlot.backendPort);

  const commandInput = await openCommandPalette(page);
  const selectionInspectorCommand = page.locator(
    '[data-command-id="panel-SelectionVisualizer"]',
  );

  await commandInput.fill("Selection Inspector");
  await expect(selectionInspectorCommand).toHaveAttribute(
    "data-selected",
    "true",
  );
  await page.keyboard.press("Enter");
  await expect(commandInput).not.toBeVisible();

  await openCommandPalette(page);
  await expect(selectionInspectorCommand).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(page.locator('[data-scroll-overflow="top"]')).toBeVisible();
  await expect(page.locator('[data-scroll-overflow="bottom"]')).toBeVisible();

  const overflowStyles = await page.evaluate(() => {
    return ["top", "bottom"].map((position) => {
      const indicator = document.querySelector<HTMLElement>(
        `[data-scroll-overflow="${position}"]`,
      );
      if (!indicator) {
        throw new Error(`Expected ${position} scroll overflow indicator`);
      }

      const style = getComputedStyle(indicator);
      const alpha = style.backgroundColor.startsWith("rgba(")
        ? Number(style.backgroundColor.split(",").at(-1)?.replace(")", ""))
        : 1;
      return {
        alpha,
        backgroundImage: style.backgroundImage,
      };
    });
  });
  for (const style of overflowStyles) {
    expect(style.backgroundImage).toBe("none");
    expect(style.alpha).toBe(1);
  }

  const placement = await page.evaluate(() => {
    const scrollArea = document.querySelector<HTMLElement>(
      '[data-command-scroll-area="true"]',
    );
    const selected = document.querySelector<HTMLElement>(
      '[data-command-id="panel-SelectionVisualizer"]',
    );
    if (!scrollArea || !selected) {
      throw new Error("Expected command palette scroll area and selection row");
    }

    const selectedIndex = Number(selected.dataset.commandIndex);
    const previous = document.querySelector<HTMLElement>(
      `[data-command-index="${selectedIndex - 1}"]`,
    );
    if (!previous) {
      throw new Error("Expected a previous command row");
    }

    const scrollRect = scrollArea.getBoundingClientRect();
    const selectedRect = selected.getBoundingClientRect();
    const previousRect = previous.getBoundingClientRect();
    return {
      previousTop: previousRect.top - scrollRect.top,
      selectedTop: selectedRect.top - scrollRect.top,
    };
  });
  expect(Math.abs(placement.previousTop)).toBeLessThan(3);
  expect(placement.selectedTop).toBeGreaterThan(0);
});

test("command palette scrolls category titles into view for first group items", async ({
  page,
  backendSlot,
}) => {
  await openApp(page, backendSlot.backendPort);
  const commandInput = await openCommandPalette(page);

  const target = await page.evaluate(() => {
    const headers = [
      ...document.querySelectorAll<HTMLElement>(
        "[data-command-category-title]",
      ),
    ];
    for (const header of headers.slice(1)) {
      const firstCommand =
        header.nextElementSibling?.querySelector<HTMLElement>(
          "[data-command-id]",
        );
      const commandName = firstCommand
        ?.querySelector<HTMLElement>(".font-medium")
        ?.textContent?.trim();
      if (firstCommand?.dataset.commandId && commandName) {
        return {
          id: firstCommand.dataset.commandId,
          name: commandName,
        };
      }
    }
    throw new Error("Expected a later command category with at least one item");
  });

  await commandInput.fill(target.name);
  await expect(
    page.locator(`[data-command-id="${target.id}"]`),
  ).toHaveAttribute("data-selected", "true");

  const placement = await page.evaluate((targetId) => {
    const scrollArea = document.querySelector<HTMLElement>(
      '[data-command-scroll-area="true"]',
    );
    const selected = document.querySelector<HTMLElement>(
      `[data-command-id="${targetId}"]`,
    );
    const categoryTitle = selected?.parentElement
      ?.previousElementSibling as HTMLElement | null;
    if (!scrollArea || !selected || !categoryTitle) {
      throw new Error("Expected scroll area, selected row, and category title");
    }

    const scrollRect = scrollArea.getBoundingClientRect();
    const selectedRect = selected.getBoundingClientRect();
    const titleRect = categoryTitle.getBoundingClientRect();
    return {
      selectedTop: selectedRect.top - scrollRect.top,
      titleTop: titleRect.top - scrollRect.top,
    };
  }, target.id);

  expect(Math.abs(placement.titleTop)).toBeLessThan(3);
  expect(placement.selectedTop).toBeGreaterThan(0);
});
