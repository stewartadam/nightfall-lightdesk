// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.use({ sampleDataOnly: true });

/** Submits a command through the header command line. */
async function submitCommand(page: Page, command: string): Promise<void> {
  const input = page.locator("#header-cmdline");
  await input.fill(command);
  await input.press("Enter");
  await expect(input).toHaveValue("");
}

/** Reads the worker's cumulative parameter stream counters from the latest stats message. */
async function streamStats(page: Page) {
  return page.evaluate(
    () => (window as any).appStores.wsStats.get()?.worker.parameterStream,
  );
}

/** Serializes every fixture's output values the UI currently holds, in a stable order. */
async function outputSnapshot(page: Page): Promise<string> {
  return page.evaluate(() => {
    const outputs: Map<string, Record<string, number>[]> = (
      window as any
    ).appStores.getParametersImmediate();
    return JSON.stringify(
      [...outputs.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([uid, elements]) => [
          uid,
          elements.map((element) =>
            Object.entries(element).sort(([a], [b]) => a.localeCompare(b)),
          ),
        ]),
    );
  });
}

/**
 * Verifies the UI keeps exact parameter state from deltas: while values change across several
 * keyframe intervals the worker applies deltas without gaps or drift, verifiable keyframes agree
 * with the rebuilt state, and the state rebuilt from deltas equals a fresh full resync.
 */
test("parameter deltas keep the UI exact", async ({ page }, testInfo) => {
  testInfo.setTimeout(60_000);
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await expect.poll(() => streamStats(page)).toBeDefined();

  for (let step = 1; step <= 16; step++) {
    await submitCommand(page, `fix 601 int @ ${(step * 37) % 100}`);
    await submitCommand(page, `fix 601 red @ ${(step * 53) % 100}`);
    await page.waitForTimeout(300);
  }

  await expect
    .poll(async () => (await streamStats(page))?.verifiedKeyframes ?? 0, {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);
  const stats = await streamStats(page);
  expect(stats.deltas).toBeGreaterThan(0);
  expect(stats.gaps).toBe(0);
  expect(stats.driftedKeyframes).toBe(0);

  // Fades keep changing output after the last command, so compare only once it has settled.
  let rebuilt = await outputSnapshot(page);
  await expect
    .poll(
      async () => {
        const previous = rebuilt;
        rebuilt = await outputSnapshot(page);
        return rebuilt === previous;
      },
      { intervals: [500], timeout: 15_000 },
    )
    .toBe(true);
  await page.evaluate(() =>
    (
      window as any
    ).__nightfallTest.runtime.engineRuntime.requestBackendSessionState(),
  );
  await expect
    .poll(async () => (await streamStats(page))?.keyframes ?? 0)
    .toBeGreaterThan(stats.keyframes);
  await page.waitForTimeout(500);
  expect(await outputSnapshot(page)).toBe(rebuilt);
  testInfo.attach("parameter-stream-stats.json", {
    body: JSON.stringify(await streamStats(page), null, 2),
    contentType: "application/json",
  });
});

/**
 * Verifies the Network settings toggle switches the engine to sending every value in full each
 * frame, so the UI receives keyframes and no deltas while values change, and that turning it back
 * on resumes deltas.
 */
test("keyframes-only setting sends full frames", async ({ page }, testInfo) => {
  testInfo.setTimeout(60_000);
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await expect.poll(() => streamStats(page)).toBeDefined();

  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("tab", { name: "Network", exact: true }).click();
  const changedOnly = dialog.getByRole("checkbox", {
    name: "Send only changed values",
  });
  await expect(changedOnly).toBeChecked();
  await changedOnly.uncheck();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.settings.get().parameter_keyframes_only,
      ),
    )
    .toBe(true);
  await expect(changedOnly).not.toBeChecked();
  await dialog.screenshot({
    path: testInfo.outputPath("keyframes-only-setting.png"),
  });
  await page.keyboard.press("Escape");

  const before = await streamStats(page);
  for (let step = 1; step <= 6; step++) {
    await submitCommand(page, `fix 601 int @ ${(step * 37) % 100}`);
    await page.waitForTimeout(200);
  }
  const during = await streamStats(page);
  expect(during.deltas).toBe(before.deltas);
  expect(during.keyframes).toBeGreaterThan(before.keyframes);
  expect(during.gaps).toBe(0);
  expect(during.driftedKeyframes).toBe(0);

  await page.keyboard.press("ControlOrMeta+,");
  await dialog.getByRole("tab", { name: "Network", exact: true }).click();
  await changedOnly.check();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.settings.get().parameter_keyframes_only,
      ),
    )
    .toBe(false);
  await page.keyboard.press("Escape");
  for (let step = 1; step <= 6; step++) {
    await submitCommand(page, `fix 601 int @ ${(step * 53) % 100}`);
    await page.waitForTimeout(200);
  }
  expect((await streamStats(page)).deltas).toBeGreaterThan(during.deltas);
});
