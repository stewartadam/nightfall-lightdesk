// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { openPanel } from "./controller-mapping";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const CLIP_ID = 941;
const FX_UID = "c9410000000000000000000000000001";
const CLIP_UID = "c9410000000000000000000000000002";

test.describe.configure({ timeout: 120_000 });

/** Sends one engine command and fails the test unless it succeeds. */
async function sendCommand(page: Page, data: object): Promise<void> {
  const result = await page.evaluate(
    (message) => (window as any).appStores.sendAndAwait(message),
    data,
  );
  expect(result.outcome.type, JSON.stringify(result)).toBe("Succeeded");
}

/** Returns whether the test clip has a running playback. */
async function clipRunning(page: Page): Promise<boolean> {
  return page.evaluate(
    (id) =>
      Object.values((window as any).appStores.clips.get()).some(
        (entry: any) => entry[0].identifiers.id === id && entry[1],
      ),
    CLIP_ID,
  );
}

/**
 * Opens a fresh show with an FX clip on fader 1, a slow tempo so a bar lasts eight
 * seconds, and the Tempo and Clips panels open.
 */
async function openQuantizeScenario(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.showTempo?.get()),
  );

  await sendCommand(page, {
    module: "FxCommand",
    command: {
      type: "StoreFx",
      data: {
        identifiers: { uid: FX_UID, id: CLIP_ID, label: "Quantized FX" },
        selection: { source: { type: "Resolved", data: [] }, clauses: [] },
        attributes: {},
      },
    },
  });
  await sendCommand(page, {
    module: "ClipCommand",
    command: {
      type: "StoreClip",
      data: {
        identifiers: { uid: CLIP_UID, id: CLIP_ID, label: "Quantized FX" },
        source: { type: "Fx", data: FX_UID },
        priority: 0,
        options: { auto_release: false, deactivate_on_sequence_end: false },
      },
    },
  });
  await sendCommand(page, {
    module: "FaderCommand",
    command: {
      type: "AssignClip",
      data: { fader_index: 1, clip_id: CLIP_ID },
    },
  });
  await sendCommand(page, {
    module: "TempoCommand",
    command: { type: "SetBpm", data: 30 },
  });

  await openPanel(page, "Clips");
  await openPanel(page, "Tempo");
  await expect(page.getByTestId("tempo-panel")).toBeVisible();
}

/**
 * Verifies that with launch quantize set to Bar a fader button press arms the clip, which pulses until
 * Launch armed clips now fires it; the mode is reported back to every client.
 */
test("launch quantize arms fader button presses until launched", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openQuantizeScenario(page, backendSlot.backendPort);

  const mode = page.getByRole("radiogroup", { name: "Launch quantize" });
  await expect(mode.getByRole("radio", { name: "Off" })).toBeChecked();
  await mode.getByRole("radio", { name: "Bar" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.showTempo.get()?.launchQuantize,
      ),
    )
    .toBe("Bar");

  // A press just after a downbeat fires at once, so wait until the bar is under way.
  await page.waitForFunction(() => {
    const state = (window as any).appStores.showTempo.get();
    const { beat_position, bar_origin, beats_per_bar } = state.snapshot;
    const sinceDownbeat =
      (((beat_position - bar_origin) % beats_per_bar) + beats_per_bar) %
      beats_per_bar;
    return sinceDownbeat > 0.2 && sinceDownbeat < 2;
  });

  const faderButton = page.locator('[data-fader-button-index="1"]');
  await faderButton.click();
  await expect(faderButton).toHaveAttribute("data-launch-armed", "Start");
  expect(await clipRunning(page)).toBe(false);
  await page.mouse.move(780, 280);
  await page.waitForTimeout(600);
  await page.screenshot({
    path: testInfo.outputPath("launch-quantize-armed.png"),
  });

  await page
    .getByRole("button", { name: "Launch armed clips now", exact: true })
    .click();
  await expect.poll(() => clipRunning(page)).toBe(true);
  await expect(faderButton).not.toHaveAttribute("data-launch-armed");

  await mode.getByRole("radio", { name: "Off" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.showTempo.get()?.launchQuantize,
      ),
    )
    .toBe("Off");
  await sendCommand(page, {
    module: "ClipCommand",
    command: { type: "StopClip", data: { type: "Single", data: CLIP_ID } },
  });
  await expect.poll(() => clipRunning(page)).toBe(false);
});
