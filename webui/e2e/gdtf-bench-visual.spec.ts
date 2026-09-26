// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Visual and numeric checks of real GDTF bench archives in the native visualizer.
 *
 * Manufacturer archives cannot be committed, so this suite runs only when
 * NIGHTFALL_GDTF_BENCH_DIR points at a directory holding the bench archives.
 * When it is set, a missing archive fails the test rather than skipping it.
 */

import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Fixture, FixtureGeometry } from "../types/index";
import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const benchDir = process.env.NIGHTFALL_GDTF_BENCH_DIR;

test.skip(!benchDir, "NIGHTFALL_GDTF_BENCH_DIR is not set");
test.describe.configure({ timeout: 180_000 });

// Stop any running playback left behind so it does not affect later tests.
test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await submitCommand(page, "clear").catch(() => {});
});

/** A bench archive and the library identity it registers under. */
type BenchFixture = {
  file: string;
  make: string;
  model: string;
  mode: string;
};

const SHARPY: BenchFixture = {
  file: "Clay_Paky@Sharpy@ClayPaky_Official_File_Fw_Ver_2_25_006.gdtf",
  make: "Clay Paky",
  model: "Sharpy",
  mode: "Standard",
};
const HYDRABEAM: BenchFixture = {
  file: "Cameo@Hydrabeam_400@1.0.0.3.gdtf",
  make: "Cameo",
  model: "HYDRABEAM 100 RGBW",
  mode: "19 CH",
};
const MAGIC_PANEL: BenchFixture = {
  file: "Ayrton@MagicPanel_FX@V2.62_Corrected_PanTilt_Rotate.gdtf",
  make: "Ayrton",
  model: "MagicPanel FX",
  mode: "Extended",
};
const STATIC_BENCH: BenchFixture[] = [
  {
    file: "Martin_Professional@MAC_Aura@20230201NoMeas.gdtf",
    make: "Martin Professional",
    model: "MAC Aura",
    mode: "Extended",
  },
  {
    file: "ACME@Pixel_Line_IP@Release-05.gdtf",
    make: "ACME",
    model: "Pixel Line IP",
    mode: "117 Channel",
  },
  {
    file: "Astera_LED_Technology@FP1_Titan_Tube@tested_by_Astera__V3.gdtf",
    make: "Astera LED Technology",
    model: "FP1 Titan Tube",
    mode: "41: RGB*RGB*",
  },
];

/** Opens a blank show with the main-thread visualizer so scene nodes are inspectable. */
test.beforeEach(async ({ backendSlot, page }) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
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
});

/**
 * Copies a bench archive into the test backend's library, creates a fixture
 * from it at 4 m height, and returns its UID once its geometry has arrived.
 */
async function installBenchFixture(
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
async function submitCommand(page: Page, command: string): Promise<void> {
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

/** Returns world beam directions (local -Z) of every emitting beam node, keyed by node name. */
async function beamDirections(
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
    root.updateMatrixWorld(true);
    const directions: Record<string, [number, number, number]> = {};
    for (const node of geometry.nodes) {
      if (node.geometryType !== "beam" || !node.controlledElement) continue;
      const object = root.getObjectByName(node.name);
      if (!object) continue;
      const rotation = object.quaternion.clone();
      object.getWorldQuaternion(rotation);
      const direction = object.position.clone().set(0, 0, -1);
      direction.applyQuaternion(rotation);
      directions[node.name] = direction
        .toArray()
        .map((value: number) => Number(value.toFixed(3)) + 0);
    }
    return directions;
  }, uid);
}

/**
 * Returns how many archive meshes are still missing: nodes whose model names a
 * mesh file the archive provides but which still show a primitive fallback.
 */
async function missingMeshCount(page: Page, uid: string): Promise<number> {
  return page.evaluate((uid) => {
    const geometry = (window as any).appStores.fixtureGeometries.get()[
      uid
    ] as FixtureGeometry;
    const resources = geometry.meshResources ?? {};
    const root = (window as any).visualizerApi
      .getScene()
      .getObjectByName(`Fixture_${uid}`);
    return geometry.nodes.filter((node) => {
      // Emitting beams render as emitter meshes rather than archive models.
      if (node.geometryType === "beam" && node.controlledElement) return false;
      const file = node.model?.meshFile;
      if (!file || !resources[file]) return false;
      return !root.getObjectByName(`${node.name}_mesh`);
    }).length;
  }, uid);
}

/**
 * Attaches a screenshot of the visualizer canvas from a fixed close-up
 * viewpoint of the fixture hanging at 4 m, so captures are comparable.
 */
async function attachCanvas(
  page: Page,
  name: string,
  testInfo: import("@playwright/test").TestInfo,
): Promise<void> {
  await page.evaluate(() =>
    (window as any).visualizerApi.setCameraState({
      position: { x: 1.1, y: 4.4, z: 1.4 },
      target: { x: 0, y: 3.8, z: 0 },
    }),
  );
  await page.waitForTimeout(500);
  const canvas = page.locator(
    '[data-panel-id="panel-Visualizer"] canvas[aria-label="3D visualizer viewport"]',
  );
  const path = testInfo.outputPath(`${name}.png`);
  await canvas.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

/** Verifies the Sharpy hangs its beam downward and tilts it about the head. */
test("Sharpy beam hangs down at rest and tilts to horizontal", async ({
  page,
  backendSlot,
}, testInfo) => {
  const uid = await installBenchFixture(page, backendSlot.dataDir, SHARPY, 1);

  await submitCommand(page, "fix 1 int @ 100");
  await expect
    .poll(async () => Object.values(await beamDirections(page, uid)))
    .toEqual([[0, -1, 0]]);
  await expect.poll(() => missingMeshCount(page, uid)).toBe(0);
  await attachCanvas(page, "sharpy-rest", testInfo);

  await submitCommand(page, "fix 1 tilt @ 50");
  // The rendered tilt must equal the engine's logical tilt output in degrees.
  const tiltOutput = async () =>
    page.evaluate((uid) => {
      const fixture = (window as any).appStores.fixtures.get()[uid] as Fixture;
      const index = fixture.elements.findIndex((element) =>
        element.parameters.some((p) => p.attribute.type === "Tilt"),
      );
      return (window as any).appStores.getParametersImmediate().get(uid)?.[
        index
      ]?.Tilt as number | undefined;
    }, uid);
  await expect.poll(tiltOutput).not.toBe(0);
  const expectedDegrees = Math.abs((await tiltOutput()) ?? 0);
  await expect
    .poll(async () => {
      const [direction] = Object.values(await beamDirections(page, uid));
      const fromDown = (Math.acos(-(direction?.[1] ?? -1)) * 180) / Math.PI;
      return Math.abs(fromDown - expectedDegrees) < 1;
    })
    .toBe(true);
  testInfo.annotations.push({
    type: "tilt-degrees",
    description: `${expectedDegrees}`,
  });
  await attachCanvas(page, "sharpy-tilted", testInfo);
  await submitCommand(page, "clear");
});

/** Verifies moving one Hydrabeam head leaves its sibling heads' beams unchanged. */
test("Hydrabeam heads tilt independently", async ({
  page,
  backendSlot,
}, testInfo) => {
  const uid = await installBenchFixture(
    page,
    backendSlot.dataDir,
    HYDRABEAM,
    2,
  );
  await page.waitForTimeout(1500);
  await attachCanvas(page, "hydrabeam-body", testInfo);
  const tiltElement = await page.evaluate((uid) => {
    const fixture = (window as any).appStores.fixtures.get()[uid] as Fixture;
    return (
      fixture.elements.findIndex((element) =>
        element.parameters.some(
          (parameter) => parameter.attribute.type === "Tilt",
        ),
      ) + 1
    );
  }, uid);
  expect(tiltElement).toBeGreaterThan(0);

  await submitCommand(page, "fix 2 int @ 100");
  await expect
    .poll(async () => Object.keys(await beamDirections(page, uid)).length)
    .toBeGreaterThan(1);
  const rest = await beamDirections(page, uid);
  await attachCanvas(page, "hydrabeam-rest", testInfo);

  await submitCommand(page, `fix 2.${tiltElement} tilt @ 60`);
  const changedBeams = async () => {
    const moved = await beamDirections(page, uid);
    return Object.keys(moved).filter(
      (name) => JSON.stringify(moved[name]) !== JSON.stringify(rest[name]),
    );
  };
  await expect
    .poll(async () => (await changedBeams()).length)
    .toBeGreaterThan(0);
  const changed = await changedBeams();
  testInfo.annotations.push({
    type: "moved-beams",
    description: changed.join(", "),
  });
  expect(changed.length).toBeLessThan(Object.keys(rest).length);
  await attachCanvas(page, "hydrabeam-one-head-tilted", testInfo);
  await submitCommand(page, "clear");
});

/** Verifies every MagicPanel pixel instance renders an emitter. */
test("MagicPanel expands its referenced pixels", async ({
  page,
  backendSlot,
}, testInfo) => {
  const uid = await installBenchFixture(
    page,
    backendSlot.dataDir,
    MAGIC_PANEL,
    3,
  );
  await page.waitForTimeout(1500);
  await attachCanvas(page, "magicpanel-body", testInfo);
  await submitCommand(page, "fix 3 int @ 100 red @ 100 green @ 50");
  await expect
    .poll(async () => Object.keys(await beamDirections(page, uid)).length)
    .toBeGreaterThanOrEqual(25);
  await page.waitForTimeout(1500);
  await attachCanvas(page, "magicpanel-lit", testInfo);
  await submitCommand(page, "clear");
});

for (const fixture of STATIC_BENCH) {
  /** Captures the bench fixture lit at full so reviewers can inspect geometry and emitters. */
  test(`${fixture.model} renders its bench mode`, async ({
    page,
    backendSlot,
  }, testInfo) => {
    const uid = await installBenchFixture(
      page,
      backendSlot.dataDir,
      fixture,
      10,
    );
    await expect.poll(() => missingMeshCount(page, uid)).toBe(0);
    await page.waitForTimeout(1000);
    await attachCanvas(page, `${fixture.model}-body`, testInfo);
    await submitCommand(
      page,
      "fix 10 int @ 100 red @ 100 green @ 100 blue @ 100",
    );
    await expect
      .poll(async () => Object.keys(await beamDirections(page, uid)).length)
      .toBeGreaterThan(0);
    await page.waitForTimeout(1500);
    await attachCanvas(page, `${fixture.model}-lit`, testInfo);
    await submitCommand(page, "clear");
  });
}
