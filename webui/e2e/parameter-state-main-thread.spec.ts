// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.use({ sampleDataOnly: true });

/** Main-thread scopes that handle each parameter state delivery. */
const SCOPES = [
  "websocket-main.parameter-state.unpack",
  "websocket-main.parameter-state.immediate-params",
  "websocket-main.parameter-state.process",
  "websocket-main.parameter-state.store-set",
  "visualizer.dmx-snapshot.rebuild",
];

/** Submits a command through the header command line. */
async function submitCommand(page: Page, command: string): Promise<void> {
  const input = page.locator("#header-cmdline");
  await input.fill(command);
  await input.press("Enter");
  await expect(input).toHaveValue("");
}

/**
 * Records every parameter scope measure into a page global, alongside the app's own collector,
 * which clears measures from the performance timeline as it reads them.
 */
async function observeMeasures(page: Page): Promise<void> {
  await page.evaluate(() => {
    const recorded: Record<string, number[]> = {};
    (window as any).__parameterMeasures = recorded;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntriesByType("measure")) {
        recorded[entry.name] ??= [];
        recorded[entry.name].push(entry.duration);
      }
    }).observe({ type: "measure" });
  });
}

/** Forgets the durations recorded so far, starting a new measurement window. */
async function clearMeasures(page: Page): Promise<void> {
  await page.evaluate(() => {
    const recorded = (window as any).__parameterMeasures;
    for (const name of Object.keys(recorded)) delete recorded[name];
  });
}

/** Summarizes each parameter scope's recorded durations as count, median, p95 and total ms. */
async function summarizeMeasures(page: Page) {
  return page.evaluate((scopes) => {
    const recorded: Record<string, number[]> = (window as any)
      .__parameterMeasures;
    const summary: Record<string, Record<string, number>> = {};
    for (const scope of scopes) {
      const durations = [...(recorded[`nightfall:${scope}`] ?? [])].sort(
        (a, b) => a - b,
      );
      const at = (q: number) =>
        durations[
          Math.min(durations.length - 1, Math.floor(durations.length * q))
        ] ?? 0;
      summary[scope] = {
        count: durations.length,
        medianMs: Number(at(0.5).toFixed(3)),
        p95Ms: Number(at(0.95).toFixed(3)),
        totalMs: Number(durations.reduce((sum, d) => sum + d, 0).toFixed(1)),
      };
    }
    return summary;
  }, SCOPES);
}

/**
 * Characterizes main-thread time spent on parameter state while one fixture changes and while a
 * sequence plays across the sample show, with the 3D visualizer open. Opt-in, since timings
 * depend on the machine; the summary is printed and attached for before/after comparisons.
 */
test("measures main-thread parameter state handling", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.NIGHTFALL_PARAMETER_PERF !== "1",
    "Opt-in main-thread timing characterization",
  );
  testInfo.setTimeout(90_000);
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.keys((window as any).appStores?.sequences?.get?.() ?? {})
            .length,
      ),
    )
    .toBeGreaterThan(0);
  await page
    .getByRole("tab", { name: "3D Visualizer", exact: true })
    .first()
    .click();
  await expect(
    page.locator('[data-panel-id="panel-Visualizer"] canvas').first(),
  ).toBeVisible();
  await page.waitForTimeout(2_000);
  await observeMeasures(page);
  const fixtureCount = await page.evaluate(
    () => Object.keys((window as any).appStores.fixtures.get()).length,
  );

  await clearMeasures(page);
  for (let step = 1; step <= 40; step++) {
    await submitCommand(page, `fix 601 int @ ${(step * 37) % 100}`);
    await page.waitForTimeout(100);
  }
  const oneFixture = await summarizeMeasures(page);

  await page.evaluate(() =>
    (window as any).appStores.sendAndAwait({
      module: "ClipCommand",
      command: { type: "StartClip", data: { type: "Single", data: 21 } },
    }),
  );
  await page.waitForTimeout(1_000);
  await clearMeasures(page);
  await page.waitForTimeout(6_000);
  const sequence = await summarizeMeasures(page);
  await page.evaluate(() =>
    (window as any).appStores.sendAndAwait({
      module: "ClipCommand",
      command: { type: "StopClip", data: { type: "Single", data: 21 } },
    }),
  );

  const result = { fixtureCount, oneFixture, sequence };
  // Debug
  console.log(`parameter-state-main-thread ${JSON.stringify(result)}`);
  await testInfo.attach("parameter-state-main-thread.json", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  expect(oneFixture[SCOPES[0]].count).toBeGreaterThan(0);
});
