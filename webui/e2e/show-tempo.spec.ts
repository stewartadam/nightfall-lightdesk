// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Reads the engine's last reported tempo target from the app stores. */
async function targetBpm(page: Page): Promise<number | undefined> {
  return page.evaluate(
    () => (window as any).appStores.showTempo.get()?.snapshot.target_bpm,
  );
}

/** Submits one command through the header command line. */
async function runCommand(page: Page, command: string): Promise<void> {
  const input = page.getByRole("textbox", {
    name: "Command input",
    exact: true,
  });
  await input.fill(command);
  await input.press("Enter");
  await expect(input).toHaveValue("");
}

/**
 * Verifies the status-bar tempo readout follows the engine: tapping sets the
 * tempo, the tempo menu and the `tempo` command change it, and the beat
 * indicator animates.
 */
test("status bar tempo responds to taps, the menu and the command line", async ({
  page,
  backendSlot,
}) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.waitForFunction(() =>
    Boolean((window as any).appStores?.showTempo?.get()),
  );

  const controls = page.getByTestId("tempo-controls");
  const bpm = page.getByTestId("tempo-bpm");
  await expect(controls).toBeVisible();
  await expect(bpm).toHaveText("120");

  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Array.from(
            document.querySelectorAll(".nf-tempo-beat[data-active]"),
            (dot) => Array.from(dot.parentElement?.children ?? []).indexOf(dot),
          ).join(","),
        ),
      { timeout: 3_000 },
    )
    .not.toBe("0");

  const tap = page.getByTestId("tempo-tap");
  for (let index = 0; index < 6; index += 1) {
    await tap.dispatchEvent("pointerdown", { button: 0 });
    await page.waitForTimeout(400);
  }
  await expect
    .poll(() => targetBpm(page), { timeout: 5_000 })
    .toBeGreaterThan(140);
  await expect.poll(() => targetBpm(page)).toBeLessThan(160);
  await page
    .getByRole("region", { name: "Application status bar" })
    .screenshot({ path: "test-results/playwright/show-tempo-status-bar.png" });

  await page.getByRole("button", { name: "Tempo", exact: true }).click();
  const bpmInput = page.getByRole("spinbutton", { name: "Tempo in BPM" });
  await expect(bpmInput).toBeVisible();
  await bpmInput.fill("90");
  await bpmInput.press("Enter");
  await expect.poll(() => targetBpm(page)).toBe(90);
  await page.screenshot({
    path: "test-results/playwright/show-tempo-menu.png",
  });
  await page.getByRole("button", { name: "Increase tempo" }).click();
  await page.getByRole("button", { name: "Increase tempo" }).click();
  await expect(bpmInput).toHaveValue("92");
  await expect.poll(() => targetBpm(page)).toBe(92);
  await page.getByRole("button", { name: "Double time" }).click();
  await expect.poll(() => targetBpm(page)).toBe(184);
  await expect(bpm).toHaveText("184", { timeout: 5_000 });

  await runCommand(page, "tempo 128");
  await expect.poll(() => targetBpm(page)).toBe(128);
  await expect(bpm).toHaveText("128", { timeout: 5_000 });
  await runCommand(page, "tempo half");
  await expect.poll(() => targetBpm(page)).toBe(64);
});

/**
 * Verifies taps exactly 500 ms apart produce exactly 120 BPM: taps carry the
 * browser's own event time, so websocket delivery and engine frame timing must
 * not change the fitted tempo.
 */
test("evenly spaced taps fit the exact tempo", async ({
  page,
  backendSlot,
}) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.waitForFunction(() =>
    Boolean((window as any).appStores?.showTempo?.get()),
  );

  await page.evaluate(async () => {
    const tap = document.querySelector('[data-testid="tempo-tap"]');
    if (!tap) throw new Error("Tap button missing");
    const start = performance.now() + 100;
    for (let index = 0; index < 10; index += 1) {
      const due = start + index * 500;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, due - performance.now() - 5)),
      );
      while (performance.now() < due) {
        // Spin for the last few milliseconds so each tap fires on time.
      }
      tap.dispatchEvent(
        new PointerEvent("pointerdown", { button: 0, bubbles: true }),
      );
    }
  });

  await expect
    .poll(async () => Math.abs(((await targetBpm(page)) ?? 0) - 120), {
      timeout: 5_000,
    })
    .toBeLessThan(0.1);
});

/** Verifies the phone header carries the tempo readout and a working Tap button. */
test("compact header shows tempo controls on a phone", async ({
  page,
  backendSlot,
}) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await page.waitForFunction(() =>
    Boolean((window as any).appStores?.showTempo?.get()),
  );
  const header = page.getByRole("navigation", { name: "Global" });
  await expect(header.getByTestId("tempo-controls")).toBeVisible();
  const tap = header.getByTestId("tempo-tap");
  for (let index = 0; index < 5; index += 1) {
    await tap.dispatchEvent("pointerdown", { button: 0 });
    await page.waitForTimeout(500);
  }
  await expect
    .poll(() => targetBpm(page), { timeout: 5_000 })
    .toBeGreaterThan(110);
  await expect.poll(() => targetBpm(page)).toBeLessThan(130);
  await header.screenshot({
    path: "test-results/playwright/show-tempo-compact-header.png",
  });
});
