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
  expect(await scrollbackStatus(page, command)).toBe("pending");

  await expect
    .poll(() => scrollbackStatus(page, command), { timeout: 10_000 })
    .toBe("success");
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
