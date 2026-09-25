// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Checks that real GDTF bench archives render channel semantics the way the
 * fixture evaluates them: relations, mode masters and physical values.
 * Runs only when NIGHTFALL_GDTF_BENCH_DIR is set.
 */

import type { Fixture } from "../types/index";
import {
  attachCanvas,
  type BenchFixture,
  benchDir,
  emitterColors,
  installBenchFixture,
  openBenchVisualizer,
  submitCommand,
} from "./gdtf-bench-support";
import { expect, test } from "./playwright-fixtures";

test.skip(!benchDir, "NIGHTFALL_GDTF_BENCH_DIR is not set");
test.describe.configure({ timeout: 180_000 });

/** Pixel bar whose pixel colors follow virtual pixel and plate dimmers. */
const PIXEL_LINE: BenchFixture = {
  file: "ACME@Pixel_Line_IP@Release-05.gdtf",
  make: "ACME",
  model: "Pixel Line IP",
  mode: "117 Channel",
};

test.beforeEach(async ({ backendSlot, page }) => {
  await openBenchVisualizer(page, backendSlot.backendPort);
});

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await submitCommand(page, "clear").catch(() => {});
});

/**
 * Verifies the console multiplies pixel colors by their virtual pixel and
 * plate dimmers, and the visualizer lights pixels from that output and the
 * body dimmer without dimming them twice.
 */
test("Pixel Line virtual dimmer chain scales pixel output", async ({
  page,
  backendSlot,
}, testInfo) => {
  const uid = await installBenchFixture(
    page,
    backendSlot.dataDir,
    PIXEL_LINE,
    1,
  );
  // The first RGB pixel element: its red follows its own virtual dimmer.
  const pixel = await page.evaluate((uid) => {
    const fixture = (window as any).appStores.fixtures.get()[uid] as Fixture;
    const index = fixture.elements.findIndex((element) =>
      element.parameters.some((p) => p.attribute.type === "Red"),
    );
    return { index, label: fixture.elements[index].label };
  }, uid);
  const redOutput = () =>
    page.evaluate(
      ({ uid, index }) =>
        (window as any).appStores.getParametersImmediate().get(uid)?.[index]
          ?.Red as number | undefined,
      { uid, index: pixel.index },
    );

  await submitCommand(page, "fix 1 int @ 100");
  await submitCommand(page, "fix 1 red @ 100");
  await expect.poll(redOutput).toBeCloseTo(255, 0);
  await expect
    .poll(async () => (await emitterColors(page, uid))[pixel.label]?.[0])
    .toBeCloseTo(1, 2);
  await attachCanvas(page, "pixel-line-full", testInfo);

  // Body, plate and pixel dimmers all at half: the console output of red is
  // red × pixel × plate, and the body dimmer halves it again on the fixture.
  await submitCommand(page, "fix 1 int @ 50");
  await expect.poll(redOutput).toBeCloseTo(255 * 0.25, 0);
  await expect
    .poll(async () => (await emitterColors(page, uid))[pixel.label]?.[0])
    .toBeCloseTo(0.125, 2);
  await attachCanvas(page, "pixel-line-half", testInfo);
});
