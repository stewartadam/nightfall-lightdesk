// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { servesE2eBuild } from "./app-hooks";
import {
  test as backendTest,
  expect,
  frontendOnlyTest,
} from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

declare global {
  interface Window {
    /** While true, the stubbed Undo Stack panel throws during render. */
    __errorFallbackPanelFails?: boolean;
  }
}

// The app test loads the full workspace, which is slow on a cold dev server.
frontendOnlyTest.describe.configure({ timeout: 60_000 });

/** The design lab demo trips a real boundary, shows the shared fallback, and Retry re-renders the content. */
frontendOnlyTest(
  "design lab error fallback shows details and recovers on retry",
  async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.goto("/design-lab.html");
    await page
      .getByRole("navigation", { name: "Component index" })
      .getByRole("button", { name: /Error fallback/ })
      .click();
    const panel = page.getByRole("region", { name: "Error fallback examples" });
    await expect(
      panel.getByText("Sample panel content rendered"),
    ).toBeVisible();

    await panel.getByRole("button", { name: "Throw render error" }).click();
    const fallback = panel.getByRole("alert");
    await expect(fallback).toContainText("Sample panel failed to render");
    await expect(fallback).toContainText(
      "TypeError: Cannot read properties of undefined (reading 'cues')",
    );
    const details = fallback.locator("details");
    await expect(details).not.toHaveAttribute("open");
    await panel.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("design-lab-fallback.png"),
    });

    await fallback.getByText("Technical details").click();
    await expect(details.locator("pre")).toContainText(/\bat\b/);
    await panel.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("design-lab-fallback-details.png"),
    });

    await fallback.getByRole("button", { name: "Report Bug" }).click();
    await expect(panel.getByText("Bug reports opened: 1")).toBeVisible();

    await fallback.getByRole("button", { name: "Retry" }).click();
    await expect(panel.getByRole("alert")).toHaveCount(0);
    await expect(
      panel.getByText("Sample panel content rendered"),
    ).toBeVisible();
    await panel.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("design-lab-recovered.png"),
    });
  },
);

/** A panel that throws while rendering is contained by the Dockview panel boundary, and Retry remounts it. */
backendTest(
  "dockview panel boundary shows the shared fallback and retries",
  async ({ page }, testInfo) => {
    backendTest.skip(
      servesE2eBuild,
      "Stubs the panel's source module, which only the Vite dev server serves separately; run with --vite-mode dev",
    );
    await page.route("**/features/history/panel.tsx*", (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: `export default function UndoStackPanel() {
        if (window.__errorFallbackPanelFails) {
          throw new Error("Undo stack exploded");
        }
        const element = document.createElement("p");
        element.textContent = "Undo stack recovered";
        return element;
      }`,
      }),
    );
    await page.goto("/?e2e=1");
    await waitForDockviewApp(page);
    await page.evaluate(() => {
      window.__errorFallbackPanelFails = true;
      const api = (window as any).appStores.dockApi.get();
      api.getPanel("panel-UndoStack")?.api.close();
      api.addPanel({
        id: "panel-UndoStack",
        component: "UndoStack",
        title: "Undo Stack",
        params: {},
      });
    });

    const fallback = page
      .locator('[data-component="ErrorFallback"]')
      .getByRole("alert");
    await expect(fallback).toContainText("This panel failed to render");
    await expect(fallback).toContainText("Error: Undo stack exploded");
    await expect(
      fallback.getByRole("button", { name: "Report Bug" }),
    ).toBeVisible();
    await expect(fallback.locator("details")).not.toHaveAttribute("open");
    // Let the panel entrance settle before capturing.
    await page.waitForTimeout(500);
    await page.screenshot({
      path: testInfo.outputPath("dockview-panel-fallback.png"),
    });

    // Retry with the fault still present renders the fallback again.
    await fallback.getByRole("button", { name: "Retry" }).click();
    await expect(fallback).toContainText("Undo stack exploded");

    await page.evaluate(() => {
      window.__errorFallbackPanelFails = false;
    });
    await fallback.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText("Undo stack recovered")).toBeVisible();
    await expect(fallback).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("dockview-panel-recovered.png"),
    });
  },
);
