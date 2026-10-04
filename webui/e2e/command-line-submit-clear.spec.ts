// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Reads the scrollback status of the most recent entry for one command. */
async function scrollbackStatus(
  page: import("@playwright/test").Page,
  command: string,
): Promise<string | undefined> {
  return page.evaluate((command) => {
    const entries = (window as any).appStores.consoleScrollback.get() as {
      command: string;
      status: string;
    }[];
    return entries.filter((entry) => entry.command === command).at(-1)?.status;
  }, command);
}

/**
 * Verifies a command that parses is cleared from the header input while the
 * backend is still executing it, rather than lingering until its result.
 */
test("header command input clears once a valid command is submitted", async ({
  page,
}) => {
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.waitForFunction(() =>
    Boolean((window as any).appStores?.consoleScrollback),
  );
  const input = page.getByRole("textbox", {
    name: "Command input",
    exact: true,
  });

  const command = "sleep 3s";
  await input.fill(command);
  await input.press("Enter");

  await expect(input).toHaveValue("", { timeout: 1_000 });
  await expect.poll(() => scrollbackStatus(page, command)).toBe("pending");

  await expect
    .poll(() => scrollbackStatus(page, command), { timeout: 10_000 })
    .toBe("success");
});

/**
 * Verifies a showfile save submitted behind a running command waits for it, so
 * the save captures everything the operator entered before it, and that the
 * input's queue indicator opens the Console listing the queued command.
 */
test("header command input sends save after earlier commands settle", async ({
  page,
}, testInfo) => {
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.waitForFunction(() =>
    Boolean((window as any).appStores?.consoleScrollback),
  );
  const input = page.getByRole("textbox", {
    name: "Command input",
    exact: true,
  });

  await input.fill("sleep 6s");
  await input.press("Enter");
  await expect.poll(() => scrollbackStatus(page, "sleep 6s")).toBe("pending");
  await input.fill("save");
  await input.press("Enter");
  await expect(input).toHaveValue("");

  expect(await scrollbackStatus(page, "save")).toBeUndefined();
  const headerGroup = page.locator(".nf-header-command-group");
  const queueStatus = headerGroup.getByRole("button", {
    name: "1 command running, 1 queued. Show in Console",
  });
  await expect(queueStatus).toBeVisible();
  await expect(input).toHaveAttribute("placeholder", /to enter command/);
  await headerGroup.screenshot({
    path: testInfo.outputPath("queue-empty-input.png"),
  });
  await input.fill("fixture 1");
  await expect(queueStatus).toBeVisible();
  await headerGroup.screenshot({
    path: testInfo.outputPath("queue-with-input.png"),
  });
  await input.fill("");

  await queueStatus.click();
  const queuedRow = page.locator("[data-command-queued]");
  await expect(queuedRow).toBeVisible();
  await expect(queuedRow).toContainText("save");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.dockApi.get()?.activePanel?.id,
      ),
    )
    .toBe("panel-CommandLine");
  await page.screenshot({ path: testInfo.outputPath("queue-console.png") });
  await expect
    .poll(() => scrollbackStatus(page, "sleep 6s"), { timeout: 10_000 })
    .toBe("success");
  await expect
    .poll(() => scrollbackStatus(page, "save"), { timeout: 10_000 })
    .not.toBeUndefined();
  await expect(page.locator("[data-command-queue-count]")).toHaveCount(0);
  await expect(input).toHaveAttribute("placeholder", /to enter command/);
});

/**
 * Verifies the queue indicator counts each statement of a multi-statement
 * submission and counts down as statements settle, while the Console lists
 * the statements not yet sent.
 */
test("queue indicator counts down statements of a sequence", async ({
  page,
}, testInfo) => {
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.waitForFunction(() =>
    Boolean((window as any).appStores?.consoleScrollback),
  );
  const input = page.getByRole("textbox", {
    name: "Command input",
    exact: true,
  });
  const indicator = page
    .locator(".nf-header-command-group")
    .locator("[data-command-queue-count]");

  await input.fill("sleep 2s; sleep 2s; sleep 2s");
  await input.press("Enter");
  await expect(indicator).toHaveText("3");
  await expect(indicator).toHaveAccessibleName(
    "1 command running, 2 queued. Show in Console",
  );
  await indicator.click();
  await expect(page.locator("[data-command-queued]")).toHaveCount(2);
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.locator("[data-command-queued]")).toHaveCount(2);
  await expect(page.getByText("History: 0")).toBeVisible();
  expect(await page.getByText(/No commands yet/).count()).toBe(0);
  await page.screenshot({
    path: testInfo.outputPath("queue-sequence-console.png"),
  });
  await expect(indicator).toHaveText("2", { timeout: 5_000 });
  await expect(page.locator("[data-command-queued]")).toHaveCount(1);
  await expect(indicator).toHaveText("1", { timeout: 5_000 });
  await expect(page.locator("[data-command-queued]")).toHaveCount(0);
  await expect(indicator).toHaveCount(0, { timeout: 5_000 });
});

/** Verifies an input that fails to parse stays in place for the operator to fix. */
test("header command input keeps a command that fails to parse", async ({
  page,
}) => {
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  const input = page.getByRole("textbox", {
    name: "Command input",
    exact: true,
  });

  const command = "fixture @@@";
  await input.fill(command);
  await input.press("Enter");

  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(input).toHaveValue(command);
});
