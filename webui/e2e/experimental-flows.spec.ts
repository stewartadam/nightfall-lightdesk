// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Creates an empty show so release-default layout assertions do not inherit a personal saved layout. */
async function openBlankShow(page: Page): Promise<void> {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/?e2e=1&startup:draftRecovery=false");
  const dialog = page.getByRole("dialog", { name: "Open Showfile" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "New showfile" }).click();
  const createDialog = page.getByRole("dialog", { name: "New Showfile" });
  await createDialog
    .getByLabel("Show name")
    .fill(`experimental-flows-${Date.now()}`);
  await createDialog.getByRole("button", { name: "Create Show" }).click();
  await expect(createDialog).not.toBeVisible();
  await waitForDockviewApp(page);
}

/** Verifies release defaults hide discovery, reject execution, and preserve restored panel metadata. */
test("flows are disabled by default", async ({ page }, testInfo) => {
  await openBlankShow(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).appStores.runtimeCapabilities.get()
            ?.experimental_flows,
      ),
    )
    .toBe(false);
  await expect(
    page.getByRole("tab", { name: "Flows", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Meta+Shift+P");
  await page.getByPlaceholder("Type a command or search...").fill("flow");
  await expect(page.getByText("Open Flows", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Open Flow Editor", { exact: true })).toHaveCount(
    0,
  );
  await page.keyboard.press("Escape");
  const completions = await page.evaluate(async () => {
    const { completeCommand } = await import("/lib/wasm-bridge.ts");
    return await completeCommand("store ", 6);
  });
  expect(
    completions?.candidates.some(
      (candidate: any) => candidate.insert_text.toLowerCase() === "flow",
    ),
  ).toBe(false);
  const outcome = await page.evaluate(async () => {
    try {
      return await (window as any).appStores.sendAndAwait({
        module: "FlowCommand",
        command: { type: "StartFlow", data: 1 },
      });
    } catch (error) {
      return String(error);
    }
  });
  expect(JSON.stringify(outcome)).toContain("flow.feature_disabled");
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api
      .addPanel({
        id: "saved-flow-editor",
        component: "FlowEditor",
        title: "Saved Flow",
        params: { initialFlowUid: "saved-flow" },
      })
      .api.setActive();
  });
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Your saved flow data is preserved" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("disabled-flow-panel.png"),
  });
});

test.describe("experimental opt-in", () => {
  test.use({ experimentalFlows: true });
  /** Verifies a backend opt-in exposes and opens the flow authoring panel. */
  test("flows appear when the backend opts in", async ({ page }, testInfo) => {
    await openBlankShow(page);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).appStores.runtimeCapabilities.get()
              ?.experimental_flows,
        ),
      )
      .toBe(true);
    await page.keyboard.press("Meta+Shift+P");
    await page
      .getByPlaceholder("Type a command or search...")
      .fill("Open Flows");
    await page.getByText("Open Flows", { exact: true }).click();
    await expect(
      page.getByRole("tab", { name: "Flows", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add flow", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () => Object.keys((window as any).appStores.flows.get()).length,
        ),
      )
      .toBe(1);
    await expect(
      page.getByRole("button", { name: /^\d+: Flow \d+ 0 nodes$/ }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("enabled-flows.png") });
  });
});
