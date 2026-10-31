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

/** Opens a fresh blank showfile in the main window. */
async function openApp(page: Page, backendPort: number): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
}

/** Runs the Fixture Editor palette command and returns the window it opens. */
async function openEditorFromPalette(page: Page): Promise<Page> {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  const input = page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER);
  await expect(input).toBeVisible();
  await input.fill("Fixture Editor");
  const popup = page.waitForEvent("popup");
  await page.keyboard.press("Enter");
  const editor = await popup;
  await editor.setViewportSize({ width: 1100, height: 760 });
  await expect(
    editor.getByRole("heading", { name: "Fixture Editor", level: 1 }),
  ).toBeVisible();
  await expect(editor.getByTestId("fixture-starter-blank")).toBeVisible({
    timeout: 15_000,
  });
  return editor;
}

/**
 * Sends one fixture-editor command through the editor's own engine
 * connection, standing in for editing controls the window does not have yet.
 */
async function sendEditorCommand(editor: Page, command: unknown) {
  await editor.evaluate(async (payload) => {
    const runtime = window.__nightfallTest.runtime;
    const result = await runtime.engineRuntime.sendCommandAndAwait({
      module: "FixtureEditorCommand",
      command: payload,
    } as any);
    if (result?.outcome?.type === "Failed") {
      throw new Error(JSON.stringify(result.outcome.data));
    }
  }, command);
}

/** Returns the id of the open draft whose fixture has the given name. */
async function draftIdNamed(editor: Page, name: string): Promise<number> {
  return editor.evaluate(
    (wanted) =>
      (window as any).appStores.fixtureDrafts
        .get()
        .find((draft: any) => draft.info.name === wanted).draft_id as number,
    name,
  );
}

/**
 * Walks the editor window: open it from the command palette, start a draft
 * from a template, list it as an open draft, find the saved fixture in the
 * library, duplicate it and discard both drafts.
 */
test("fixture editor window starts, lists and discards drafts", async ({
  page,
  backendSlot,
}, testInfo) => {
  await openApp(page, backendSlot.backendPort);
  const editor = await openEditorFromPalette(page);
  await editor.screenshot({ path: testInfo.outputPath("01-start-page.png") });

  await editor.getByTestId("fixture-starter-rgbw").click();
  const summary = editor.getByTestId("fixture-draft-summary");
  await expect(
    summary.getByRole("heading", { name: "Generic RGBW" }),
  ).toBeVisible();
  await expect(summary).toContainText("New from the RGBW template");
  await expect(summary).toContainText("4-channel");
  await expect(summary).toContainText("4 ch");
  await editor.screenshot({ path: testInfo.outputPath("02-draft.png") });

  await editor.getByRole("button", { name: "Back to the start page" }).click();
  const draftRows = editor.getByTestId("fixture-draft-row");
  await expect(draftRows).toHaveCount(1);
  await expect(draftRows.first()).toContainText("Generic RGBW");

  await sendEditorCommand(editor, {
    type: "SaveDraft",
    data: { draft_id: await draftIdNamed(editor, "RGBW") },
  });
  const library = editor.getByTestId("fixture-editor-library");
  await editor.getByLabel("Search library fixtures").fill("Generic RGBW");
  const savedRow = library.getByRole("listitem").filter({
    hasText: "Generic RGBW",
  });
  await expect(savedRow).toHaveCount(1, { timeout: 15_000 });
  await editor.screenshot({
    path: testInfo.outputPath("03-open-draft-and-library.png"),
  });

  await savedRow.getByRole("button", { name: "Duplicate" }).click();
  await expect(summary).toContainText("Copy of Generic RGBW");
  await editor.getByRole("button", { name: "Back to the start page" }).click();
  await expect(draftRows).toHaveCount(2);

  // A saved draft has no unsaved changes, so it closes without asking.
  await draftRows
    .filter({ hasText: "New from the RGBW template" })
    .getByRole("button", { name: /^Discard/ })
    .click();
  await expect(draftRows).toHaveCount(1);

  // An edit made from any client reaches this window and marks the copy unsaved.
  await sendEditorCommand(editor, {
    type: "EditDraft",
    data: {
      draft_id: await draftIdNamed(editor, "RGBW copy"),
      edit: {
        type: "SetInfo",
        data: {
          name: "RGBW Strip",
          short_name: "RGBW Strip",
          long_name: "RGBW Strip",
          manufacturer: "Generic",
          description: "",
        },
      },
    },
  });
  await expect(draftRows.first()).toContainText("Generic RGBW Strip");
  await expect(draftRows.first()).toContainText("Unsaved");

  // Discarding unsaved changes asks first.
  await draftRows
    .first()
    .getByRole("button", { name: /^Discard/ })
    .click();
  const confirm = editor.getByRole("dialog", { name: "Discard draft?" });
  await expect(confirm).toBeVisible();
  await editor.screenshot({ path: testInfo.outputPath("04-discard.png") });
  await confirm.getByRole("button", { name: "Discard" }).click();
  await expect(draftRows).toHaveCount(0);

  // Running the command again focuses the open editor instead of opening another.
  let reopened = false;
  page.once("popup", () => {
    reopened = true;
  });
  await page.bringToFront();
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER).fill("Fixture Editor");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  expect(reopened).toBe(false);
});
