// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Page } from "@playwright/test";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const PATCH_PANEL_ID = "panel-PatchEditor-demo-e2e";
const VISUALIZER_PANEL_ID = "panel-Visualizer";

/** Opens the embedded demo with the patch panel's fixture tab preselected. */
async function openEmbeddedDemo(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem("nightfall.currentShowfileName", "local-show");
    localStorage.setItem("nightfall-patch-panel:active-tab", "fixtures");
  });
  await page.goto(
    process.env.NIGHTFALL_PLAYWRIGHT_VITE_MODE === "preview"
      ? "/demo/app/?startup:draftRecovery=false&e2e=1"
      : "/?engine=embedded-demo&startup:draftRecovery=false&e2e=1",
  );
  await waitForDockviewApp(page);
}

/** Adds a focused Patch panel through Dockview so the test does not depend on the saved layout. */
async function openPatchPanel(page: Page): Promise<void> {
  await page.evaluate((panelId) => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel(panelId)?.api.close();
    const referencePanel = api.panels.find(
      (candidate: any) => candidate.api.location.type === "grid",
    );
    const panel = api.addPanel({
      id: panelId,
      component: "PatchEditor",
      title: "Patch",
      params: {},
      ...(referencePanel
        ? {
            position: {
              referencePanel: referencePanel.id,
              direction: "within",
            },
          }
        : {}),
    });
    panel.api.setActive();
    panel.focus();
  }, PATCH_PANEL_ID);
  await expect(
    page.locator(
      `[data-component="PatchEditor"][data-panel-id="${PATCH_PANEL_ID}"]`,
    ),
  ).toBeVisible();
}

/** Adds the 3D visualizer beside the patch panel and waits for its debug API. */
async function openVisualizer(page: Page): Promise<void> {
  await page.evaluate(
    ({ visualizerId, patchId }) => {
      const api = (window as any).appStores.dockApi.get();
      let panel = api.getPanel(visualizerId);
      if (!panel) {
        panel = api.addPanel({
          id: visualizerId,
          component: "Visualizer",
          title: "3D Visualizer",
          params: {},
          position: { referencePanel: patchId, direction: "right" },
        });
      }
      panel.api.setActive();
      panel.focus();
    },
    { visualizerId: VISUALIZER_PANEL_ID, patchId: PATCH_PANEL_ID },
  );
  const panel = page.locator(`[data-panel-id="${VISUALIZER_PANEL_ID}"]`);
  await expect(panel.locator("canvas").first()).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(
          (panelId) => Boolean((window as any).visualizerApis?.[panelId]),
          VISUALIZER_PANEL_ID,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
}

/** Submits a programmer expression through the command line and waits for success. */
async function submitCommand(page: Page, command: string): Promise<void> {
  const input = page.locator("#header-cmdline");
  await input.fill(command);
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect
    .poll(() =>
      page.evaluate((submittedCommand) => {
        const entries =
          (window as any).appStores?.consoleScrollback?.get?.() ?? [];
        const last = entries
          .filter((entry: any) => entry.command === submittedCommand)
          .at(-1);
        return last?.status ?? null;
      }, command),
    )
    .toBe("success");
}

/** Reads the created fixture, its console binding, and its programmer intensity by label. */
async function readCreatedFixture(page: Page, label: string) {
  return page.evaluate((fixtureLabel) => {
    const stores = (window as any).appStores;
    const fixture = Object.values(stores.fixtures.get()).find(
      (candidate: any) => candidate.identifiers.label === fixtureLabel,
    ) as any;
    if (!fixture) return null;
    const uid = fixture.identifiers.uid;
    /** Normalizes string or CBOR byte-map UUIDs to undashed lowercase hex. */
    const toHex = (value: any): string =>
      typeof value === "string"
        ? value.replace(/-/g, "")
        : Object.keys(value)
            .sort((a, b) => Number(a) - Number(b))
            .map((key) => Number(value[key]).toString(16).padStart(2, "0"))
            .join("");
    const consoleBinding = stores.bindings
      .get()
      .output.find(
        (binding: any) =>
          binding.source.type === "Fixture" &&
          binding.source.data.uids.some(
            (candidate: any) => toHex(candidate) === toHex(uid),
          ) &&
          binding.target.type === "Console",
      );
    const row = stores.parameters.get().get(uid);
    return {
      id: fixture.identifiers.id as number,
      uid: uid as string,
      make: fixture.make as string,
      model: fixture.model as string,
      mode: fixture.mode as string,
      placementY: fixture.placement?.position?.y ?? null,
      hasConsoleBinding: Boolean(consoleBinding),
      intensity: Number(row?.raw?.Intensity ?? 0),
    };
  }, label);
}

/** Verifies the demo lists built-in profiles and patches a working fixture through the wizard. */
test("embedded demo patches a built-in fixture through the patch wizard", async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) =>
    pageErrors.push(error.stack ?? error.message),
  );
  await openEmbeddedDemo(page);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return {
          capability: stores.runtimeCapabilities.get()?.fixture_library ?? null,
          libraryCount: stores.fixtureLibrary.get().length,
        };
      }),
    )
    .toEqual({ capability: "BuiltInOnly", libraryCount: 12 });

  await openPatchPanel(page);
  await openVisualizer(page);
  await page
    .locator(`[data-panel-id="${PATCH_PANEL_ID}"]`)
    .getByRole("button", { name: "Add fixture", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Patch Wizard" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("No fixtures in library", { exact: false }),
  ).toHaveCount(0);
  await expect(
    dialog.getByText("Only built-in profiles are available here", {
      exact: false,
    }),
  ).toBeVisible();
  const spotRow = dialog
    .getByRole("row")
    .filter({ hasText: "Generic" })
    .filter({ hasText: "Moving Head Spot 16ch" });
  await expect(spotRow).toContainText("Built-in");
  await dialog.locator(".nf-dialog-surface").screenshot({
    path: testInfo.outputPath("demo-patch-wizard-builtins.png"),
  });

  await spotRow.click();
  await dialog.getByRole("button", { name: "Next", exact: true }).click();
  await dialog.getByRole("button", { name: "Spot", exact: true }).click();
  await dialog.getByRole("button", { name: "Next", exact: true }).click();
  const label = `Demo Spot ${Date.now()}`;
  await dialog.getByRole("textbox", { name: "Label (optional)" }).fill(label);
  await expect(
    dialog.getByRole("checkbox", { name: "Assign Console DMX" }),
  ).toBeChecked();
  // The e2e sample has no console patch yet, so no universe can be suggested.
  await dialog.getByRole("spinbutton", { name: "Universe" }).fill("1");
  await dialog.getByRole("spinbutton", { name: "Start address" }).fill("1");
  await dialog.locator(".nf-dialog-surface").screenshot({
    path: testInfo.outputPath("demo-patch-wizard-configure.png"),
  });
  await dialog.getByRole("button", { name: "Next", exact: true }).click();
  await dialog.getByRole("button", { name: "Finish", exact: true }).click();
  await expect(dialog).toBeHidden();

  await expect
    .poll(() => readCreatedFixture(page, label))
    .toMatchObject({
      make: "Generic",
      model: "Moving Head Spot 16ch",
      mode: "Spot",
      placementY: 0.5,
      hasConsoleBinding: true,
    });
  const created = await readCreatedFixture(page, label);
  if (!created) throw new Error("Created fixture was unavailable");
  expect(created.intensity).toBe(0);

  await submitCommand(page, `fix ${created.id} @ 100`);
  await expect
    .poll(async () => (await readCreatedFixture(page, label))?.intensity ?? 0)
    .toBeGreaterThan(0);

  await page.evaluate(
    ({ panelId, uid }) =>
      (window as any).visualizerApis?.[panelId]?.zoomToFit([uid]),
    { panelId: VISUALIZER_PANEL_ID, uid: created.uid },
  );
  await page.waitForTimeout(500);
  await page.screenshot({
    path: testInfo.outputPath("demo-patch-wizard-visualizer.png"),
  });
  await page.locator(`[data-panel-id="${VISUALIZER_PANEL_ID}"]`).screenshot({
    path: testInfo.outputPath("demo-patch-wizard-visualizer-panel.png"),
  });
  await submitCommand(page, "clear");
  expect(pageErrors).toEqual([]);
});
