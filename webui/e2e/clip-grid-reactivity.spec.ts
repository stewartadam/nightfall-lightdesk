// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const COMMAND_INPUT_PLACEHOLDER = "Type a command or search...";
const CLIP_VIEW_MODE_KEY = "nightfall-crud-panel-view-mode:clips-list";
const CLIP_UID = "exec-grid-reactive";
const CLIP_ID = 9901;

/**
 * Opens the named panel through the command palette.
 */
async function openPanel(page: Page, panelName: string) {
  await page.getByRole("button", { name: "Open command palette" }).click();

  const commandInput = page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER);
  await expect(commandInput).toBeVisible();
  await commandInput.fill(`Open ${panelName}`);
  await page.keyboard.press("Enter");
}

/**
 * Seeds a single clip with the requested active state.
 */
async function seedClipState(page: Page, isActive: boolean) {
  await page.evaluate(
    ({ clipId, clipUid, nextIsActive }) => {
      const clip = {
        identifiers: {
          id: clipId,
          uid: clipUid,
          label: "Reactive Grid Clip",
        },
        priority: 0,
        options: { auto_release: false, deactivate_on_sequence_end: false },
      };
      (window as any).appStores.clips.set({
        [clipUid]: [clip, nextIsActive],
      });
    },
    {
      clipId: CLIP_ID,
      clipUid: CLIP_UID,
      nextIsActive: isActive,
    },
  );
}

/**
 * Reads clip commands sent through the websocket worker.
 */
async function clipCommands(page: Page) {
  return page.evaluate(() => {
    type IdExpr = { type: "Single"; data: number };
    type WorkerMessage = {
      type?: string;
      data?: {
        module?: string;
        command?: { type?: string; data?: IdExpr };
      };
    };

    return (
      ((window as any).__workerMessages as WorkerMessage[] | undefined)
        ?.flatMap((message) => {
          if (
            message?.type !== "send" ||
            message.data?.module !== "ClipCommand" ||
            message.data.command?.data?.type !== "Single"
          ) {
            return [];
          }

          return [
            {
              type: message.data.command.type,
              id: message.data.command.data.data,
            },
          ];
        })
        .filter(Boolean) ?? []
    );
  });
}

/**
 * Verifies clip grid cards read active state from the current store entry.
 */
test("clip grid play indicator and toggle use current clip state", async ({
  page,
}) => {
  await page.addInitScript((viewModeKey) => {
    window.localStorage.clear();
    window.localStorage.setItem(viewModeKey, "grid");

    const instrumentedWindow = window as Window & {
      __workerMessages?: unknown[];
    };
    instrumentedWindow.__workerMessages = [];

    const originalPostMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      message: unknown,
      optionsOrTransfer?: StructuredSerializeOptions | Transferable[],
    ) {
      instrumentedWindow.__workerMessages ??= [];
      instrumentedWindow.__workerMessages.push(message);
      return originalPostMessage.call(
        this,
        message,
        optionsOrTransfer as never,
      );
    };
  }, CLIP_VIEW_MODE_KEY);

  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);

  await openPanel(page, "Clips");
  await page.evaluate(() => {
    const panel = (window as any).appStores.dockApi
      .get()
      .getPanel("panel-ClipList");
    if (!panel) throw new Error("Expected clip list panel");
    panel.api.setActive();
    panel.focus();
  });
  const clipPanel = page.locator(
    '[data-panel-kind="clips"][data-panel-id="panel-ClipList"]:visible',
  );
  await expect(
    clipPanel.locator("[data-crud-select-id]").first(),
  ).toBeVisible();
  await seedClipState(page, false);

  const clipCard = clipPanel.locator(`[data-crud-select-id="${CLIP_UID}"]`);
  const activeIndicator = clipCard.locator(
    `[data-clip-active-indicator="${CLIP_UID}"]`,
  );
  await expect(clipCard).toBeVisible();
  await expect(activeIndicator).toHaveCount(0);

  await seedClipState(page, true);
  await expect(activeIndicator).toBeVisible();

  await page.evaluate(() => {
    (window as any).__workerMessages = [];
  });
  await clipCard.click();
  await expect
    .poll(() => clipCommands(page))
    .toEqual([{ type: "StopClip", id: CLIP_ID }]);

  await seedClipState(page, false);
  await expect(activeIndicator).toHaveCount(0);

  await page.evaluate(() => {
    (window as any).__workerMessages = [];
  });
  await clipCard.click();
  await expect
    .poll(() => clipCommands(page))
    .toEqual([{ type: "StartClip", id: CLIP_ID }]);

  await page.evaluate(() => {
    (window as any).__workerMessages = [];
  });
  await clipCard.click({ button: "right" });
  const contextMenu = page.locator('[data-menu-kind="context"]');
  await expect(contextMenu).toBeVisible();
  await seedClipState(page, true);
  await contextMenu.getByRole("menuitem", { name: "Start Clip" }).click();
  await expect
    .poll(() => clipCommands(page))
    .toEqual([{ type: "StopClip", id: CLIP_ID }]);
});
