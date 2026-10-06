// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

declare global {
  interface Window {
    openedUrls?: string[];
  }
}

const HEADLINE = "TypeError: crypto.randomUUID is not a function";

/** Uncaught failures appear as one error notification each, with a Report Bug action that prefills the issue form. */
test("shows uncaught errors with a prefilled bug report", async ({
  page,
}, testInfo) => {
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.evaluate(() => {
    window.openedUrls = [];
    window.open = ((url?: string | URL) => {
      window.openedUrls?.push(String(url));
      return null;
    }) as typeof window.open;
    /** Fails like a command sent from a non-secure LAN page. */
    function sendCommand() {
      throw new TypeError("crypto.randomUUID is not a function");
    }
    setTimeout(sendCommand);
    void Promise.reject(new Error("Demo rejection nobody handled"));
  });

  const errorToasts = page.locator(
    '[data-component="Toast"][data-level="error"]',
  );
  const toast = errorToasts.filter({ hasText: HEADLINE });
  await expect(toast).toContainText("Something went wrong");
  await expect(toast.getByRole("button", { name: "Report Bug" })).toBeVisible();
  await expect(
    errorToasts.filter({ hasText: "Error: Demo rejection nobody handled" }),
  ).toBeVisible();
  // Let the toast entrance transition settle before capturing.
  await page.waitForTimeout(1000);
  await page.screenshot({
    path: testInfo.outputPath("uncaught-error-toast.png"),
  });

  // A failure that repeats does not stack further notifications.
  await page.evaluate(() =>
    setTimeout(() => {
      throw new TypeError("crypto.randomUUID is not a function");
    }),
  );
  await page.waitForTimeout(500);
  await expect(toast).toHaveCount(1);

  await toast.getByRole("button", { name: "Report Bug" }).click();
  await expect
    .poll(() => page.evaluate(() => window.openedUrls?.length))
    .toBe(1);
  const opened = new URL(
    (await page.evaluate(() => window.openedUrls?.[0])) ?? "",
  );
  expect(opened.searchParams.get("template")).toBe("bug_report.yml");
  expect(opened.searchParams.get("title")).toBe(`[Bug] ${HEADLINE}`);
  const problem = opened.searchParams.get("problem") ?? "";
  expect(problem).toContain(`(app)`);
  expect(problem).toContain(HEADLINE);
  expect(problem).toMatch(/at sendCommand/);
  expect(opened.searchParams.get("system-information")).toContain(
    "Browser demo",
  );
  await expect(toast).toHaveCount(0);
});

/** Failures inside a worker reach the page with their stack instead of only the worker console. */
test("shows uncaught errors forwarded from a worker", async ({ page }) => {
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.evaluate(async () => {
    const source = `
      import { forwardWorkerUncaughtErrors } from "${location.origin}/lib/uncaught-error.ts";
      forwardWorkerUncaughtErrors();
      function decodeFrame() { throw new RangeError("worker frame out of range"); }
      setTimeout(decodeFrame);
      Promise.reject(new Error("worker rejection nobody handled"));
    `;
    const reporter = await import(
      /* @vite-ignore */ `${location.origin}/lib/uncaught-error-reporter.ts`
    );
    const worker = new Worker(
      URL.createObjectURL(new Blob([source], { type: "text/javascript" })),
      { type: "module" },
    );
    reporter.watchWorkerUncaughtErrors(worker, "test worker");
  });

  const errorToasts = page.locator(
    '[data-component="Toast"][data-level="error"]',
  );
  await expect(
    errorToasts.filter({ hasText: "RangeError: worker frame out of range" }),
  ).toBeVisible();
  await expect(
    errorToasts.filter({ hasText: "Error: worker rejection nobody handled" }),
  ).toBeVisible();
});
