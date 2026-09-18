// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import {
  seedStartupShowfileName,
  waitForDockviewApp,
} from "./showfile-startup";

const inputSelector = "#header-cmdline";
const OVERLAP_FIXTURE_COMMAND = "fix 1010>1015 int @ 100 white @ 100";
const OVERLAP_FIXTURE_IDS = [1010, 1011, 1012, 1013, 1014, 1015];
const MIN_OVERLAP_FPS = 35;
const WEBGL_FALLBACK_MIN_OVERLAP_FPS = 1;
const WEBGL_FALLBACK_FPS_TOLERANCE = 0.25;
const VISUALIZER_SETTLE_MS = 2_000;
const BEAM_PREWARM_TIMEOUT_MS = 60_000;
const OVERLAP_SAMPLE_DURATION_MS = 10_000;
const OVERLAP_CAMERA_STATE = {
  position: {
    x: 1.3478854514673437,
    y: 1.777930884856271,
    z: 1.0092357994876489,
  },
  target: {
    x: -0.8303474024088636,
    y: 0,
    z: -5.690799773741937,
  },
};

test.setTimeout(180_000);

type OverlapSceneSample = {
  fps: number;
  visibleBeams: number;
};

/**
 * Opens the sample showfile with the main-thread high-quality visualizer active.
 */
async function openSampleHighQualityVisualizer(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.removeItem("nightfall-feature-flags");
  });
  await seedStartupShowfileName(page, "sample");
  await page.goto(
    "/?e2e=1&startup:draftRecovery=false&visualizer:beamQuality=high&visualizer:offscreenCanvas=false",
  );
  await waitForDockviewApp(page, { showfileName: "sample" });
  await activateVisualizerPanel(page);
  await expect(
    page.getByText("3D Visualizer", { exact: true }).first(),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator(inputSelector)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".fps-label")).toBeVisible({ timeout: 30_000 });
  await waitForSampleWashFixtures(page);
  await waitForBeamPrewarm(page);
}

/** Activates the 3D Visualizer panel so its canvas and FPS overlay are rendered. */
async function activateVisualizerPanel(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    let panel = api.getPanel("panel-Visualizer");
    if (!panel) {
      panel = api.addPanel({
        id: "panel-Visualizer",
        component: "Visualizer",
        title: "3D Visualizer",
        params: {},
      });
    }
    panel.api.setActive();
    panel.focus();
  });
}

/**
 * Reads fixture IDs visible to the browser stores.
 */
async function fixtureIds(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const fixtures = (window as any).appStores?.fixtures?.get?.() ?? {};
    return Object.values(fixtures)
      .map((fixture: any) => fixture?.identifiers?.id)
      .filter((id: unknown): id is number => typeof id === "number")
      .sort((a, b) => a - b);
  });
}

/**
 * Waits for the persisted sample showfile wash fixtures and scene API.
 */
async function waitForSampleWashFixtures(page: Page): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const ready = await page.evaluate((fixtureIdsToFind) => {
      const stores = (window as any).appStores;
      const api = (window as any).visualizerApi;
      const fixtures = Object.values(stores?.fixtures?.get?.() ?? {});
      return Boolean(
        api?.getScene?.() &&
          fixtureIdsToFind.every((id) =>
            fixtures.some((fixture: any) => fixture?.identifiers?.id === id),
          ),
      );
    }, OVERLAP_FIXTURE_IDS);
    if (ready) return;
    await page.waitForTimeout(250);
  }

  throw new Error(
    `Timed out waiting for sample wash fixtures ${OVERLAP_FIXTURE_IDS.join(
      ", ",
    )}; saw fixture IDs ${(await fixtureIds(page)).join(", ")}`,
  );
}

/**
 * Waits until invisible high-quality beam meshes have rendered once for pipeline prewarming.
 */
async function waitForBeamPrewarm(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const scene = (window as any).visualizerApi?.getScene?.();
          let pending = 0;
          scene?.traverse?.((object: any) => {
            if (object.userData?.beamPrewarmPending === true) {
              pending += 1;
            }
          });
          return pending;
        }),
      { timeout: BEAM_PREWARM_TIMEOUT_MS },
    )
    .toBe(0);
}

/**
 * Submits an operator command through the shared header command line.
 */
async function submitCommand(page: Page, command: string): Promise<void> {
  const input = page.locator(inputSelector);
  await input.fill(command);
  await input.press("Enter");
  await expect(input).toHaveValue("");
}

/**
 * Moves the camera close to the Generic fixture bases where high-quality beams overlap heavily.
 */
async function setBeamOverlapCamera(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).visualizerApi.setCameraState({
      position: {
        x: 1.3478854514673437,
        y: 1.777930884856271,
        z: 1.0092357994876489,
      },
      target: {
        x: -0.8303474024088636,
        y: 0,
        z: -5.690799773741937,
      },
    });
  });

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).visualizerApi.getCameraState()),
    )
    .toEqual(OVERLAP_CAMERA_STATE);
}

/** Counts high-quality beam meshes that are visible in the current visualizer scene. */
async function visibleBeamCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const scene = (window as any).visualizerApi?.getScene?.();
    let visibleBeams = 0;
    scene?.traverse?.((object: any) => {
      if (object.name?.startsWith?.("Beam_") && object.visible === true) {
        visibleBeams += 1;
      }
    });
    return visibleBeams;
  });
}

/** Waits until the overlap command has produced the expected visible beam load. */
async function waitForOverlapBeams(page: Page): Promise<void> {
  await expect
    .poll(() => visibleBeamCount(page), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(72);
}

/** Returns the FPS threshold appropriate for the browser renderer capability. */
async function overlapFpsThreshold(page: Page): Promise<number> {
  const hasWebGpuAdapter = await page.evaluate(async () => {
    const gpu = (navigator as any).gpu;
    if (!gpu?.requestAdapter) return false;
    return Boolean(await gpu.requestAdapter().catch(() => null));
  });
  return hasWebGpuAdapter ? MIN_OVERLAP_FPS : WEBGL_FALLBACK_MIN_OVERLAP_FPS;
}

/**
 * Samples visualizer FPS and beam visibility during the steady overlap window.
 */
async function sampleOverlapScene(
  page: Page,
  durationMs: number,
  intervalMs: number,
): Promise<OverlapSceneSample[]> {
  const samples: OverlapSceneSample[] = [];
  const start = Date.now();

  while (Date.now() - start < durationMs) {
    const sample = await page.evaluate(() => {
      const stats = (window as any).appStores.visualizerStats.get();
      return {
        fps: typeof stats?.fps === "number" ? stats.fps : 0,
        visibleBeams: 0,
      };
    });
    if (sample.fps > 0) {
      samples.push({
        ...sample,
        visibleBeams: await visibleBeamCount(page),
      });
    }
    await page.waitForTimeout(intervalMs);
  }

  return samples;
}

/**
 * Verifies high-quality overlapping wash beams stay above the known low-FPS failure range.
 */
test("high-quality Generic wash beam overlap view keeps acceptable FPS", async ({
  page,
}, testInfo) => {
  await openSampleHighQualityVisualizer(page);
  await setBeamOverlapCamera(page);
  await page.waitForTimeout(VISUALIZER_SETTLE_MS);
  await submitCommand(page, OVERLAP_FIXTURE_COMMAND);
  await waitForOverlapBeams(page);
  await page.waitForTimeout(VISUALIZER_SETTLE_MS);

  const overlapSamples = await sampleOverlapScene(
    page,
    OVERLAP_SAMPLE_DURATION_MS,
    250,
  );
  expect(overlapSamples.length).toBeGreaterThan(5);

  const fpsSamples = overlapSamples.map((sample) => sample.fps);
  const maxVisibleBeams = Math.max(
    ...overlapSamples.map((sample) => sample.visibleBeams),
  );
  const minFps = Math.min(...fpsSamples);
  const avgFps =
    fpsSamples.reduce((sum, fps) => sum + fps, 0) / fpsSamples.length;
  const medianFps = [...fpsSamples].sort((left, right) => left - right)[
    Math.floor(fpsSamples.length / 2)
  ];
  const minExpectedFps = await overlapFpsThreshold(page);
  const fpsTolerance =
    minExpectedFps === WEBGL_FALLBACK_MIN_OVERLAP_FPS
      ? WEBGL_FALLBACK_FPS_TOLERANCE
      : 0;
  const minAcceptedFps = minExpectedFps - fpsTolerance;

  await testInfo.attach("beam-overlap-fps.json", {
    body: JSON.stringify(
      {
        command: OVERLAP_FIXTURE_COMMAND,
        samples: fpsSamples.length,
        minFps,
        avgFps,
        medianFps,
        minExpectedFps,
        minAcceptedFps,
        maxVisibleBeams,
        overlapSamples,
        fpsSamples,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });

  expect(maxVisibleBeams).toBeGreaterThanOrEqual(72);
  expect(medianFps).toBeGreaterThanOrEqual(minAcceptedFps);
});
