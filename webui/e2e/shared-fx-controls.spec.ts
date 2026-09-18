// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Edits the production FX rate and relative switch, saves them, and checks compact field geometry. */
test("FX waveform uses shared fields and persists rate and relative edits", async ({
  page,
  backendSlot,
}, testInfo) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  const uid = "99669966996699669966996699669966";
  await page.evaluate(async (uid) => {
    const stores = (window as any).appStores;
    const fx = {
      identifiers: { id: 9966, uid, label: "Shared FX controls" },
      selection: {
        source: { type: "Fixture", data: { fixture_id: 1 } },
        clauses: [],
      },
      attributes: {
        Intensity: {
          params: { kind: "sin", min: 0, max: 255, duty_cycle: 1 },
          rate: { secs: 1, nanos: 0 },
          phase_range: [0, 0],
          width: 1,
          is_relative: false,
        },
      },
    };
    const result = await stores.sendAndAwait({
      module: "FxCommand",
      command: { type: "StoreFx", data: fx },
    });
    if (result.outcome.type !== "Succeeded")
      throw new Error(JSON.stringify(result));
    stores.dockApi.get().addPanel({
      id: "shared-fx",
      component: "FxEditor",
      title: "Shared FX controls",
      params: { initialPanelId: "shared-fx", initialFxUid: uid },
      position: { referencePanel: "panel-FixtureGrid", direction: "within" },
    });
  }, uid);
  const panel = page.locator('[data-panel-id="shared-fx"]');
  const waveform = panel.locator(".waveform-editor");
  const rate = waveform.getByRole("spinbutton", { name: /Rate/ });
  await expect(rate).toHaveValue("1.00");
  await rate.fill("2.5");
  await rate.blur();
  await expect(rate).toHaveValue("2.50");
  await waveform.getByRole("switch", { name: "Relative", exact: true }).check();
  await waveform.getByRole("button", { name: /Triangle/ }).click();
  await expect(
    waveform.getByRole("button", { name: /Triangle/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate((uid) => {
        const fx = (window as any).appStores.fx.get()[uid];
        return {
          rate: fx.attributes.Intensity.rate,
          relative: fx.attributes.Intensity.is_relative,
          kind: fx.attributes.Intensity.params.kind,
        };
      }, uid),
    )
    .toEqual({
      rate: { secs: 2, nanos: 500_000_000 },
      relative: true,
      kind: "triangle",
    });
  await rate.focus();
  await expect(rate).toHaveCSS("box-shadow", "none");
  await expect(rate.locator("..")).not.toHaveCSS("box-shadow", "none");
  await waveform.screenshot({
    path: testInfo.outputPath("shared-waveform.png"),
  });
});
