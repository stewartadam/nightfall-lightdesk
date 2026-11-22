// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.use({ experimentalFlows: true });

type OwnedFlow = {
  id: number;
  uid: string;
};

/** Opens a unique blank showfile for the flow editor fallback scenario. */
async function openOwnedFlowEditorApp(page: Page): Promise<void> {
  const testInfo = test.info();
  const showfileName = `flow-idle-callback-${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`;

  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");

  const openDialog = page.getByRole("dialog", { name: "Open Showfile" });
  await expect(openDialog).toBeVisible();
  await openDialog.getByRole("button", { name: "New showfile" }).click();
  const newDialog = page.getByRole("dialog", { name: "New Showfile" });
  await expect(newDialog).toBeVisible();
  await newDialog.getByLabel("Show name").fill(showfileName);
  await newDialog.getByRole("button", { name: "Create Show" }).click();
  await expect(newDialog).not.toBeVisible({ timeout: 10_000 });
  await waitForDockviewApp(page);
}

/** Reads the single flow created through the blank showfile's Flow list. */
async function readOwnedFlow(page: Page): Promise<OwnedFlow> {
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as any).appStores.flows.get()).length,
      ),
    )
    .toBe(1);
  return page.evaluate(() => {
    const flow = Object.values((window as any).appStores.flows.get())[0] as any;
    return {
      id: flow.identifiers.id,
      uid: flow.identifiers.uid,
    };
  });
}

/** Deletes the flow created by the idle-callback scenario. */
async function deleteOwnedFlow(page: Page, flow: OwnedFlow): Promise<void> {
  await page.evaluate(async (id) => {
    await (window as any).appStores.sendAndAwait({
      module: "FlowCommand",
      command: { type: "DeleteFlow", data: id },
    });
  }, flow.id);
  await expect
    .poll(() =>
      page.evaluate(
        (uid) => !(window as any).appStores.flows.get()[uid],
        flow.uid,
      ),
    )
    .toBe(true);
}

test("flow editor opens without requestIdleCallback globals", async ({
  page,
}) => {
  const pageErrors: string[] = [];

  await page.addInitScript(() => {
    const host = window as Window & {
      requestIdleCallback?: unknown;
      cancelIdleCallback?: unknown;
    };
    Reflect.deleteProperty(host, "requestIdleCallback");
    Reflect.deleteProperty(host, "cancelIdleCallback");
  });

  page.on("pageerror", (error) => {
    pageErrors.push(`${error.name}: ${error.message}`);
  });

  await openOwnedFlowEditorApp(page);

  const flowsTab = page.locator(".dv-tab").filter({ hasText: "Flows" });
  await expect(flowsTab).toBeVisible();
  await flowsTab.click();

  const addFlowButton = page.getByLabel("Add flow");
  await expect(addFlowButton).toBeVisible();
  await addFlowButton.click();

  const flow = await readOwnedFlow(page);
  const newFlowTitle = page
    .getByRole("button", { name: /^\d+: Flow \d+ 0 nodes$/ })
    .last();
  try {
    await expect(newFlowTitle).toContainText(String(flow.id));
    await newFlowTitle.click();

    await expect(
      page.locator('[data-component="FlowEditorGraph"]').first(),
    ).toBeVisible();
    await expect(page.getByText("Flow editor failed")).toHaveCount(0);

    await page.waitForTimeout(1200);
    expect(
      pageErrors.filter((message) => message.includes("requestIdleCallback")),
    ).toEqual([]);
  } finally {
    await deleteOwnedFlow(page, flow);
  }
});
