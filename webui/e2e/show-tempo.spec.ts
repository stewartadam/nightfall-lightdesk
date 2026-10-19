// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { openPanel } from "./controller-mapping";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
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
 * Opens a fresh show, waits for the engine's first tempo report and opens the
 * Tempo panel from the command palette.
 */
async function openTempoPanel(
  page: Page,
  backendPort: number,
): Promise<Locator> {
  await prepareFreshBackendShowfile(backendPort);
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.waitForFunction(() =>
    Boolean((window as any).appStores?.showTempo?.get()),
  );
  await openPanel(page, "Tempo");
  const panel = page.getByTestId("tempo-panel");
  await expect(panel).toBeVisible();
  return panel;
}

/**
 * Verifies the Tempo panel follows the engine: tapping sets the tempo, the
 * fields, toolbar actions and the `tempo` command change it, and the beat
 * indicator animates.
 */
test("tempo panel responds to taps, its fields and the command line", async ({
  page,
  backendSlot,
}) => {
  const panel = await openTempoPanel(page, backendSlot.backendPort);
  const bpm = panel.getByTestId("tempo-bpm");
  await expect(bpm).toHaveText("120");
  await expect(
    page.getByRole("region", { name: "Application status bar" }),
  ).not.toContainText("BPM");

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

  const tap = panel.getByTestId("tempo-tap");
  for (let index = 0; index < 6; index += 1) {
    await tap.dispatchEvent("pointerdown", { button: 0 });
    await page.waitForTimeout(400);
  }
  await expect
    .poll(() => targetBpm(page), { timeout: 5_000 })
    .toBeGreaterThan(140);
  await expect.poll(() => targetBpm(page)).toBeLessThan(160);
  await page.screenshot({ path: "test-results/playwright/tempo-panel.png" });

  const bpmInput = panel.getByRole("spinbutton", { name: "Tempo in BPM" });
  await bpmInput.fill("90");
  await bpmInput.press("Enter");
  await expect.poll(() => targetBpm(page)).toBe(90);
  await panel.getByRole("button", { name: "Increase tempo" }).click();
  await panel.getByRole("button", { name: "Increase tempo" }).click();
  await expect(bpmInput).toHaveValue("92");
  await expect.poll(() => targetBpm(page)).toBe(92);
  await panel.getByRole("button", { name: "Double time" }).click();
  await expect.poll(() => targetBpm(page)).toBe(184);
  await expect(bpm).toHaveText("184", { timeout: 5_000 });
  await expect(bpmInput).toHaveValue("184");

  await bpmInput.fill("1");
  await page.waitForTimeout(800);
  await expect(bpmInput).toHaveValue("1");
  await bpmInput.blur();
  await expect(bpmInput).toHaveValue("184");
  expect(await targetBpm(page)).toBe(184);

  const beatsPerBar = panel.getByRole("spinbutton", { name: "Beats per bar" });
  await panel.getByRole("button", { name: "Fewer beats per bar" }).click();
  await expect(beatsPerBar).toHaveValue("3");
  await expect(panel.locator(".nf-tempo-beat")).toHaveCount(3, {
    timeout: 5_000,
  });

  await runCommand(page, "tempo 128");
  await expect.poll(() => targetBpm(page)).toBe(128);
  await expect(bpm).toHaveText("128", { timeout: 5_000 });
  await expect(bpmInput).toHaveValue("128");
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
  await openTempoPanel(page, backendSlot.backendPort);

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

/** Verifies a phone opens the Tempo panel and taps it, with no tempo in the header. */
test("tempo panel works on a phone", async ({ page, backendSlot }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = await openTempoPanel(page, backendSlot.backendPort);
  const header = page.getByRole("navigation", { name: "Global" });
  await expect(header).not.toContainText("BPM");
  const tap = panel.getByTestId("tempo-tap");
  for (let index = 0; index < 5; index += 1) {
    await tap.dispatchEvent("pointerdown", { button: 0 });
    await page.waitForTimeout(500);
  }
  await expect
    .poll(() => targetBpm(page), { timeout: 5_000 })
    .toBeGreaterThan(110);
  await expect.poll(() => targetBpm(page)).toBeLessThan(130);
  await page.screenshot({
    path: "test-results/playwright/tempo-panel-phone.png",
  });
});
