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

test.setTimeout(120_000);

type LatencyMeasurement = {
  command: string;
  sceneElapsedMs: number;
  visualElapsedMs: number;
  firstFrameElapsedMs: number | null;
  visualFrames: number;
  maxFrameMs: number;
};

/**
 * Submits a command through the same command line path used by operators.
 */
async function submitCommand(page: Page, command: string): Promise<void> {
  const input = page.locator(inputSelector);
  await input.fill(command);
  await input.press("Enter");
  await expect(input).toHaveValue("");
}

/**
 * Waits for fixture and visualizer APIs needed by the latency reproduction.
 */
async function waitForVisualizerReady(page: Page): Promise<void> {
  await page
    .getByRole("tab", { name: "3D Visualizer", exact: true })
    .first()
    .click();
  const visualizerPanel = page.locator('[data-panel-id="panel-Visualizer"]');
  await expect(visualizerPanel).toBeVisible();
  await expect(visualizerPanel.locator("canvas").first()).toBeVisible();
  await expect(visualizerPanel.locator(".fps-label")).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const stores = (window as any).appStores;
          const api = (window as any).visualizerApi;
          return Boolean(
            stores?.fixtures?.get &&
              Object.keys(stores.fixtures.get()).length > 0 &&
              api?.getScene?.(),
          );
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
}

/**
 * Resolves a fixture uid by fixture id from the hydrated browser stores.
 */
async function fixtureUidById(page: Page, fixtureId: number): Promise<string> {
  return page.evaluate((id) => {
    const fixtures = (window as any).appStores.fixtures.get();
    const fixture = Object.values(fixtures).find(
      (item: any) => item.identifiers.id === id,
    ) as any;
    if (!fixture) throw new Error(`No fixture ${id}`);
    return fixture.identifiers.uid;
  }, fixtureId);
}

/** Waits for named renderer objects to exist beneath a fixture scene root. */
async function waitForFixtureSceneObjects(
  page: Page,
  fixtureUid: string,
  objectNames: readonly string[],
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        ({ names, uid }) => {
          const scene = (window as any).visualizerApi?.getScene?.();
          const root = scene?.getObjectByName?.(`Fixture_${uid}`);
          return Boolean(
            root && names.every((name) => root.getObjectByName?.(name)),
          );
        },
        { names: objectNames, uid: fixtureUid },
      ),
    )
    .toBe(true);
}

/** Places a fixture above the floor in a known hanging orientation. */
async function placeFixtureForFloorFootprint(
  page: Page,
  fixtureUid: string,
): Promise<void> {
  await page.evaluate((uid) => {
    const fixturesStore = (window as any).appStores.fixtures;
    const fixtureMap = fixturesStore.get();
    const fixture = fixtureMap[uid];
    if (!fixture) throw new Error(`No fixture ${uid}`);
    fixturesStore.set({
      ...fixtureMap,
      [uid]: {
        ...fixture,
        placement: {
          position: { x: 0, y: 5, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
        },
      },
    });
  }, fixtureUid);

  await expect
    .poll(() =>
      page.evaluate((uid) => {
        const scene = (window as any).visualizerApi.getScene();
        const root = scene?.getObjectByName?.(`Fixture_${uid}`);
        root?.updateMatrixWorld?.(true);
        return {
          directionY: -(root?.matrixWorld?.elements?.[5] ?? Number.NaN),
          worldY: root?.matrixWorld?.elements?.[13] ?? Number.NaN,
        };
      }, fixtureUid),
    )
    .toEqual({ directionY: -1, worldY: 5 });
}

/**
 * Reads the maximum RGB instance color for an LED tape fixture in the scene.
 */
async function ledTapeSceneLevel(
  page: Page,
  fixtureUid: string,
): Promise<number> {
  return page.evaluate((uid) => {
    const scene = (window as any).visualizerApi.getScene();
    const root = scene?.getObjectByName?.(`Fixture_${uid}`);
    const pixels = root?.getObjectByName?.("Pixels");
    const values = Array.from(pixels?.instanceColor?.array ?? []) as number[];
    return values.length > 0 ? Math.max(...values) : 0;
  }, fixtureUid);
}

/**
 * Reads whether the first moving-head beam is visibly enabled in the scene.
 */
async function movingHeadBeamVisible(
  page: Page,
  fixtureUid: string,
): Promise<boolean> {
  return page.evaluate((uid) => {
    const scene = (window as any).visualizerApi.getScene();
    const root = scene?.getObjectByName?.(`Fixture_${uid}`);
    const beam = root?.getObjectByName?.("Beam");
    return Boolean(beam?.visible && (beam.material?.opacity ?? 0) > 0.05);
  }, fixtureUid);
}

/**
 * Reads the synthetic moving-head floor footprint state from the visualizer scene.
 */
async function movingHeadFloorSpotStats(
  page: Page,
  fixtureUid: string,
): Promise<{
  visible: boolean;
  spotlightVisible: boolean;
  opacity: number;
  worldY: number;
  scaleX: number;
  scaleY: number;
}> {
  return page.evaluate((uid) => {
    const scene = (window as any).visualizerApi.getScene();
    const root = scene?.getObjectByName?.(`Fixture_${uid}`);
    const footprint = root?.getObjectByName?.("BeamFootprint");
    const spotLight = root?.getObjectByName?.("SpotLight");
    root?.updateMatrixWorld?.(true);
    const matrixWorld = footprint?.matrixWorld?.elements ?? [];
    return {
      visible: Boolean(footprint?.visible),
      spotlightVisible: Boolean(spotLight?.visible),
      opacity: footprint?.material?.opacity ?? 0,
      worldY: matrixWorld[13] ?? Number.NaN,
      scaleX: footprint?.scale?.x ?? 0,
      scaleY: footprint?.scale?.y ?? 0,
    };
  }, fixtureUid);
}

/**
 * Measures fixture-output-to-next-frame latency with pre-armed probes.
 *
 * Canvas pixel readback adds multi-second WebGL2 stalls in Playwright, so this
 * probe stops at the first browser frame after the visualizer scene mutation.
 */
async function measureVisualLatency(
  page: Page,
  command: string,
  mode: "led" | "beam",
  fixtureUid: string,
): Promise<LatencyMeasurement> {
  await page.evaluate(
    ({ mode: visualMode, uid }) => {
      const findDescriptor = (target: any, property: string) => {
        let cursor = target;
        while (cursor) {
          const descriptor = Object.getOwnPropertyDescriptor(cursor, property);
          if (descriptor) return descriptor;
          cursor = Object.getPrototypeOf(cursor);
        }
        return undefined;
      };

      const stores = (window as any).appStores;
      const scene = (window as any).visualizerApi.getScene();
      const root = scene?.getObjectByName?.(`Fixture_${uid}`);

      const probe = {
        received: null as number | null,
        sceneObserved: null as number | null,
        visualObserved: null as number | null,
        firstFrameAfterReceived: null as number | null,
        visualFrames: 0,
        maxFrameMs: 0,
        lastFrameTime: null as number | null,
        rafId: 0,
        restore: () => undefined,
      };
      const restoreCallbacks: Array<() => void> = [];

      const sampleFrame = (frameTime: number) => {
        if (probe.received != null && probe.firstFrameAfterReceived == null) {
          probe.firstFrameAfterReceived = performance.now();
        }
        if (probe.lastFrameTime != null && probe.received != null) {
          probe.maxFrameMs = Math.max(
            probe.maxFrameMs,
            frameTime - probe.lastFrameTime,
          );
        }
        probe.lastFrameTime = frameTime;
        if (
          probe.received != null &&
          probe.sceneObserved != null &&
          probe.visualObserved == null
        ) {
          probe.visualFrames += 1;
          probe.visualObserved = performance.now();
        }

        probe.rafId = requestAnimationFrame(sampleFrame);
      };
      probe.rafId = requestAnimationFrame(sampleFrame);
      restoreCallbacks.push(() => cancelAnimationFrame(probe.rafId));

      const originalTimestampSet = stores.parameterUpdateTimestamp.set.bind(
        stores.parameterUpdateTimestamp,
      );
      stores.parameterUpdateTimestamp.set = (value: number) => {
        const outputs = stores.getParametersImmediate().get(uid) ?? [];
        const activeKeys =
          visualMode === "led"
            ? ["Red"]
            : ["Intensity", "VirtualIntensity", "Red"];
        const fixtureIsActive = outputs.some((output: Record<string, number>) =>
          activeKeys.some((key) => (output[key] ?? 0) > 0.05),
        );
        if (probe.received == null && fixtureIsActive) {
          probe.received = performance.now();
          probe.lastFrameTime = null;
        }
        return originalTimestampSet(value);
      };
      restoreCallbacks.push(() => {
        stores.parameterUpdateTimestamp.set = originalTimestampSet;
      });

      if (visualMode === "led") {
        const pixels = root?.getObjectByName?.("Pixels");
        const instanceColor = pixels?.instanceColor;
        const values = Array.from(instanceColor?.array ?? []) as number[];
        if (values.length > 0 && Math.max(...values) > 0.05) {
          throw new Error("LED control fixture was already lit");
        }
        if (!instanceColor) throw new Error("LED instance colors not found");

        const originalOwnDescriptor = Object.getOwnPropertyDescriptor(
          instanceColor,
          "needsUpdate",
        );
        const originalDescriptor = findDescriptor(instanceColor, "needsUpdate");
        let currentNeedsUpdate = instanceColor.needsUpdate;

        Object.defineProperty(instanceColor, "needsUpdate", {
          configurable: true,
          get() {
            return originalDescriptor?.get
              ? originalDescriptor.get.call(instanceColor)
              : currentNeedsUpdate;
          },
          set(value) {
            if (value) {
              const colorValues = Array.from(
                instanceColor.array ?? [],
              ) as number[];
              if (
                probe.sceneObserved == null &&
                colorValues.length > 0 &&
                Math.max(...colorValues) > 0.05
              ) {
                probe.sceneObserved = performance.now();
              }
            }
            if (originalDescriptor?.set) {
              originalDescriptor.set.call(instanceColor, value);
            } else {
              currentNeedsUpdate = value;
            }
          },
        });

        restoreCallbacks.push(() => {
          if (originalOwnDescriptor) {
            Object.defineProperty(
              instanceColor,
              "needsUpdate",
              originalOwnDescriptor,
            );
          } else {
            delete instanceColor.needsUpdate;
          }
        });
      } else {
        const beam = root?.getObjectByName?.("Beam");
        const material = beam?.material;
        const intensityUniform = material?.beamIntensityUniform;
        const isLit = Boolean(
          beam?.visible &&
            ((intensityUniform?.value ?? 0) > 0.05 ||
              (material?.opacity ?? 0) > 0.05),
        );
        if (isLit) throw new Error("Beam fixture was already lit");
        if (!material || !intensityUniform) {
          throw new Error("Beam intensity uniform not found");
        }

        const originalOwnDescriptor = Object.getOwnPropertyDescriptor(
          intensityUniform,
          "value",
        );
        let currentIntensity = intensityUniform.value;

        Object.defineProperty(intensityUniform, "value", {
          configurable: true,
          get() {
            return currentIntensity;
          },
          set(value) {
            currentIntensity = value;
            if (probe.sceneObserved == null && currentIntensity > 0.05) {
              probe.sceneObserved = performance.now();
            }
          },
        });

        restoreCallbacks.push(() => {
          if (originalOwnDescriptor) {
            Object.defineProperty(
              intensityUniform,
              "value",
              originalOwnDescriptor,
            );
            intensityUniform.value = currentIntensity;
          } else {
            delete intensityUniform.value;
          }
        });
      }

      probe.restore = () => {
        for (const restore of restoreCallbacks.toReversed()) {
          restore();
        }
      };
      (window as any).__visualizerLagProbe = probe;
    },
    { mode, uid: fixtureUid },
  );

  await expect
    .poll(
      () => page.evaluate(() => Boolean((window as any).__visualizerLagProbe)),
      { timeout: 2_000 },
    )
    .toBe(true);

  const input = page.locator(inputSelector);
  await input.fill(command);
  await input.press("Enter");
  await expect(input).toHaveValue("");

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const probe = (window as any).__visualizerLagProbe;
          return probe?.received == null || probe?.visualObserved == null
            ? null
            : probe.visualObserved - probe.received;
        }),
      { timeout: 5_000 },
    )
    .not.toBeNull();

  const result = await page.evaluate(() => {
    const probe = (window as any).__visualizerLagProbe;
    const sceneElapsedMs =
      probe.sceneObserved == null ? null : probe.sceneObserved - probe.received;
    const visualElapsedMs = probe.visualObserved - probe.received;
    const firstFrameElapsedMs =
      probe.firstFrameAfterReceived == null
        ? null
        : probe.firstFrameAfterReceived - probe.received;
    const { visualFrames, maxFrameMs } = probe;
    probe.restore();
    delete (window as any).__visualizerLagProbe;
    return {
      sceneElapsedMs,
      visualElapsedMs,
      firstFrameElapsedMs,
      visualFrames,
      maxFrameMs,
    };
  });
  if (result.sceneElapsedMs == null) {
    throw new Error("scene mutation was not observed before visual change");
  }

  return { command, ...result, sceneElapsedMs: result.sceneElapsedMs };
}

/**
 * Reproduces fixture intensity visual lag with fixture 311 as the fast LED control.
 */
test("moving-head intensity visual latency is comparable to fix 311 LED control", async ({
  page,
}) => {
  await seedStartupShowfileName(page, "sample");
  await page.goto("/?visualizer:offscreenCanvas=false&e2e=1");
  await waitForDockviewApp(page, { showfileName: "sample" });
  await waitForVisualizerReady(page);

  await submitCommand(page, "fps 44");
  await submitCommand(page, "clear");
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as any).appStores.engineMetrics.get().fps ?? 0,
        ),
      {
        timeout: 10_000,
      },
    )
    .toBeGreaterThan(35);

  const ledUid = await fixtureUidById(page, 311);
  const movingHeadUid = await fixtureUidById(page, 501);
  await waitForFixtureSceneObjects(page, ledUid, ["Pixels"]);
  await waitForFixtureSceneObjects(page, movingHeadUid, [
    "Beam",
    "BeamFootprint",
  ]);
  await placeFixtureForFloorFootprint(page, movingHeadUid);

  await submitCommand(page, "clear");
  await expect.poll(() => ledTapeSceneLevel(page, ledUid)).toBeLessThan(0.05);

  const led = await measureVisualLatency(
    page,
    "fix 311 red @ 100",
    "led",
    ledUid,
  );

  await submitCommand(page, "clear");
  await expect
    .poll(() => movingHeadBeamVisible(page, movingHeadUid))
    .toBe(false);

  const beam = await measureVisualLatency(
    page,
    "fix 501.1 intensity @ 100 red @ 100 green @ 0 blue @ 0",
    "beam",
    movingHeadUid,
  );

  process.stdout.write(
    `visual latency: ${JSON.stringify({ led, beam }, null, 2)}\n`,
  );

  expect(led.sceneElapsedMs).toBeLessThan(80);
  expect(beam.sceneElapsedMs).toBeLessThan(80);
  expect(led.visualElapsedMs).toBeLessThan(250);
  expect(beam.visualElapsedMs).toBeLessThan(500);
  expect(beam.visualElapsedMs).toBeLessThan(led.visualElapsedMs + 350);
});

/**
 * Verifies moving-head beams render floor illumination without enabling a Three.js light.
 */
test("moving-head beam renders synthetic floor footprint without spotlight", async ({
  page,
}) => {
  await seedStartupShowfileName(page, "sample");
  await page.goto("/?visualizer:offscreenCanvas=false&e2e=1");
  await waitForDockviewApp(page, { showfileName: "sample" });
  await waitForVisualizerReady(page);

  const movingHeadUid = await fixtureUidById(page, 501);
  await waitForFixtureSceneObjects(page, movingHeadUid, [
    "Beam",
    "BeamFootprint",
  ]);
  await placeFixtureForFloorFootprint(page, movingHeadUid);

  await submitCommand(page, "clear");
  await expect
    .poll(() => movingHeadBeamVisible(page, movingHeadUid))
    .toBe(false);
  await submitCommand(
    page,
    "fix 501.1 pan @ 0 tilt @ 0 intensity @ 100 red @ 100 green @ 0 blue @ 0",
  );
  await expect
    .poll(() => movingHeadBeamVisible(page, movingHeadUid))
    .toBe(true);

  await expect
    .poll(() => movingHeadFloorSpotStats(page, movingHeadUid))
    .toMatchObject({
      visible: true,
      spotlightVisible: false,
    });

  const stats = await movingHeadFloorSpotStats(page, movingHeadUid);
  expect(stats.opacity).toBeGreaterThan(0.05);
  expect(stats.worldY).toBeGreaterThan(0);
  expect(stats.worldY).toBeLessThan(0.02);
  expect(stats.scaleX).toBeGreaterThan(0);
  expect(stats.scaleY).toBeGreaterThan(0);
});
