// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";

import { waitForDockviewApp } from "./showfile-startup";

/** Seeds deterministic command scrollback entries through the E2E store bridge. */
async function seedConsoleHistory(page: Page) {
  await page.waitForFunction(() =>
    Boolean((window as any).appStores?.consoleScrollback),
  );

  await page.evaluate(() => {
    const submittedAt = 1_700_000_000_000;
    (window as any).appStores.consoleScrollback.set([
      {
        id: "a",
        correlationId: "a",
        command: "group 1 at full",
        source: "UI",
        status: "success",
        submittedAt,
      },
      {
        id: "b",
        correlationId: "b",
        command: "fixture 12 color red",
        source: "UI",
        status: "success",
        submittedAt: submittedAt + 1,
      },
      {
        id: "c",
        correlationId: "c",
        command: "release all",
        source: "UI",
        status: "success",
        submittedAt: submittedAt + 2,
      },
    ]);
  });
}

/** Opens an isolated Console panel directly through the E2E Dockview bridge. */
async function openConsolePanel(page: Page) {
  await page.waitForFunction(() =>
    Boolean((window as any).appStores?.dockApi?.get?.()),
  );

  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-ConsoleHistorySearch")?.api.close();
    api.addPanel({
      id: "panel-ConsoleHistorySearch",
      component: "CommandLine",
      title: "Console",
      params: {},
    });
  });
}

/** Validates that Mod+F opens console history search and filters rows. */
test("console panel mod+f searches command history", async ({
  page,
}, testInfo) => {
  await page.goto("/?e2e=1");
  await waitForDockviewApp(page);
  const headerInput = page.getByRole("textbox", {
    name: "Command input",
    exact: true,
  });
  await headerInput.focus();
  await expect(headerInput).toHaveCSS("outline-style", "none");
  await expect(headerInput).not.toHaveCSS("box-shadow", "none");
  await headerInput.locator("../..").screenshot({
    path: testInfo.outputPath("header-command-focused.png"),
  });
  await seedConsoleHistory(page);
  await openConsolePanel(page);

  const consolePanel = page.locator(
    '[data-panel-id="panel-ConsoleHistorySearch"]',
  );
  const panelInput = consolePanel.getByLabel("Panel command input");
  await expect(panelInput).toBeVisible();
  await panelInput.focus();
  await expect(panelInput).toHaveCSS("outline-style", "none");
  await expect(panelInput).not.toHaveCSS("box-shadow", "none");
  await panelInput.locator("../..").screenshot({
    path: testInfo.outputPath("panel-command-focused.png"),
  });
  await page.keyboard.press("Meta+F");

  const searchInput = consolePanel.getByLabel("Command history search");
  await expect(searchInput).toBeFocused();
  await expect(searchInput).toHaveCSS("outline-style", "none");
  await searchInput.fill("fixture");

  await expect(consolePanel.getByText("fixture 12 color red")).toBeVisible();
  await expect(consolePanel.getByText("group 1 at full")).toHaveCount(0);
  await expect(consolePanel.getByText("release all")).toHaveCount(0);
  await expect(consolePanel.getByText("History: 1/3")).toBeVisible();
});
