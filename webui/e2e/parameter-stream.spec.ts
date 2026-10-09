// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Locator, type Page, test } from "./playwright-fixtures";
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
 * Scrolls a switch clear of the dialog's blurred scroll edges, which reject clicks beneath them,
 * and clicks it once no visible edge covers its center.
 */
async function clickSwitch(toggle: Locator): Promise<void> {
  await expect
    .poll(() =>
      toggle.evaluate((element) => {
        element.scrollIntoView({ block: "center" });
        const box = element.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        return [
          ...document.querySelectorAll('.nf-scroll-edge[data-visible="true"]'),
        ].some((edge) => {
          const cover = edge.getBoundingClientRect();
          return (
            x >= cover.left &&
            x < cover.right &&
            y >= cover.top &&
            y < cover.bottom
          );
        });
      }),
    )
    .toBe(false);
  await toggle.click();
}

/**
 * Reports whether the UI's parameter state shows some element with an absolute percent
 * assertion of `attribute` at `fraction`, meaning the engine has applied that command.
 */
async function programmerHolds(
  page: Page,
  attribute: string,
  fraction: number,
): Promise<boolean> {
  return page.evaluate(
    ({ attribute, fraction }) => {
      const rows = (window as any).appStores.parameters.get();
      for (const row of rows.values()) {
        for (const element of row.elements ?? []) {
          const value = element.absolute?.[attribute];
          if (
            value?.type === "AbsolutePercent" &&
            Math.abs(value.data.value - fraction) < 1e-4
          ) {
            return true;
          }
        }
      }
      return false;
    },
    { attribute, fraction },
  );
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

  // The engine can still be working through the commands, and fades keep changing output after
  // the last one, so compare only once the final values are asserted and output has settled.
  await expect
    .poll(() => programmerHolds(page, "Red", 0.48), { timeout: 15_000 })
    .toBe(true);
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
  // The switch follows the backend snapshot, which would undo a click made before it arrives.
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.settings.get().parameter_keyframes_only,
      ),
    )
    .toBe(false);

  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("tab", { name: "Network", exact: true }).click();
  const changedOnly = dialog.getByRole("switch", {
    name: "Send only changed parameters (recommended)",
  });
  await expect(changedOnly).toBeChecked();
  await clickSwitch(changedOnly);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.settings.get().parameter_keyframes_only,
      ),
    )
    .toBe(true);
  await expect(changedOnly).not.toBeChecked();
  await changedOnly.evaluate((element) => {
    const viewport = element.closest(".nf-scroll-viewport");
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  });
  await expect(
    dialog.locator('.nf-scroll-edge[data-edge="bottom"][data-visible="true"]'),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("keyframes-only-setting.png"),
    animations: "disabled",
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
  await clickSwitch(changedOnly);
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
