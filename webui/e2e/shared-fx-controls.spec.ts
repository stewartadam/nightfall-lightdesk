// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, test } from "./playwright-fixtures";
import { dockFixturesInMainGrid, waitForDockviewApp } from "./showfile-startup";

/** Edits the production FX cycle length and relative switch, saves them, and checks compact field geometry. */
test("FX waveform uses shared fields and persists cycle length and relative edits", async ({
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
  await dockFixturesInMainGrid(page);
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
          cycle_length: { secs: 1, nanos: 0 },
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
  const cycleLength = waveform.getByRole("spinbutton", {
    name: /Cycle length/,
  });
  await expect(cycleLength).toHaveValue("1.00");
  await cycleLength.fill("2.5");
  await cycleLength.blur();
  await expect(cycleLength).toHaveValue("2.50");
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
          cycle_length: fx.attributes.Intensity.cycle_length,
          relative: fx.attributes.Intensity.is_relative,
          kind: fx.attributes.Intensity.params.kind,
        };
      }, uid),
    )
    .toEqual({
      cycle_length: { secs: 2, nanos: 500_000_000 },
      relative: true,
      kind: "triangle",
    });
  await cycleLength.focus();
  await expect(cycleLength).toHaveCSS("box-shadow", "none");
  await expect(cycleLength.locator("..")).not.toHaveCSS("box-shadow", "none");
  await waveform.screenshot({
    path: testInfo.outputPath("shared-waveform.png"),
  });
});

/** Switches a waveform FX to beat timing, checks the cycle length reads in beats, and saves it. */
test("FX editor Timing switch saves a beat-timed effect", async ({
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
  await dockFixturesInMainGrid(page);
  const uid = "99779977997799779977997799779977";
  await page.evaluate(async (uid) => {
    const stores = (window as any).appStores;
    const result = await stores.sendAndAwait({
      module: "FxCommand",
      command: {
        type: "StoreFx",
        data: {
          identifiers: { id: 9977, uid, label: "Beat FX" },
          selection: {
            source: { type: "Fixture", data: { fixture_id: 1 } },
            clauses: [],
          },
          attributes: {
            Intensity: {
              params: { kind: "sin", min: 0, max: 255, duty_cycle: 1 },
              cycle_length: { secs: 4, nanos: 0 },
              phase_range: [0, 0],
              width: 1,
              is_relative: false,
            },
          },
        },
      },
    });
    if (result.outcome.type !== "Succeeded")
      throw new Error(JSON.stringify(result));
    stores.dockApi.get().addPanel({
      id: "beat-fx",
      component: "FxEditor",
      title: "Beat FX",
      params: { initialPanelId: "beat-fx", initialFxUid: uid },
      position: { referencePanel: "panel-FixtureGrid", direction: "within" },
    });
  }, uid);
  const panel = page.locator('[data-panel-id="beat-fx"]');
  const timing = panel.getByRole("radiogroup", { name: "Timing" });
  await expect(timing.getByRole("radio", { name: "Seconds" })).toBeChecked();
  await expect(
    panel.getByRole("spinbutton", { name: "Cycle length in seconds" }),
  ).toHaveValue("4.00");

  await timing.getByRole("radio", { name: "Beats" }).check();
  const beats = panel.getByRole("spinbutton", {
    name: "Cycle length in beats",
  });
  await expect(beats).toHaveValue("4.00");
  await expect(panel.locator(".waveform-editor")).toContainText("beats");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        (uid) => (window as any).appStores.fx.get()[uid]?.timebase,
        uid,
      ),
    )
    .toBe("Beats");
  await panel.screenshot({ path: testInfo.outputPath("fx-timing-beats.png") });
});
