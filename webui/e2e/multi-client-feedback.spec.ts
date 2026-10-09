// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.setTimeout(90_000);

const FAILURE_TEXT = "No command handler is registered for module";

/** Opens the shell on one page and waits until its websocket can complete awaited commands. */
async function openConnectedShell(page: Page): Promise<void> {
  await page.goto("/?e2e=1&startup:draftRecovery=false");
  await waitForDockviewApp(page, { timeoutMs: 60_000 });
  await expect
    .poll(() =>
      page.evaluate(
        () => typeof (window as any).appStores?.sendAndAwait === "function",
      ),
    )
    .toBe(true);
  await sendAndExpect(page, "Succeeded");
}

/**
 * Sends one command on the page's own websocket and waits for its terminal result.
 *
 * `Succeeded` sends a harmless frame-rate command; `Failed` names a module the backend does
 * not handle, which fails with a correlated result and an error toast on the sender.
 */
async function sendAndExpect(
  page: Page,
  outcome: "Succeeded" | "Failed",
): Promise<void> {
  const result = await page.evaluate(
    (failing) =>
      (window as any).appStores.sendAndAwait(
        failing
          ? { module: "MissingCommand", command: {} }
          : { module: "EngineCommand", command: { type: "SetFps", data: 44 } },
      ),
    outcome === "Failed",
  );
  expect(result.outcome.type).toBe(outcome);
}

/** Verifies a failed command toasts only on the client that sent it. */
test("command failures are reported only to the sending client", async ({
  backendSlot,
  page,
}, testInfo) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  const otherPage = await page.context().newPage();
  await openConnectedShell(page);
  await openConnectedShell(otherPage);

  await sendAndExpect(page, "Failed");
  await expect(page.locator(".toastify")).toContainText(FAILURE_TEXT);

  // The engine queues each client's frames in order, so once the other client's own later
  // result arrives, any broadcast copy of the failure would already have been delivered.
  await sendAndExpect(otherPage, "Succeeded");
  await expect(
    otherPage.locator(".toastify", { hasText: FAILURE_TEXT }),
  ).toHaveCount(0);

  await page.screenshot({ path: testInfo.outputPath("sender.png") });
  await otherPage.screenshot({ path: testInfo.outputPath("other-client.png") });
});
