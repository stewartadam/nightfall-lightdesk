// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Shared setup for specs that drive real GDTF bench archives in the native
 * visualizer. Archives come from NIGHTFALL_GDTF_BENCH_DIR (see
 * docs/src/developer-reference/gdtf-regression-testing.md).
 */

import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TestInfo } from "@playwright/test";
import type { Fixture, FixtureGeometry } from "../types/index";
import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Directory holding the bench archives, when configured. */
export const benchDir = process.env.NIGHTFALL_GDTF_BENCH_DIR;

/** A bench archive and the library identity it registers under. */
export type BenchFixture = {
  file: string;
  make: string;
  model: string;
  mode: string;
};

/** Opens a blank show with the main-thread visualizer so scene nodes are inspectable. */
export async function openBenchVisualizer(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.goto(
    "/?startup:draftRecovery=false&visualizer:offscreenCanvas=false",
  );
  await waitForDockviewApp(page);
  await page
    .getByRole("tab", { name: "3D Visualizer", exact: true })
    .first()
    .click();
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).visualizerApi?.getScene()),
  );
  await page.addStyleTag({
    content:
      ".profiler-panel, .profiler-mini-panel { display: none !important; }",
  });
}

/**
 * Copies a bench archive into the test backend's library, creates a fixture
 * from it at 4 m height, and returns its UID once its geometry has arrived.
 */
export async function installBenchFixture(
  page: Page,
  dataDir: string,
  fixture: BenchFixture,
  id: number,
): Promise<string> {
  const fixturesDir = join(dataDir, "fixtures");
  await mkdir(fixturesDir, { recursive: true });
  await copyFile(
    join(benchDir as string, fixture.file),
    join(fixturesDir, fixture.file),
  );

  await expect
    .poll(
      () =>
        page.evaluate(
          async ({ make, model, mode, id }) => {
            const result = await (window as any).appStores.sendAndAwait({
              module: "FixtureLibraryCommand",
              command: {
                type: "CreateFixtureFromLibrary",
                data: {
                  id,
                  make,
                  model,
                  mode,
                  update_existing_ids: [],
                  update_existing_only: false,
                },
              },
            });
            return result.outcome.type;
          },
          { ...fixture, id },
        ),
      { timeout: 30_000 },
    )
    .toBe("Succeeded");

  const uid = await page.evaluate((id) => {
    const fixtures = (window as any).appStores.fixtures.get() as Record<
      string,
      Fixture
    >;
    return Object.values(fixtures).find((f) => f.identifiers.id === id)
      ?.identifiers.uid as unknown as string;
  }, id);
  const placed = await page.evaluate((uid) => {
    const fixture = (window as any).appStores.fixtures.get()[uid] as Fixture;
    return {
      ...fixture,
      placement: {
        position: { x: 0, y: 4, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
      },
    };
  }, uid);
  const stored = await page.evaluate(async (fixture) => {
    const result = await (window as any).appStores.sendAndAwait({
      module: "FixtureCommand",
      command: { type: "StoreFixture", data: fixture },
    });
    return result.outcome.type;
  }, placed);
  expect(stored).toBe("Succeeded");
  await expect
    .poll(() =>
      page.evaluate(
        (uid) =>
          Boolean(
            (window as any).visualizerApi
              ?.getScene()
              ?.getObjectByName(`Fixture_${uid}`),
          ),
        uid,
      ),
    )
    .toBe(true);
  return uid;
}

/** Submits a console command and waits for it to succeed. */
export async function submitCommand(
  page: Page,
  command: string,
): Promise<void> {
  const input = page.locator("#header-cmdline");
  await input.fill(command);
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect
    .poll(() =>
      page.evaluate((submitted) => {
        const entries =
          (window as any).appStores?.consoleScrollback?.get?.() ?? [];
        const last = entries
          .filter((entry: any) => entry.command === submitted)
          .at(-1);
        return last
          ? { errorMessage: last.errorMessage, status: last.status }
          : null;
      }, command),
    )
    .toEqual({ status: "success" });
}

/**
 * Returns the rendered emitter color (RGB after intensity) of every beam
 * node, keyed by the element controlling it.
 */
export async function emitterColors(
  page: Page,
  uid: string,
): Promise<Record<string, [number, number, number]>> {
  return page.evaluate((uid) => {
    const geometry = (window as any).appStores.fixtureGeometries.get()[
      uid
    ] as FixtureGeometry;
    const root = (window as any).visualizerApi
      .getScene()
      .getObjectByName(`Fixture_${uid}`);
    const colors: Record<string, [number, number, number]> = {};
    for (const node of geometry.nodes) {
      if (node.geometryType !== "beam" || !node.controlledElement) continue;
      const mesh = root.getObjectByName(`${node.name}_emitter`);
      if (!mesh) continue;
      const { r, g, b } = mesh.material.color;
      colors[node.controlledElement] = [r, g, b].map(
        (value: number) => Math.round(value * 1000) / 1000,
      ) as [number, number, number];
    }
    return colors;
  }, uid);
}

/**
 * Attaches a screenshot of the visualizer canvas from a fixed close-up
 * viewpoint of the fixture hanging at 4 m.
 */
export async function attachCanvas(
  page: Page,
  name: string,
  testInfo: TestInfo,
  camera = {
    position: { x: 1.1, y: 4.4, z: 1.4 },
    target: { x: 0, y: 3.8, z: 0 },
  },
): Promise<void> {
  await page.evaluate(
    (camera) => (window as any).visualizerApi.setCameraState(camera),
    camera,
  );
  // Let camera damping settle, then wait for two presented frames.
  await page.waitForTimeout(500);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const canvas = page.locator(
    '[data-panel-id="panel-Visualizer"] canvas[aria-label="3D visualizer viewport"]',
  );
  const path = testInfo.outputPath(`${name}.png`);
  await canvas.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}
