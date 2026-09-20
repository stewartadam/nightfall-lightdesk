// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  expect,
  type Page,
  frontendOnlyTest as test,
} from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Opens an isolated browser engine and waits for the shell before exercising central notifications. */
async function openNotifications(page: Page) {
  await page.goto(
    "/?engine=embedded-demo&startup:draftRecovery=false&e2e=1&visualizer:defaultPanel=false",
  );
  await waitForDockviewApp(page);
  await expect(page.locator(".toastify")).toHaveCount(0);
  await page.evaluate(() => {
    const state = window as any;
    state.appStores.clearNotificationHistory();
    state.toastHistoryUpdates = 0;
    state.maxVisibleToasts = 0;
    state.appStores.notificationHistory.listen(() => {
      state.toastHistoryUpdates += 1;
    });
    new MutationObserver(() => {
      state.maxVisibleToasts = Math.max(
        state.maxVisibleToasts,
        document.querySelectorAll(".toastify").length,
      );
    }).observe(document.body, { childList: true, subtree: true });
  });
}

/** A warning flood performs no synchronous rendering, publishes once, and leaves the desk interactive. */
test("640 unique warnings render a summary and batch history", async ({
  page,
}) => {
  await openNotifications(page);
  const immediate = await page.evaluate(() => {
    const state = window as any;
    for (let i = 0; i < 640; i += 1)
      state.appStores.pushToast("warning", `Pixel warning ${i}`);
    return {
      toasts: document.querySelectorAll(".toastify").length,
      updates: state.toastHistoryUpdates,
    };
  });
  expect(immediate).toEqual({ toasts: 0, updates: 0 });
  await expect(page.locator(".toastify")).toHaveCount(1);
  await expect(page.locator(".toastify")).toContainText(
    "640 additional notifications",
  );
  expect(await page.evaluate(() => (window as any).toastHistoryUpdates)).toBe(
    1,
  );
  await page.locator("#header-cmdline").fill("clear");
  await expect(page.locator("#header-cmdline")).toHaveValue("clear");
  await page.locator("#header-cmdline").press("Escape");
  await page
    .getByRole("button", { name: "Notification history", exact: true })
    .click();
  const history = page.getByRole("region", { name: "Notification history" });
  await expect(history.locator("tbody tr")).toHaveCount(100);
  await expect(history.locator("tbody tr").first()).toContainText(
    "Pixel warning 639",
  );
  await page.screenshot({
    path: test.info().outputPath("notification-burst.png"),
    animations: "disabled",
  });
});

/** Repeated messages share a counted toast while close transitions never overfill the stack. */
test("duplicate bursts coalesce and dismissal respects the visible cap", async ({
  page,
}) => {
  await openNotifications(page);
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    for (let i = 0; i < 640; i += 1)
      stores.pushToast("warning", "Repeated warning", -1);
  });
  await expect(page.locator(".toastify")).toHaveCount(1);
  await expect(page.locator(".toastify")).toContainText("Repeated 640 times");
  await page.evaluate(() => {
    for (let i = 0; i < 6; i += 1)
      (window as any).appStores.pushToast("info", `Queued ${i}`, -1);
  });
  await expect(page.locator(".toastify")).toHaveCount(3);
  await page.evaluate(() =>
    (window as any).appStores.pushToast("info", "Queued 1", -1),
  );
  await expect(
    page.locator(".toastify").filter({ hasText: "Queued 1" }),
  ).toContainText("Repeated 2 times");
  await expect
    .poll(() =>
      page.locator(".toastify").evaluateAll((nodes) => {
        const bounds = nodes
          .map((node) => node.getBoundingClientRect())
          .sort((a, b) => a.top - b.top);
        return bounds.every(
          (bound, index) =>
            index === 0 || bound.top >= bounds[index - 1].bottom,
        );
      }),
    )
    .toBe(true);
  await page
    .locator(".toastify")
    .filter({ hasText: "Repeated warning" })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(
    page.locator(".toastify").filter({ hasText: "Queued 2" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).maxVisibleToasts),
  ).toBeLessThanOrEqual(3);
});

/** Overflowed action notifications remain usable from history and execute a dismissing action once. */
test("overflow retains action buttons in notification history", async ({
  page,
}) => {
  await openNotifications(page);
  await page.evaluate(() => {
    const state = window as any;
    state.toastActionCalls = 0;
    for (let i = 0; i < 12; i += 1)
      state.appStores.pushToast("error", `Operation ${i}`, -1, [
        {
          label: `Retry ${i}`,
          onClick: () => {
            state.toastActionCalls += 1;
          },
        },
      ]);
    for (let i = 0; i < 640; i += 1)
      state.appStores.pushToast("warning", `Background warning ${i}`);
  });
  await expect(page.locator(".toastify")).toHaveCount(3);
  await page
    .getByRole("button", { name: "Notification history", exact: true })
    .click();
  const history = page.getByRole("region", { name: "Notification history" });
  await expect(
    history.getByRole("button", { name: "Retry 11", exact: true }),
  ).toBeVisible();
  await history.getByRole("button", { name: "Retry 11", exact: true }).click();
  await expect(
    history.getByRole("button", { name: "Retry 11", exact: true }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).toastActionCalls)).toBe(1);
  expect(
    await page.evaluate(() => (window as any).maxVisibleToasts),
  ).toBeLessThanOrEqual(3);
  await page.screenshot({
    path: test.info().outputPath("notification-actions.png"),
    animations: "disabled",
  });
});
