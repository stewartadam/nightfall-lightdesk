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
 * connection, standing in for another client working on the same draft.
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
  const summary = editor.getByTestId("fixture-draft-editor");
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

/** Adds a channel through the mode's add form. */
async function addChannel(
  editor: Page,
  attribute: string,
  resolution: "8-bit" | "16-bit",
) {
  const form = editor.getByTestId("add-channel-form");
  await form.getByPlaceholder("e.g. Dimmer or ColorAdd_R").fill(attribute);
  await form.getByLabel("Resolution").selectOption({ label: resolution });
  await form.getByRole("button", { name: "Add channel" }).click();
}

/** Replaces a draft field's text and commits it with Enter. */
async function commitField(
  field: ReturnType<Page["getByLabel"]>,
  value: string,
) {
  await field.fill(value);
  await field.press("Enter");
}

/**
 * Builds a fixture from a blank draft with the editing controls: channels,
 * resolutions, a function and its named range, undo and redo, a color wheel
 * and the fixture's names, then saves it to the library, and saves a second
 * draft under the same name to confirm replacing the file.
 */
test("fixture editor builds and saves a fixture", async ({
  page,
  backendSlot,
}, testInfo) => {
  await openApp(page, backendSlot.backendPort);
  const editor = await openEditorFromPalette(page);
  const draftEditor = editor.getByTestId("fixture-draft-editor");

  await editor.getByTestId("fixture-starter-blank").click();
  await expect(draftEditor).toBeVisible();
  await expect(draftEditor).toContainText("No channels yet");

  await addChannel(editor, "Dimmer", "16-bit");
  await addChannel(editor, "ColorAdd_R", "8-bit");
  const rows = editor.getByTestId("channel-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("1–2");
  await expect(rows.nth(1)).toContainText("3");

  // Dropping the dimmer to 8-bit moves the red channel up an address.
  await rows
    .nth(0)
    .getByRole("combobox", { name: /^Resolution of/ })
    .selectOption({ label: "8-bit" });
  await expect(rows.nth(0).locator("td").first()).toHaveText("1");
  await expect(rows.nth(1).locator("td").first()).toHaveText("2");
  await editor.screenshot({ path: testInfo.outputPath("05-channels.png") });

  await rows
    .nth(0)
    .getByRole("button", { name: /Dimmer/ })
    .first()
    .click();
  const detail = editor.getByTestId("channel-detail");
  await expect(detail).toBeVisible();
  const card = detail.getByTestId("function-card").first();
  await commitField(card.getByLabel("Function name"), "Intensity");
  await expect(card.getByLabel("Function name")).toHaveValue("Intensity");

  await card.getByRole("button", { name: "Add range" }).click();
  const range = card.getByTestId("range-row");
  await expect(range).toHaveCount(1);
  await commitField(range.getByLabel("Range name"), "Full");
  await expect(range.getByLabel("Range name")).toHaveValue("Full");
  await editor.screenshot({
    path: testInfo.outputPath("06-channel-detail.png"),
  });

  // Undo steps back one edit at a time, and redo reapplies it.
  await draftEditor.getByRole("button", { name: "Undo" }).click();
  await expect(range.getByLabel("Range name")).toHaveValue("Range 1");
  await draftEditor.getByRole("button", { name: "Redo" }).click();
  await expect(range.getByLabel("Range name")).toHaveValue("Full");

  await editor.getByRole("tab", { name: "Wheels" }).click();
  await editor.getByRole("button", { name: "Add wheel" }).click();
  const wheel = editor.getByTestId("wheel-card");
  await expect(wheel).toHaveCount(1);
  await wheel.getByRole("button", { name: "Add slot" }).click();
  await wheel.getByRole("button", { name: "Add slot" }).click();
  const slots = wheel.getByTestId("wheel-slot");
  await expect(slots).toHaveCount(2);
  await commitField(slots.nth(1).getByLabel("Name of slot 2"), "Red");
  await slots.nth(1).getByLabel("Color of Red").fill("#ff0000");
  await expect(slots.nth(1).getByLabel("Color of Red")).toHaveValue("#ff0000");
  await editor.screenshot({ path: testInfo.outputPath("07-wheels.png") });

  await editor.getByRole("tab", { name: "Fixture" }).click();
  await commitField(editor.getByLabel("Manufacturer", { exact: true }), "Acme");
  await commitField(editor.getByLabel("Name", { exact: true }), "Test Par");
  await expect(
    draftEditor.getByRole("heading", { name: "Acme Test Par" }),
  ).toBeVisible();
  await editor.screenshot({ path: testInfo.outputPath("08-fixture-info.png") });

  await draftEditor.getByRole("button", { name: "Save" }).click();
  const saveDialog = editor.getByRole("dialog", {
    name: "Save to fixture library",
  });
  await expect(saveDialog).toBeVisible();
  await saveDialog.getByLabel("Revision note").fill("First version");
  await editor.screenshot({ path: testInfo.outputPath("09-save.png") });
  await saveDialog.getByRole("button", { name: "Save" }).click();
  await expect(saveDialog).toBeHidden();
  await expect(draftEditor).toContainText("saves to");
  await expect(draftEditor).not.toContainText("Unsaved");

  // A second draft saved under the same name asks before replacing the file.
  await editor.getByRole("button", { name: "Back to the start page" }).click();
  await editor.getByTestId("fixture-starter-dimmer").click();
  await editor.getByRole("tab", { name: "Fixture" }).click();
  await commitField(editor.getByLabel("Manufacturer", { exact: true }), "Acme");
  await commitField(editor.getByLabel("Name", { exact: true }), "Test Par");
  await expect(
    draftEditor.getByRole("heading", { name: "Acme Test Par" }),
  ).toBeVisible();
  await draftEditor.getByRole("button", { name: "Save" }).click();
  await saveDialog.getByRole("button", { name: "Save" }).click();
  await expect(saveDialog.getByTestId("fixture-save-conflict")).toBeVisible();
  await editor.screenshot({ path: testInfo.outputPath("10-replace.png") });
  await saveDialog.getByRole("button", { name: "Replace file" }).click();
  await expect(saveDialog).toBeHidden();

  await editor.getByRole("button", { name: "Back to the start page" }).click();
  await editor.getByLabel("Search library fixtures").fill("Acme Test Par");
  await expect(
    editor
      .getByTestId("fixture-editor-library")
      .getByRole("listitem")
      .filter({ hasText: "Acme Test Par" }),
  ).toHaveCount(1, { timeout: 15_000 });
});
