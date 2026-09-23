// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { inflateSync } from "node:zlib";
import {
  type Attribute,
  DmxValueResolution,
  type Fixture,
  type FixtureCommand,
  FixtureLayout,
  type FixtureLibraryCommand,
  type FixturePlacement,
  MergeStrategy,
  type ParameterMetadata,
} from "../types/index";
import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const inputSelector = "#header-cmdline";
const rendererErrors = new WeakMap<Page, string[]>();

/** Retains GPU diagnostics even when a failed pipeline still draws emissive pixels. */
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  rendererErrors.set(page, errors);
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /THREE\.|WebGPU|GPUValidationError|Tint/.test(message.text())
    ) {
      errors.push(message.text());
    }
  });
});

/** Requires every visualizer scenario to finish without shader or pipeline failures. */
test.afterEach(async ({ page }) => {
  expect(rendererErrors.get(page)).toEqual([]);
});

type CreateFixtureFromLibraryData = Extract<
  FixtureLibraryCommand,
  { type: "CreateFixtureFromLibrary" }
>["data"];
type OwnedBackendFixture = CreateFixtureFromLibraryData & {
  label: string;
  placement: FixturePlacement;
};
type OwnedVisualizerCommand =
  | { module: "FixtureCommand"; command: FixtureCommand }
  | { module: "FixtureLibraryCommand"; command: FixtureLibraryCommand };
type SyntheticRgbAttribute = Extract<
  Attribute,
  { type: "VirtualIntensity" | "Red" | "Green" | "Blue" | "White" }
>;

const OWNED_RGB_STROBE_BAR = {
  id: 1004,
  label: "Owned RGB Strobe Bar",
  make: "Generic",
  model: "RGB Strobe Bar 168ch",
  mode: "Strobe",
  update_existing_ids: [],
  update_existing_only: false,
  placement: {
    position: { x: 0, y: 2, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
  },
} satisfies OwnedBackendFixture;
const OWNED_WASH_BEAM = {
  id: 607,
  label: "Owned Generic Wash Beam",
  make: "Generic",
  model: "12-segment Rotating Wash Beam",
  mode: "Beam",
  update_existing_ids: [],
  update_existing_only: false,
  placement: {
    position: { x: 0, y: 0.5, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
  },
} satisfies OwnedBackendFixture;
const OWNED_TILTED_STROBE = {
  id: 601,
  label: "Owned Tilted Strobe",
  make: "Generic",
  model: "Strobe Matrix 308ch",
  mode: "Strobe",
  update_existing_ids: [],
  update_existing_only: false,
  placement: {
    position: { x: -4, y: 0.05, z: 1 },
    rotation: { x: 180, y: 0, z: 0 },
  },
} satisfies OwnedBackendFixture;

/** Builds one generated-type fixture parameter for the synthetic RGB bar. */
function syntheticRgbParameter(
  attribute: SyntheticRgbAttribute,
  mergeType: MergeStrategy,
  useGrandmaster = false,
): ParameterMetadata {
  return {
    resolution: DmxValueResolution.Coarse,
    attribute,
    min: 0,
    max: 255,
    offset: { type: "Absolute", data: { value: 0 } },
    is_inverted: false,
    is_snap: false,
    merge_type: mergeType,
    use_grandmaster: useGrandmaster,
  };
}

const SYNTHETIC_RGB_PARAMETERS = [
  syntheticRgbParameter({ type: "VirtualIntensity" }, MergeStrategy.HTP, true),
  syntheticRgbParameter({ type: "Red" }, MergeStrategy.LTP),
  syntheticRgbParameter({ type: "Green" }, MergeStrategy.LTP),
  syntheticRgbParameter({ type: "Blue" }, MergeStrategy.LTP),
];
const SYNTHETIC_RGB_STROBE_BAR = {
  identifiers: {
    id: 910_004,
    uid: "d7720000000000000000000000000001",
    label: "RGB Strobe Bar E2E",
  },
  make: "Generic",
  model: "RGB Strobe Bar 168ch",
  layout: FixtureLayout.RgbStrobeBar,
  mode: "Strobe",
  elements: [
    ...Array.from({ length: 24 }, (_, index) => ({
      label: `White Segment ${index + 1}`,
      parameters: [syntheticRgbParameter({ type: "White" }, MergeStrategy.HTP)],
    })),
    ...Array.from({ length: 24 }, (_, index) => ({
      label: `Top RGB Segment ${index + 1}`,
      parameters: SYNTHETIC_RGB_PARAMETERS,
    })),
    ...Array.from({ length: 24 }, (_, index) => ({
      label: `Bottom RGB Segment ${index + 1}`,
      parameters: SYNTHETIC_RGB_PARAMETERS,
    })),
  ],
  placement: {
    position: { x: 0, y: 2, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
  },
} satisfies Fixture;

test.describe.configure({ timeout: 120_000 });

/** Opens every renderer scenario against the same verified blank backend. */
test.beforeEach(async ({ backendSlot, page }) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.addInitScript(() => {
    if (
      window.sessionStorage.getItem("visualizer-render-owned-init") !== "true"
    ) {
      window.localStorage.clear();
      window.localStorage.setItem(
        "nightfall-visualizer-settings",
        JSON.stringify({ qualityPreset: "high" }),
      );
      window.sessionStorage.setItem("visualizer-render-owned-init", "true");
    }
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=visualizer-render-setup");
  await waitForDockviewApp(page);
  await waitForVisualizerStores(page);
  await expect
    .poll(() => ownedVisualizerStoreCounts(page))
    .toEqual({
      bindings: 0,
      fixtureGeometries: 0,
      fixtures: 0,
      parameters: 0,
      programmer: 0,
      sceneObjects: 0,
    });
});

/** Replaces the backend after each scenario and proves owned state is blank. */
test.afterEach(async ({ backendSlot, page }) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  if (page.isClosed() || page.url() === "about:blank") return;
  await page.reload();
  await waitForDockviewApp(page);
  await waitForVisualizerStores(page);
  await expect
    .poll(() => ownedVisualizerStoreCounts(page))
    .toEqual({
      bindings: 0,
      fixtureGeometries: 0,
      fixtures: 0,
      parameters: 0,
      programmer: 0,
      sceneObjects: 0,
    });
});

/** Waits for startup and focuses the visible Visualizer panel. */
async function waitForVisualizerReady(page: Page): Promise<void> {
  await waitForDockviewApp(page);
  await page
    .getByRole("tab", { name: "3D Visualizer", exact: true })
    .first()
    .click();
  await expect(
    page.locator('[data-panel-id="panel-Visualizer"]'),
  ).toBeVisible();
  await page.addStyleTag({
    content:
      ".profiler-panel, .profiler-mini-panel { display: none !important; }",
  });
}

/** Waits until every backend-driven store owned by this suite is available. */
async function waitForVisualizerStores(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.bindings?.get) &&
      Boolean((window as any).appStores?.fixtureGeometries?.get) &&
      Boolean((window as any).appStores?.fixtures?.get) &&
      Boolean((window as any).appStores?.parameters?.get) &&
      Boolean((window as any).appStores?.programmerState?.get) &&
      Boolean((window as any).appStores?.sceneObjects?.get),
  );
}

/** Reads the exact backend-driven stores created by renderer scenarios. */
async function ownedVisualizerStoreCounts(page: Page): Promise<object> {
  return page.evaluate(() => {
    const stores = (window as any).appStores;
    const bindings = stores.bindings.get();
    return {
      bindings:
        bindings.input.length +
        bindings.output.length +
        bindings.disabled.length,
      fixtureGeometries: Object.keys(stores.fixtureGeometries.get()).length,
      fixtures: Object.keys(stores.fixtures.get()).length,
      parameters: stores.parameters.get().size,
      programmer: stores.programmerState.get().length,
      sceneObjects: Object.keys(stores.sceneObjects.get()).length,
    };
  });
}

/** Sends one correlated backend command and rejects unsuccessful outcomes. */
async function sendOwnedVisualizerCommand(
  page: Page,
  message: OwnedVisualizerCommand,
): Promise<void> {
  const result = await page.evaluate(async (command) => {
    return (window as any).appStores.sendAndAwait(command);
  }, message);
  expect(result.outcome.type, JSON.stringify(result)).toBe("Succeeded");
}

/** Creates one exact built-in fixture while preserving its UID and placement. */
async function installOwnedBackendFixture(
  page: Page,
  fixture: OwnedBackendFixture,
): Promise<string> {
  const { placement: _placement, ...libraryData } = fixture;
  await sendOwnedVisualizerCommand(page, {
    module: "FixtureLibraryCommand",
    command: {
      type: "CreateFixtureFromLibrary",
      data: libraryData,
    },
  });
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          Object.values(
            (window as any).appStores.fixtures.get() as Record<string, Fixture>,
          ).filter((candidate) => candidate.identifiers.id === id).length,
        fixture.id,
      ),
    )
    .toBe(1);
  const placedFixture = await page.evaluate(
    ({ id, label, make, mode, model, placement }): Fixture => {
      const fixtures = (window as any).appStores.fixtures.get() as Record<
        string,
        Fixture
      >;
      const matches = Object.values(fixtures).filter(
        (candidate) => candidate.identifiers.id === id,
      );
      if (matches.length !== 1) {
        throw new Error(
          `Expected one owned fixture ${id}, found ${matches.length}`,
        );
      }
      const created = matches[0];
      if (created.make !== make || created.model !== model) {
        throw new Error(
          `Owned fixture ${id} loaded unexpected profile ${created.make}/${created.model}`,
        );
      }
      return {
        ...created,
        identifiers: {
          ...created.identifiers,
          label,
        },
        mode,
        placement,
      };
    },
    fixture,
  );
  await sendOwnedVisualizerCommand(page, {
    module: "FixtureCommand",
    command: { type: "StoreFixture", data: placedFixture },
  });
  await sendOwnedVisualizerCommand(page, {
    module: "FixtureCommand",
    command: {
      type: "UpdateFixturePatch",
      data: {
        id: fixture.id,
        universe: fixture.id,
        address: 1,
        transport: {
          type: "Sacn",
          data: { mode: { type: "Multicast" } },
        },
      },
    },
  });
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const fixtures = (window as any).appStores.fixtures.get() as Record<
          string,
          Fixture
        >;
        const matches = Object.values(fixtures).filter(
          (candidate) => candidate.identifiers.id === id,
        );
        const created = matches[0];
        return {
          count: matches.length,
          label: created?.identifiers?.label,
          make: created?.make,
          model: created?.model,
        };
      }, fixture.id),
    )
    .toEqual({
      count: 1,
      label: fixture.label,
      make: fixture.make,
      model: fixture.model,
    });
  return placedFixture.identifiers.uid;
}

/** Waits for the visualizer FPS label without matching the numeric FPS readout. */
async function expectVisualizerFpsLabel(page: Page): Promise<void> {
  await expect(
    page.locator('[data-panel-id="panel-Visualizer"] .fps-label'),
  ).toBeVisible({ timeout: 15_000 });
}

/** Verifies the worker renderer starts without Inspector storage errors. */
test("3D visualizer worker starts without Inspector storage errors", async ({
  page,
}) => {
  const pageErrors = collectPageErrors(page);

  await page.goto("/?visualizer:offscreenCanvas=true");
  await expect(page).not.toHaveURL(/visualizer:offscreenCanvas=true/);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(
            window.localStorage.getItem("nightfall-feature-flags") ?? "{}",
          ).features?.visualizerOffscreenCanvas,
      ),
    )
    .toBe(true);

  await waitForVisualizerReady(page);
  await largestVisibleCanvasBox(page);
  await waitForWorkerVisualizerApi(page);

  expect(pageErrors).not.toContainEqual(
    expect.stringContaining("localStorage"),
  );
});

/** Verifies the main-thread renderer paints a visibly non-uniform canvas. */
test("3D visualizer main-thread renderer paints the canvas", async ({
  page,
}, testInfo) => {
  const pageErrors = collectPageErrors(page);

  await page.goto("/?visualizer:offscreenCanvas=false");
  await expect(page).not.toHaveURL(/visualizer:offscreenCanvas=false/);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(
            window.localStorage.getItem("nightfall-feature-flags") ?? "{}",
          ).features?.visualizerOffscreenCanvas,
      ),
    )
    .toBe(false);

  await waitForVisualizerReady(page);
  await largestVisibleCanvasBox(page);
  await expectVisualizerFpsLabel(page);
  const canvasBox = await largestVisibleCanvasBox(page);
  const screenshot = await page.screenshot({ clip: canvasBox });
  await testInfo.attach("owned-visualizer-main-thread", {
    body: screenshot,
    contentType: "image/png",
  });
  expect(pngLumaRange(screenshot)).toBeGreaterThan(5);

  expect(pageErrors).not.toContainEqual(
    expect.stringContaining("localStorage"),
  );
});

for (const worker of [false, true]) {
  /** Switches the running renderer through every preset and checks persistence and visible output. */
  test(`quality settings replace the ${worker ? "worker" : "main"} renderer live`, async ({
    page,
  }, testInfo) => {
    await page.goto(`/?visualizer:offscreenCanvas=${worker}`);
    const pageErrors = collectPageErrors(page);
    await waitForVisualizerReady(page);
    if (worker) await waitForWorkerVisualizerApi(page);
    else await waitForMainThreadVisualizerApi(page);
    const uid = await installRotatingWashBeamFixture(page);
    await waitForFixtureStoreHydration(page);
    await holdRotatingWashBeamImmediateOutput(page, uid);
    for (const preset of ["medium", "low", "high"] as const) {
      await page.evaluate(() => {
        (window as any).__previousQualityApi = (window as any).visualizerApi;
      });
      await page.keyboard.press("ControlOrMeta+,");
      const dialog = page.getByRole("dialog", {
        name: "Settings",
        exact: true,
      });
      await dialog
        .getByRole("tab", { name: "Visualizer", exact: true })
        .click();
      await dialog.getByLabel(/Quality preset/).selectOption(preset);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as any).visualizerApi !==
                (window as any).__previousQualityApi &&
              Boolean((window as any).visualizerApi),
          ),
        )
        .toBe(true);
      await page.keyboard.press("Escape");
      if (worker) await waitForWorkerVisualizerApi(page);
      else {
        await waitForMainThreadVisualizerApi(page);
        await expect
          .poll(() =>
            page.evaluate(async () => {
              const scene = (window as any).visualizerApi.getScene();
              const { getOpticalRenderContext } = await import(
                "/features/visualizer/rendering/effects/optical-render-context.ts"
              );
              const context = getOpticalRenderContext(scene);
              return {
                quality: context?.quality,
                cones: !!scene.getObjectByName("EmitterBeams"),
                volumes: !!context?.scene.getObjectByName("EmitterVolumes"),
              };
            }),
          )
          .toEqual({
            quality: preset,
            cones: preset === "medium",
            volumes: preset === "high",
          });
      }
      await holdRotatingWashBeamImmediateOutput(page, uid);
      await expectVisualizerFpsLabel(page);
      const screenshot = await page.screenshot({
        path: testInfo.outputPath(`quality-${preset}.png`),
        clip: await largestVisibleCanvasBox(page),
      });
      await testInfo.attach(`quality-${preset}`, {
        body: screenshot,
        contentType: "image/png",
      });
      expect(pngLumaRange(screenshot)).toBeGreaterThan(5);
    }
    await page.reload();
    await waitForVisualizerReady(page);
    await page.keyboard.press("ControlOrMeta+,");
    const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
    await dialog.getByRole("tab", { name: "Visualizer", exact: true }).click();
    await expect(dialog.getByLabel(/Quality preset/)).toHaveValue("high");
    expect(pageErrors).toEqual([]);
  });
}

/** Verifies camera panning retargets the orbit controls to the stage floor. */
test("camera pan updates orbit target to the floor intersection", async ({
  page,
}) => {
  await page.goto("/?visualizer:offscreenCanvas=false");

  await waitForVisualizerReady(page);
  await largestVisibleCanvasBox(page);
  await expectVisualizerFpsLabel(page);
  await waitForMainThreadVisualizerApi(page);

  await page.evaluate(() => {
    (window as any).visualizerApi.setCameraState({
      position: { x: 0, y: 8, z: 12 },
      target: { x: 0, y: 2, z: 0 },
    });
  });

  const staleState = await page.evaluate(() =>
    (window as any).visualizerApi.getCameraState(),
  );
  expect(staleState.target.y).toBeCloseTo(2, 5);

  await dispatchCanvasPanGesture(page);

  const pannedState = await page.evaluate(() =>
    (window as any).visualizerApi.getCameraState(),
  );
  expect(pannedState.target.y).toBeCloseTo(0, 5);
});

/** Verifies cancelling the scene-object wizard after a right-click menu does not leave camera pan latched. */
test("camera pan does not stick after cancelling visualizer object wizard", async ({
  page,
}) => {
  await page.goto("/?visualizer:offscreenCanvas=false");

  await waitForVisualizerReady(page);
  await largestVisibleCanvasBox(page);
  await expectVisualizerFpsLabel(page);
  await waitForMainThreadVisualizerApi(page);

  await page.evaluate(() => {
    (window as any).visualizerApi.setCameraState({
      position: { x: 0, y: 8, z: 12 },
      target: { x: 0, y: 0, z: 0 },
    });
  });
  const beforeState = await page.evaluate(() =>
    (window as any).visualizerApi.getCameraState(),
  );

  await dispatchStuckCameraContextMenu(page);
  const visualizerMenu = page.locator('[data-menu-kind="context"]');
  await expect(visualizerMenu).toBeVisible();
  await visualizerMenu.getByRole("menuitem", { name: "New Object" }).click();
  await expect(page.getByText("Add Object").first()).toBeVisible();
  const cancelButton = page.getByRole("button", { name: "Cancel" });
  await cancelButton.click();
  await expect(cancelButton).not.toBeVisible();

  await dispatchDocumentPointerMove(page);

  const afterState = await page.evaluate(() =>
    (window as any).visualizerApi.getCameraState(),
  );
  for (const key of ["position", "target"] as const) {
    for (const axis of ["x", "y", "z"] as const) {
      expect(afterState[key][axis]).toBeCloseTo(beforeState[key][axis], 5);
    }
  }
});

/** Verifies camera zooming retargets the orbit controls to the stage floor. */
test("camera zoom updates orbit target to the floor intersection", async ({
  page,
}) => {
  await page.goto("/?visualizer:offscreenCanvas=false");

  await waitForVisualizerReady(page);
  await largestVisibleCanvasBox(page);
  await expectVisualizerFpsLabel(page);
  await waitForMainThreadVisualizerApi(page);

  await page.evaluate(() => {
    (window as any).visualizerApi.setCameraState({
      position: { x: 0, y: 8, z: 12 },
      target: { x: 0, y: 2, z: 0 },
    });
  });

  const staleState = await page.evaluate(() =>
    (window as any).visualizerApi.getCameraState(),
  );
  expect(staleState.target.y).toBeCloseTo(2, 5);

  await dispatchCanvasWheelGesture(page);

  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const state = await (window as any).visualizerApi.getCameraState();
        return state.target.y;
      }),
    )
    .toBeCloseTo(0, 5);
});

/** Verifies an owned idle RGB strobe bar keeps every white segment dark. */
test("idle strobe panels keep white segments dark", async ({ page }) => {
  await page.goto("/?visualizer:offscreenCanvas=false");

  await waitForVisualizerReady(page);
  await expectVisualizerFpsLabel(page);
  await waitForMainThreadVisualizerApi(page);
  await installRgbStrobeBarFixture(page);
  await waitForFixtureStoreHydration(page);

  await expect.poll(() => strobeWhiteSegmentStats(page)).not.toBeNull();
  const stats = await strobeWhiteSegmentStats(page);
  expect(stats).not.toBeNull();

  expect(stats?.count).toBeGreaterThan(0);
  expect(stats?.maxChannel).toBeLessThan(0.2);
});

/** Verifies the owned RGB strobe bar renders all three emitter groups. */
test("rgb strobe bar fixture renders its three emitter groups", async ({
  page,
}, testInfo) => {
  await page.goto("/?visualizer:offscreenCanvas=false");

  await waitForVisualizerReady(page);
  await expect(page.locator(inputSelector)).toBeVisible();
  await expectVisualizerFpsLabel(page);
  await waitForMainThreadVisualizerApi(page);
  const fixtureUid = await installRgbStrobeBarFixture(page);
  await waitForFixtureStoreHydration(page);

  await expect
    .poll(async () => rgbStrobeBarSceneStats(page, fixtureUid))
    .toEqual({
      topCount: 24,
      whiteCount: 24,
      bottomCount: 24,
      litTopCount: 0,
      litWhiteCount: 0,
      litBottomCount: 0,
    });

  const canvasBox = await largestVisibleCanvasBox(page);
  const screenshot = await page.screenshot({ clip: canvasBox });
  await testInfo.attach("owned-rgb-strobe-bar", {
    body: screenshot,
    contentType: "image/png",
  });
  expect(pngLumaRange(screenshot)).toBeGreaterThan(5);
});

/** Verifies an owned RGB strobe bar applies white virtual intensity. */
test("rgb strobe bar visualizer applies white virtual intensity", async ({
  page,
}) => {
  await page.goto(
    "/?startup:draftRecovery=false&visualizer:offscreenCanvas=false",
  );
  await waitForVisualizerReady(page);
  await expectVisualizerFpsLabel(page);
  await waitForMainThreadVisualizerApi(page);
  const fixtureUid = await installRgbStrobeBarFixture(page);
  await waitForFixtureStoreHydration(page);
  await holdRgbStrobeBarImmediateOutput(page, fixtureUid, [
    { White: 255 },
    ...Array.from({ length: 23 }, () => ({})),
    { Intensity: 255, Red: 255, Green: 0, Blue: 0 },
    ...Array.from({ length: 47 }, () => ({})),
  ]);

  await expect
    .poll(async () => rgbStrobeBarSceneStats(page, fixtureUid))
    .toEqual({
      topCount: 24,
      whiteCount: 24,
      bottomCount: 24,
      litTopCount: 1,
      litWhiteCount: 1,
      litBottomCount: 0,
    });

  await holdRgbStrobeBarImmediateOutput(page, fixtureUid, [
    { White: 255 },
    ...Array.from({ length: 71 }, () => ({})),
  ]);

  await expect
    .poll(async () => rgbStrobeBarSceneStats(page, fixtureUid))
    .toEqual({
      topCount: 24,
      whiteCount: 24,
      bottomCount: 24,
      litTopCount: 0,
      litWhiteCount: 0,
      litBottomCount: 0,
    });
});

/** Verifies commands dim an owned RGB strobe bar's white emitters at zero intensity. */
test("rgb strobe bar command path dims white when intensity is zero", async ({
  page,
}) => {
  await page.goto(
    "/?startup:draftRecovery=false&visualizer:offscreenCanvas=false",
  );

  await waitForVisualizerReady(page);
  await expect(page.locator(inputSelector)).toBeVisible();
  await expectVisualizerFpsLabel(page);
  await waitForMainThreadVisualizerApi(page);
  const fixtureUid = await installOwnedBackendFixture(
    page,
    OWNED_RGB_STROBE_BAR,
  );
  await waitForFixtureStoreHydration(page);

  await expect
    .poll(async () => rgbStrobeBarSceneStats(page, fixtureUid))
    .not.toBeNull();

  await submitCommand(
    page,
    `fix ${OWNED_RGB_STROBE_BAR.id} int @ 0 white @ 100`,
  );

  await expect
    .poll(async () => rgbStrobeBarSceneStats(page, fixtureUid), {
      timeout: 5_000,
    })
    .toEqual({
      topCount: 24,
      whiteCount: 24,
      bottomCount: 24,
      litTopCount: 0,
      litWhiteCount: 0,
      litBottomCount: 0,
    });
});

/** Verifies commands light exact strip elements on the owned Generic wash beam. */
test("generic wash beam command path lights strip elements with element intensity", async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(60_000);

  await page.goto(
    "/?startup:draftRecovery=false&visualizer:offscreenCanvas=false",
  );
  await waitForVisualizerReady(page);
  await expect(page.locator(inputSelector)).toBeVisible();
  await expectVisualizerFpsLabel(page);
  await waitForMainThreadVisualizerApi(page);
  const fixtureUid = await installOwnedBackendFixture(page, OWNED_WASH_BEAM);
  await waitForFixtureStoreHydration(page);
  await expect
    .poll(() => rotatingWashBeamSceneStats(page, fixtureUid))
    .not.toBeNull();

  await submitCommand(
    page,
    `fix ${OWNED_WASH_BEAM.id}.(14>25) int @ 100 red @ 100`,
  );

  await expect
    .poll(() => rotatingWashBeamElementParameterState(page, fixtureUid, 14), {
      timeout: 5_000,
    })
    .toMatchObject({
      absoluteIntensity: 255,
      outputVirtualIntensity: 255,
      outputRed: 255,
    });

  await expect
    .poll(() => rotatingWashBeamSceneStats(page, fixtureUid), {
      timeout: 5_000,
    })
    .toMatchObject({
      litTopStripCount: 12,
      litBottomStripCount: 0,
    });
});

/** Verifies the owned Generic wash beam renders beams and both pixel strips. */
test("generic wash beam fixture renders beams and strip pixels", async ({
  page,
}, testInfo) => {
  await page.goto("/?visualizer:offscreenCanvas=false");

  await waitForVisualizerReady(page);
  await largestVisibleCanvasBox(page);
  await expectVisualizerFpsLabel(page);
  await waitForMainThreadVisualizerApi(page);
  const fixtureUid = await installRotatingWashBeamFixture(page);
  await waitForFixtureStoreHydration(page);

  await expect
    .poll(() => rotatingWashBeamSceneStats(page, fixtureUid))
    .toEqual({
      baseCount: 1,
      lensCount: 12,
      beamCount: 12,
      topStripCount: 12,
      bottomStripCount: 12,
      litTopStripCount: 0,
      litBottomStripCount: 0,
      position: { x: 0, y: 0.5, z: 0 },
    });

  const canvasBox = await largestVisibleCanvasBox(page);
  const screenshot = await page.screenshot({ clip: canvasBox });
  await testInfo.attach("owned-rotating-wash-beam", {
    body: screenshot,
    contentType: "image/png",
  });
  expect(pngLumaRange(screenshot)).toBeGreaterThan(5);
  await holdRotatingWashBeamImmediateOutput(page, fixtureUid);
  await expect
    .poll(() => rotatingWashBeamOpticalStats(page, fixtureUid))
    .toEqual({
      opticalBeamCount: 12,
      atmosphericBeamCount: 12,
      atmosphericDraws: 1,
      visibleBeamCount: 0,
      visibleSpotLightCount: 0,
    });
});

/** Verifies low quality retains visible fixtures without light projections or beams. */
test("generic wash beam low-quality setting omits light effects", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.setItem(
      "nightfall-feature-flags",
      JSON.stringify({
        features: {
          visualizerOffscreenCanvas: false,
          visualizerBeamQuality: "low",
          startupDraftRecovery: false,
        },
      }),
    );
  });
  await page.goto("/?startup:draftRecovery=false&visualizer:beamQuality=low");

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(
            window.localStorage.getItem("nightfall-feature-flags") ?? "{}",
          ).features?.visualizerOffscreenCanvas,
      ),
    )
    .toBe(false);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(
            window.localStorage.getItem("nightfall-feature-flags") ?? "{}",
          ).features?.visualizerBeamQuality,
      ),
    )
    .toBe("low");
  await waitForVisualizerReady(page);
  await largestVisibleCanvasBox(page);
  await expectVisualizerFpsLabel(page);
  await waitForMainThreadVisualizerApi(page);
  const fixtureUid = await installRotatingWashBeamFixture(page);
  await waitForFixtureStoreHydration(page);
  await holdRotatingWashBeamImmediateOutput(page, fixtureUid);
  await expect
    .poll(() => rotatingWashBeamOpticalStats(page, fixtureUid))
    .toEqual({
      opticalBeamCount: 0,
      atmosphericBeamCount: 0,
      atmosphericDraws: 0,
      visibleBeamCount: 0,
      visibleSpotLightCount: 0,
    });

  const canvasBox = await largestVisibleCanvasBox(page);
  const screenshot = await page.screenshot({ clip: canvasBox });
  expect(pngLumaRange(screenshot)).toBeGreaterThan(5);
});

/** Verifies the owned Generic wash beam narrows its beam at full zoom. */
test("generic wash beam zoom 100 renders a focused beam", async ({
  page,
}, testInfo) => {
  await page.goto(
    "/?startup:draftRecovery=false&visualizer:offscreenCanvas=false",
  );
  await waitForVisualizerReady(page);
  await largestVisibleCanvasBox(page);
  await expectVisualizerFpsLabel(page);
  await waitForMainThreadVisualizerApi(page);
  const fixtureUid = await installOwnedBackendFixture(page, OWNED_WASH_BEAM);
  await waitForFixtureStoreHydration(page);

  await submitCommand(
    page,
    `fix ${OWNED_WASH_BEAM.id} int @ 100 red @ 100 zoom @ 0 tilt @ 0`,
  );
  await expect
    .poll(
      async () =>
        (await rotatingWashBeamFirstBeamRadius(page, fixtureUid)) ?? 0,
    )
    .toBeGreaterThan(10);
  const unfocusedRadius = await rotatingWashBeamFirstBeamRadius(
    page,
    fixtureUid,
  );

  await submitCommand(page, `fix ${OWNED_WASH_BEAM.id} zoom @ 100`);
  await expect
    .poll(async () => {
      const radius = await rotatingWashBeamFirstBeamRadius(page, fixtureUid);
      return radius ?? Number.POSITIVE_INFINITY;
    })
    .toBeLessThan(unfocusedRadius ?? Number.POSITIVE_INFINITY);
  const focusedRadius = await rotatingWashBeamFirstBeamRadius(page, fixtureUid);

  if (focusedRadius === null || unfocusedRadius === null) {
    throw new Error("expected Generic wash beam radius to be available");
  }
  expect(focusedRadius).toBeLessThan(unfocusedRadius);
  expect(focusedRadius).toBeLessThan(0.4);
  await expect
    .poll(() => rotatingWashBeamOpticalStats(page, fixtureUid))
    .toMatchObject({ opticalBeamCount: 12, atmosphericBeamCount: 12 });
  const focusedImage = await page.screenshot({
    path: testInfo.outputPath("focused-wash.png"),
    clip: await largestVisibleCanvasBox(page),
  });
  const pixels = decodePng(focusedImage);
  for (const fraction of [0.2, 0.3, 0.4]) {
    expect(
      pngRedDominantStats(focusedImage, {
        x: 0,
        y: Math.floor(pixels.height * fraction),
        width: pixels.width,
        height: 4,
      }).count,
      "The narrow beam must stay continuous above its emitting face",
    ).toBeGreaterThan(40);
  }
  expect(
    await page.evaluate((uid) => {
      const root = (window as any).visualizerApi
        .getScene()
        .getObjectByName(`Fixture_${uid}`);
      const counts: number[] = [];
      root.traverse((object: any) => {
        if (object.userData.visualizerCellBatch) counts.push(object.count);
      });
      return counts;
    }, fixtureUid),
  ).toEqual([12, 24]);
});

/** Verifies the owned Generic moving spot orients its yoke arms at zero pan. */
test("generic moving spot fixture renders yoke arms along the x axis at pan zero", async ({
  page,
}, testInfo) => {
  await page.goto("/?visualizer:offscreenCanvas=false");

  await waitForVisualizerReady(page);
  await largestVisibleCanvasBox(page);
  await expectVisualizerFpsLabel(page);
  await waitForMainThreadVisualizerApi(page);
  const fixtureUid = await installMovingSpotFixture(page);
  await waitForFixtureStoreHydration(page);

  await expect
    .poll(() => movingSpotSceneStats(page, fixtureUid))
    .toEqual({
      leftArm: { x: -0.1, z: 0 },
      rightArm: { x: 0.1, z: 0 },
      yokeRotationY: 0,
    });

  await setFixtureImmediateOutput(page, fixtureUid, { Pan: 0, Tilt: 0 });

  await expect
    .poll(() => movingSpotSceneStats(page, fixtureUid))
    .toEqual({
      leftArm: { x: -0.1, z: 0 },
      rightArm: { x: 0.1, z: 0 },
      yokeRotationY: 0,
    });

  const canvasBox = await largestVisibleCanvasBox(page);
  const screenshot = await page.screenshot({ clip: canvasBox });
  await testInfo.attach("owned-generic-moving-spot", {
    body: screenshot,
    contentType: "image/png",
  });
  expect(pngLumaRange(screenshot)).toBeGreaterThan(5);
});

/** Verifies the owned moving spot color wheel renders a red beam. */
test("generic moving spot color wheel renders a red beam", async ({ page }) => {
  await page.goto("/?visualizer:offscreenCanvas=false");

  await waitForVisualizerReady(page);
  await largestVisibleCanvasBox(page);
  await expectVisualizerFpsLabel(page);
  await waitForMainThreadVisualizerApi(page);
  const fixtureUid = await installMovingSpotFixture(page);
  await waitForFixtureStoreHydration(page);
  await holdFixtureImmediateOutput(page, fixtureUid, {
    Intensity: 255,
    "Color Wheel": 10,
  });

  await expect
    .poll(() => movingSpotBeamStats(page, fixtureUid))
    .toEqual({
      beamVisible: true,
      lensColor: { r: 2, g: 0, b: 0 },
    });
});

/** Verifies the owned moving spot color wheel renders split beam colors. */
test("generic moving spot color wheel renders split beam colors", async ({
  page,
}) => {
  await page.goto("/?visualizer:offscreenCanvas=false");

  await waitForVisualizerReady(page);
  await largestVisibleCanvasBox(page);
  await expectVisualizerFpsLabel(page);
  await waitForMainThreadVisualizerApi(page);
  const fixtureUid = await installMovingSpotFixture(page);
  await waitForFixtureStoreHydration(page);
  await holdFixtureImmediateOutput(page, fixtureUid, {
    Intensity: 255,
    "Color Wheel": 100,
  });

  await expect
    .poll(() => movingSpotBeamMaterialStats(page, fixtureUid))
    .toEqual({
      beamVisible: true,
      splitColorAmount: 1,
      primaryColor: { r: 1, g: 1, b: 1 },
      secondaryColor: { r: 0, g: 1, b: 0 },
    });
});

/** Verifies clearing the owned tilted strobe removes its rendered red pixels. */
test("clearing a tilted strobe panel removes rendered LED pixels", async ({
  page,
}, testInfo) => {
  await page.goto("/?visualizer:offscreenCanvas=false");

  await waitForVisualizerReady(page);
  await expect(page.locator(inputSelector)).toBeVisible();
  await expectVisualizerFpsLabel(page);
  await installOwnedBackendFixture(page, OWNED_TILTED_STROBE);
  await waitForFixtureStoreHydration(page);
  await expect.poll(() => strobeWhiteSegmentStats(page)).not.toBeNull();

  await submitCommand(
    page,
    `fix ${OWNED_TILTED_STROBE.id} tilt @ 50 red @ 100`,
  );
  await page.waitForTimeout(500);

  const canvasBox = await largestVisibleCanvasBox(page);
  const asserted = await page.screenshot({ clip: canvasBox });
  await testInfo.attach("owned-tilted-strobe-asserted", {
    body: asserted,
    contentType: "image/png",
  });
  const searchRegion = {
    x: 0,
    y: Math.floor(canvasBox.height * 0.45),
    width: Math.floor(canvasBox.width * 0.5),
    height: Math.floor(canvasBox.height * 0.4),
  };
  const assertedRed = pngRedDominantStats(asserted, searchRegion);
  expect(assertedRed.count).toBeGreaterThan(20);
  expect(assertedRed.bounds).not.toBeNull();

  const bounds = assertedRed.bounds!;
  await submitCommand(page, "clear");
  await page.waitForTimeout(500);

  const cleared = await page.screenshot({ clip: canvasBox });
  await testInfo.attach("owned-tilted-strobe-cleared", {
    body: cleared,
    contentType: "image/png",
  });
  const clearedRed = pngRedDominantStats(cleared, {
    x: Math.max(0, bounds.x - 8),
    y: Math.max(0, bounds.y - 8),
    width: bounds.width + 16,
    height: bounds.height + 16,
  });

  expect(clearedRed.count).toBe(0);
});

/**
 * Collects browser page errors emitted during visualizer render tests.
 */
function collectPageErrors(page: Page): string[] {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });
  return pageErrors;
}

/**
 * Submits a command-line command for visualizer scenario setup.
 */
async function submitCommand(page: Page, command: string): Promise<void> {
  const input = page.locator(inputSelector);
  await input.fill(command);
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect
    .poll(() =>
      page.evaluate((submittedCommand) => {
        const entries =
          (window as any).appStores?.consoleScrollback?.get?.() ?? [];
        const matches = entries.filter(
          (entry: any) => entry.command === submittedCommand,
        );
        const last = matches[matches.length - 1];
        return last
          ? { errorMessage: last.errorMessage, status: last.status }
          : null;
      }, command),
    )
    .toEqual({ status: "success" });
}

/**
 * Waits for the worker visualizer debug API to be registered.
 */
async function waitForWorkerVisualizerApi(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(() =>
          Boolean((window as any).visualizerApi?.isUsingWorker()),
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
}

/**
 * Waits for the main-thread visualizer debug API to be registered.
 */
async function waitForMainThreadVisualizerApi(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(() => Boolean((window as any).visualizerApi?.getScene())),
      { timeout: 15_000 },
    )
    .toBe(true);
}

/**
 * Waits for the websocket-backed fixture store to finish its initial hydration.
 */
async function waitForFixtureStoreHydration(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const stores = (window as any).appStores;
      const fixtureUids = Object.keys(stores?.fixtures?.get?.() ?? {});
      if (fixtureUids.length === 0) return false;

      const geometryUids = Object.keys(
        stores?.fixtureGeometries?.get?.() ?? {},
      );
      const signature = `${fixtureUids.sort().join("|")}#${geometryUids.sort().join("|")}`;
      let state = (window as any).__visualizerFixtureHydrationStable;
      if (!state) {
        state = {
          signature,
          since: performance.now(),
        };
        (window as any).__visualizerFixtureHydrationStable = state;
      }
      if (state.signature !== signature) {
        state.signature = signature;
        state.since = performance.now();
        return false;
      }

      return performance.now() - state.since >= 500;
    },
    undefined,
    { timeout: 15_000 },
  );
}

/**
 * Opens the visualizer context menu while OrbitControls has an active right-button pan.
 */
async function dispatchStuckCameraContextMenu(page: Page): Promise<void> {
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-panel-id="panel-Visualizer"] canvas[aria-label="3D visualizer viewport"]',
    );
    if (!canvas) {
      throw new Error("No visible visualizer canvas found");
    }

    const rect = canvas.getBoundingClientRect();
    const pointerId = 11;
    const clientX = rect.x + rect.width * 0.5;
    const clientY = rect.y + rect.height * 0.5;
    const originalSetPointerCapture = canvas.setPointerCapture;
    const originalReleasePointerCapture = canvas.releasePointerCapture;
    canvas.setPointerCapture = () => undefined;
    canvas.releasePointerCapture = () => undefined;

    try {
      canvas.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          pointerId,
          pointerType: "mouse",
          button: 2,
          buttons: 2,
          clientX,
          clientY,
        }),
      );
      canvas.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          buttons: 2,
          clientX,
          clientY,
        }),
      );
    } finally {
      canvas.setPointerCapture = originalSetPointerCapture;
      canvas.releasePointerCapture = originalReleasePointerCapture;
    }
  });
}

/**
 * Sends a document pointer move that would pan the camera if OrbitControls stayed latched.
 */
async function dispatchDocumentPointerMove(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        pointerId: 11,
        pointerType: "mouse",
        button: -1,
        buttons: 0,
        clientX: window.innerWidth * 0.5 + 180,
        clientY: window.innerHeight * 0.5,
      }),
    );
  });
}

/**
 * Dispatches a canvas pan gesture through browser pointer events.
 */
async function dispatchCanvasPanGesture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-panel-id="panel-Visualizer"] canvas[aria-label="3D visualizer viewport"]',
    );
    if (!canvas) {
      throw new Error("No visible visualizer canvas found");
    }

    const rect = canvas.getBoundingClientRect();
    const pointerId = 1;
    const startX = rect.x + rect.width * 0.5;
    const startY = rect.y + rect.height * 0.5;

    const originalSetPointerCapture = canvas.setPointerCapture;
    const originalReleasePointerCapture = canvas.releasePointerCapture;
    canvas.setPointerCapture = () => undefined;
    canvas.releasePointerCapture = () => undefined;

    try {
      canvas.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          pointerId,
          pointerType: "mouse",
          button: 0,
          buttons: 1,
          shiftKey: true,
          clientX: startX,
          clientY: startY,
        }),
      );
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          pointerId,
          pointerType: "mouse",
          button: -1,
          buttons: 1,
          shiftKey: true,
          clientX: startX + 160,
          clientY: startY,
        }),
      );
      document.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          pointerId,
          pointerType: "mouse",
          button: 0,
          buttons: 0,
          shiftKey: true,
          clientX: startX + 160,
          clientY: startY,
        }),
      );
    } finally {
      canvas.setPointerCapture = originalSetPointerCapture;
      canvas.releasePointerCapture = originalReleasePointerCapture;
    }
  });
}

/**
 * Dispatches a canvas wheel gesture through browser input events.
 */
async function dispatchCanvasWheelGesture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-panel-id="panel-Visualizer"] canvas[aria-label="3D visualizer viewport"]',
    );
    if (!canvas) {
      throw new Error("No visible visualizer canvas found");
    }

    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: -200,
        clientX: rect.x + rect.width * 0.5,
        clientY: rect.y + rect.height * 0.5,
      }),
    );
  });
}

/**
 * Measures white-segment pixel statistics in the visualizer canvas.
 */
async function strobeWhiteSegmentStats(
  page: Page,
): Promise<{ count: number; maxChannel: number } | null> {
  return page.evaluate(() => {
    const api = (window as any).visualizerApi;
    const scene = api?.getScene?.();
    if (!scene) return null;

    const values: number[] = [];
    scene.traverse((object: any) => {
      if (object.name !== "WhiteSegment") return;
      const material = object.material;
      if (!material || Array.isArray(material) || !material.color) return;
      values.push(
        Math.max(material.color.r, material.color.g, material.color.b),
      );
    });

    if (values.length === 0) return null;
    return {
      count: values.length,
      maxChannel: Math.max(...values),
    };
  });
}

/**
 * Installs the RGB strobe bar fixture used by visualizer render tests.
 */
async function installRgbStrobeBarFixture(page: Page): Promise<string> {
  return page.evaluate((fixture: Fixture) => {
    const stores = (window as any).appStores;
    stores.fixtures.set({
      ...stores.fixtures.get(),
      [fixture.identifiers.uid]: fixture,
    });
    return fixture.identifiers.uid;
  }, SYNTHETIC_RGB_STROBE_BAR);
}

/**
 * Reads scene statistics for the RGB strobe bar fixture.
 */
async function rgbStrobeBarSceneStats(
  page: Page,
  fixtureUid: string,
): Promise<{
  topCount: number;
  whiteCount: number;
  bottomCount: number;
  litTopCount: number;
  litWhiteCount: number;
  litBottomCount: number;
} | null> {
  return page.evaluate((uid) => {
    const api = (window as any).visualizerApi;
    const scene = api?.getScene?.();
    const root = scene?.getObjectByName?.(`Fixture_${uid}`);
    if (!root) return null;

    const stats = {
      topCount: 0,
      whiteCount: 0,
      bottomCount: 0,
      litTopCount: 0,
      litWhiteCount: 0,
      litBottomCount: 0,
    };

    root.traverse((object: any) => {
      const material = object.material;
      const color = !Array.isArray(material) ? material?.color : undefined;
      const lit = color != null && Math.max(color.r, color.g, color.b) > 0.25;

      if (object.name === "TopRgbSegment") {
        stats.topCount += 1;
        if (lit) stats.litTopCount += 1;
      } else if (object.name === "WhiteSegment") {
        stats.whiteCount += 1;
        if (lit) stats.litWhiteCount += 1;
      } else if (object.name === "BottomRgbSegment") {
        stats.bottomCount += 1;
        if (lit) stats.litBottomCount += 1;
      }
    });

    return stats;
  }, fixtureUid);
}

/**
 * Holds immediate output for the RGB strobe bar fixture long enough for renderer frames.
 */
async function holdRgbStrobeBarImmediateOutput(
  page: Page,
  fixtureUid: string,
  elementOutputs: Record<string, number>[],
): Promise<void> {
  await page.evaluate(
    async ({ fixtureUid, elementOutputs }) => {
      const { setParametersImmediate } = await import("/state/appStores.ts");
      let framesRemaining = 120;
      const writeOutput = () => {
        const stores = (window as any).appStores;
        setParametersImmediate(
          new Map<string, Record<string, number>[]>(
            stores.getParametersImmediate(),
          ).set(fixtureUid, elementOutputs),
        );
        framesRemaining -= 1;
        if (framesRemaining > 0) {
          requestAnimationFrame(writeOutput);
        }
      };
      writeOutput();
    },
    { fixtureUid, elementOutputs },
  );
}

/**
 * Installs the Generic wash beam fixture used by visualizer render tests.
 */
async function installRotatingWashBeamFixture(page: Page): Promise<string> {
  return page.evaluate(() => {
    const fixtureUid = "88888888-8888-8888-8888-888888888888";
    const stores = (window as any).appStores;
    const parameter = (attribute: string) => ({
      resolution: attribute === "Tilt" ? "Fine" : "Coarse",
      attribute: { type: attribute },
      min: 0,
      max: 255,
      offset: { type: "Absolute", data: { value: 0 } },
      is_inverted: false,
      is_snap: false,
      merge_type:
        attribute === "Intensity" || attribute === "VirtualIntensity"
          ? "HTP"
          : "LTP",
      use_grandmaster:
        attribute === "Intensity" || attribute === "VirtualIntensity",
    });
    const customParameter = (label: string) => ({
      resolution: "Coarse",
      attribute: { type: "Custom", data: { label } },
      min: 0,
      max: 255,
      offset: { type: "Absolute", data: { value: 0 } },
      is_inverted: false,
      is_snap: false,
      merge_type: "LTP",
      use_grandmaster: false,
    });

    stores.fixtures.set({
      ...stores.fixtures.get(),
      [fixtureUid]: {
        identifiers: {
          id: 888,
          uid: fixtureUid,
          label: "Generic Wash Beam E2E",
        },
        make: "Generic",
        model: "12-segment Rotating Wash Beam",
        layout: "rotating-wash-beam",
        mode: "Beam",
        elements: [
          {
            label: "Control",
            parameters: [
              parameter("Tilt"),
              customParameter("Tilt Speed"),
              parameter("Zoom"),
              parameter("Intensity"),
            ],
          },
          ...Array.from({ length: 12 }, (_, index) => ({
            label: `Beam ${index + 1}`,
            parameters: [
              parameter("VirtualIntensity"),
              parameter("Red"),
              parameter("Green"),
              parameter("Blue"),
              parameter("White"),
            ],
          })),
          ...Array.from({ length: 12 }, (_, index) => ({
            label: `Top Strip Pixel ${index + 1}`,
            parameters: [
              parameter("VirtualIntensity"),
              parameter("Red"),
              parameter("Green"),
              parameter("Blue"),
              parameter("White"),
              parameter("Yellow"),
            ],
          })),
          ...Array.from({ length: 12 }, (_, index) => ({
            label: `Bottom Strip Pixel ${index + 1}`,
            parameters: [
              parameter("VirtualIntensity"),
              parameter("Red"),
              parameter("Green"),
              parameter("Blue"),
              parameter("White"),
              parameter("Yellow"),
            ],
          })),
        ],
        placement: {
          position: { x: 0, y: 0.5, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
        },
      },
    });

    return fixtureUid;
  });
}

/** Holds immediate output for the Generic wash beam control and beam elements. */
async function holdRotatingWashBeamImmediateOutput(
  page: Page,
  fixtureUid: string,
): Promise<void> {
  await page.evaluate(async (uid) => {
    const { setParametersImmediate } = await import("/state/appStores.ts");
    const control = {
      Tilt: 127,
      Zoom: 127,
      Intensity: 255,
      "Tilt Speed": 255,
    };
    const beam = {
      Red: 255,
      Green: 96,
      Blue: 32,
      White: 0,
      Intensity: 255,
    };
    const strip = {
      Red: 0,
      Green: 0,
      Blue: 0,
      White: 0,
      Yellow: 0,
    };
    const output = [
      control,
      ...Array.from({ length: 12 }, () => beam),
      ...Array.from({ length: 24 }, () => strip),
    ];
    let framesRemaining = 120;
    const writeOutput = () => {
      const stores = (window as any).appStores;
      setParametersImmediate(
        new Map<string, Record<string, number>[]>(
          stores.getParametersImmediate(),
        ).set(uid, output),
      );
      framesRemaining -= 1;
      if (framesRemaining > 0) {
        requestAnimationFrame(writeOutput);
      }
    };
    writeOutput();
  }, fixtureUid);
}

/**
 * Reads scene statistics for the Generic 12-segment wash beam fixture.
 */
async function rotatingWashBeamSceneStats(
  page: Page,
  fixtureUid: string,
): Promise<{
  baseCount: number;
  lensCount: number;
  beamCount: number;
  topStripCount: number;
  bottomStripCount: number;
  litTopStripCount: number;
  litBottomStripCount: number;
  position: { x: number; y: number; z: number };
} | null> {
  return page.evaluate((uid) => {
    const api = (window as any).visualizerApi;
    const scene = api?.getScene?.();
    const root = scene?.getObjectByName?.(`Fixture_${uid}`);
    if (!root) return null;

    const stats = {
      baseCount: 0,
      lensCount: 0,
      beamCount: 0,
      topStripCount: 0,
      bottomStripCount: 0,
      litTopStripCount: 0,
      litBottomStripCount: 0,
      position: {
        x: root.position.x,
        y: root.position.y,
        z: root.position.z,
      },
    };

    root.traverse((object: any) => {
      const material = object.material;
      const color = !Array.isArray(material) ? material?.color : undefined;
      const lit = color != null && Math.max(color.r, color.g, color.b) > 0.25;

      if (object.name === "Base") {
        stats.baseCount += 1;
      } else if (object.name.startsWith("Lens_")) {
        stats.lensCount += 1;
      } else if (object.name.startsWith("Beam_")) {
        stats.beamCount += 1;
      } else if (object.name.startsWith("TopStripPixel_")) {
        stats.topStripCount += 1;
        if (lit) stats.litTopStripCount += 1;
      } else if (object.name.startsWith("BottomStripPixel_")) {
        stats.bottomStripCount += 1;
        if (lit) stats.litBottomStripCount += 1;
      }
    });

    return stats;
  }, fixtureUid);
}

/** Reads one Generic wash beam element's table and visualizer-facing output state. */
async function rotatingWashBeamElementParameterState(
  page: Page,
  fixtureUid: string,
  elementIndex: number,
): Promise<{
  absoluteIntensity: number | null;
  outputVirtualIntensity: number | null;
  outputRed: number | null;
} | null> {
  return page.evaluate(
    ({ fixtureUid, elementIndex }) => {
      const stores = (window as any).appStores;
      const parameterRow = stores?.parameters?.get?.()?.get?.(fixtureUid);
      const elementRow = parameterRow?.elements?.find(
        (element: any) => element.elementIndex === elementIndex,
      );
      const output =
        stores?.getParametersImmediate?.()?.get?.(fixtureUid)?.[
          elementIndex - 1
        ] ?? {};
      if (!elementRow) return null;
      const intensityValue =
        elementRow.absolute?.Intensity ?? elementRow.absolute?.VirtualIntensity;
      const resolvedIntensity =
        intensityValue?.type === "AbsolutePercent"
          ? intensityValue.data.value * 255
          : intensityValue?.data?.value;
      return {
        absoluteIntensity: resolvedIntensity ?? null,
        outputVirtualIntensity: output.VirtualIntensity ?? null,
        outputRed: output.Red ?? null,
      };
    },
    { fixtureUid, elementIndex },
  );
}

/** Reads the shared optical field radius at the first wash emitter's configured throw distance. */
async function rotatingWashBeamFirstBeamRadius(
  page: Page,
  fixtureUid: string,
): Promise<number | null> {
  return page.evaluate((uid) => {
    const api = (window as any).visualizerApi;
    const scene = api?.getScene?.();
    const beam = scene?.getObjectByName?.(`OpticalSurface:${uid}:Beam_0`);
    if (!beam?.optics) return null;
    return beam.optics.radius + beam.beamLength * beam.optics.slopeX;
  }, fixtureUid);
}

/**
 * Matches active atmospheric instances to this fixture's optical lights and checks legacy suppression.
 */
async function rotatingWashBeamOpticalStats(
  page: Page,
  fixtureUid: string,
): Promise<{
  opticalBeamCount: number;
  atmosphericBeamCount: number;
  atmosphericDraws: number;
  visibleBeamCount: number;
  visibleSpotLightCount: number;
} | null> {
  return page.evaluate(async (uid) => {
    const api = (window as any).visualizerApi;
    const scene = api?.getScene?.();
    const root = scene?.getObjectByName?.(`Fixture_${uid}`);
    if (!root) return null;

    const stats = {
      opticalBeamCount: 0,
      atmosphericBeamCount: 0,
      atmosphericDraws: 0,
      visibleBeamCount: 0,
      visibleSpotLightCount: 0,
    };

    root.traverse((object: any) => {
      if (object.name.startsWith("Beam_")) {
        if (object.visible === true) {
          stats.visibleBeamCount += 1;
        }
      } else if (
        object.name.startsWith("SpotLight_") &&
        object.visible === true
      ) {
        stats.visibleSpotLightCount += 1;
      }
    });

    const lightIds = new Set<number>();
    scene.traverse((object: any) => {
      if (
        object.name.startsWith(`OpticalSurface:${uid}:`) &&
        object.visible &&
        object.intensity > 0.01
      )
        lightIds.add(object.id);
    });
    stats.opticalBeamCount = lightIds.size;
    const { getOpticalRenderContext } = await import(
      "/features/visualizer/rendering/effects/optical-render-context.ts"
    );
    const atmosphere = getOpticalRenderContext(scene)?.scene;
    atmosphere?.traverse((object: any) => {
      if (object.name !== "EmitterVolumes" || !object.visible) return;
      const shape = object.geometry.getAttribute("volumeShape");
      let matching = 0;
      for (let i = 0; i < object.count; i++)
        if (lightIds.has(shape.getZ(i))) matching++;
      stats.atmosphericBeamCount += matching;
      if (matching) stats.atmosphericDraws++;
    });

    return stats;
  }, fixtureUid);
}

/**
 * Installs the Generic moving spot fixture used by visualizer render tests.
 */
async function installMovingSpotFixture(page: Page): Promise<string> {
  return page.evaluate(() => {
    const fixtureUid = "77777777-7777-7777-7777-777777777777";
    const stores = (window as any).appStores;
    const parameter = (attribute: string, max = 255) => ({
      resolution: attribute === "Tilt" ? "Fine" : "Coarse",
      attribute: { type: attribute },
      min: 0,
      max,
      offset: { type: "Absolute", data: { value: 0 } },
      is_inverted: false,
      is_snap: false,
      merge_type: attribute === "Intensity" ? "HTP" : "LTP",
      use_grandmaster: attribute === "Intensity",
    });
    const customParameter = (label: string, max = 255) => ({
      resolution: "Coarse",
      attribute: { type: "Custom", data: { label } },
      min: 0,
      max,
      offset: { type: "Absolute", data: { value: 0 } },
      is_inverted: false,
      is_snap: true,
      merge_type: "LTP",
      use_grandmaster: false,
    });

    stores.fixtures.set({
      ...stores.fixtures.get(),
      [fixtureUid]: {
        identifiers: {
          id: 777,
          uid: fixtureUid,
          label: "Generic Moving Spot E2E",
        },
        make: "Generic",
        model: "Moving Head Spot 16ch",
        layout: "moving-head",
        mode: "Spot",
        elements: [
          {
            label: "Main",
            parameters: [
              parameter("Pan", 540),
              parameter("Tilt", 540),
              parameter("Intensity"),
              customParameter("Color Wheel"),
              parameter("Zoom"),
            ],
          },
        ],
        geometry: {
          nodes: [],
          roots: [],
        },
        placement: {
          position: { x: 0, y: 1, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
        },
      },
    });

    return fixtureUid;
  });
}

/** Writes immediate fixture output for a renderer-only fixture created in browser state. */
async function setFixtureImmediateOutput(
  page: Page,
  fixtureUid: string,
  output: Record<string, number>,
): Promise<void> {
  await page.evaluate(
    async ({ fixtureUid, output }) => {
      const { setParametersImmediate } = await import("/state/appStores.ts");
      const stores = (window as any).appStores;
      setParametersImmediate(
        new Map<string, Record<string, number>[]>(
          stores.getParametersImmediate(),
        ).set(fixtureUid, [output]),
      );
    },
    { fixtureUid, output },
  );
}

/** Holds immediate fixture output long enough for renderer frame updates to consume it. */
async function holdFixtureImmediateOutput(
  page: Page,
  fixtureUid: string,
  output: Record<string, number>,
): Promise<void> {
  await page.evaluate(
    async ({ fixtureUid, output }) => {
      const { setParametersImmediate } = await import("/state/appStores.ts");
      let framesRemaining = 120;
      const writeOutput = () => {
        const stores = (window as any).appStores;
        setParametersImmediate(
          new Map<string, Record<string, number>[]>(
            stores.getParametersImmediate(),
          ).set(fixtureUid, [output]),
        );
        framesRemaining -= 1;
        if (framesRemaining > 0) {
          requestAnimationFrame(writeOutput);
        }
      };
      writeOutput();
    },
    { fixtureUid, output },
  );
}

/**
 * Reads yoke arm orientation stats for the Generic moving spot fixture.
 */
async function movingSpotSceneStats(
  page: Page,
  fixtureUid: string,
): Promise<{
  leftArm: { x: number; z: number };
  rightArm: { x: number; z: number };
  yokeRotationY: number;
} | null> {
  return page.evaluate((uid) => {
    const api = (window as any).visualizerApi;
    const scene = api?.getScene?.();
    const root = scene?.getObjectByName?.(`Fixture_${uid}`);
    const leftArm = root?.getObjectByName?.("LeftArm");
    const rightArm = root?.getObjectByName?.("RightArm");
    const yoke = root?.getObjectByName?.("Yoke");
    if (!root || !leftArm || !rightArm || !yoke) return null;

    root.updateMatrixWorld(true);
    const leftPosition = new leftArm.position.constructor();
    const rightPosition = new rightArm.position.constructor();
    leftArm.getWorldPosition(leftPosition);
    rightArm.getWorldPosition(rightPosition);

    const round = (value: number) => Number(value.toFixed(4));
    return {
      leftArm: {
        x: round(leftPosition.x - root.position.x),
        z: round(leftPosition.z - root.position.z),
      },
      rightArm: {
        x: round(rightPosition.x - root.position.x),
        z: round(rightPosition.z - root.position.z),
      },
      yokeRotationY: round(yoke.rotation.y),
    };
  }, fixtureUid);
}

/**
 * Reads beam visibility and lens color for the Generic moving spot fixture.
 */
async function movingSpotBeamStats(
  page: Page,
  fixtureUid: string,
): Promise<{
  beamVisible: boolean;
  lensColor: { r: number; g: number; b: number };
} | null> {
  return page.evaluate((uid) => {
    const api = (window as any).visualizerApi;
    const scene = api?.getScene?.();
    const root = scene?.getObjectByName?.(`Fixture_${uid}`);
    const beam = scene?.getObjectByName?.(`OpticalSurface:${uid}:MainEmitter`);
    const lens = root?.getObjectByName?.("Lens") as
      | { material?: { color?: { r: number; g: number; b: number } } }
      | undefined;
    const color = lens?.material?.color;
    if (!root || !beam || !color) return null;

    const round = (value: number) => Number(value.toFixed(4));
    return {
      beamVisible: beam.visible && beam.intensity > 0.01,
      lensColor: {
        r: round(color.r),
        g: round(color.g),
        b: round(color.b),
      },
    };
  }, fixtureUid);
}

/**
 * Reads split-color state used by shared atmospheric and surface projection for the moving spot.
 */
async function movingSpotBeamMaterialStats(
  page: Page,
  fixtureUid: string,
): Promise<{
  beamVisible: boolean;
  splitColorAmount: number;
  primaryColor: { r: number; g: number; b: number };
  secondaryColor: { r: number; g: number; b: number };
} | null> {
  return page.evaluate((uid) => {
    const api = (window as any).visualizerApi;
    const scene = api?.getScene?.();
    const root = scene?.getObjectByName?.(`Fixture_${uid}`);
    const beam = scene?.getObjectByName?.(
      `OpticalSurface:${uid}:MainEmitter`,
    ) as
      | {
          visible?: boolean;
          intensity: number;
          color: { r: number; g: number; b: number };
          secondaryColor: { r: number; g: number; b: number };
          splitColor: boolean;
        }
      | undefined;
    const primary = beam?.color;
    const secondary = beam?.secondaryColor;
    const splitColorAmount = beam?.splitColor ? 1 : 0;
    if (!root || !beam || !primary || !secondary) return null;

    const round = (value: number) => Number(value.toFixed(4));
    return {
      beamVisible: Boolean(beam.visible) && beam.intensity > 0.01,
      splitColorAmount: round(splitColorAmount ?? 0),
      primaryColor: {
        r: round(primary.r),
        g: round(primary.g),
        b: round(primary.b),
      },
      secondaryColor: {
        r: round(secondary.r),
        g: round(secondary.g),
        b: round(secondary.b),
      },
    };
  }, fixtureUid);
}

type PngRegion = { x: number; y: number; width: number; height: number };

type DecodedPng = {
  width: number;
  height: number;
  channels: number;
  data: Buffer;
};

type RedDominantStats = {
  count: number;
  bounds: PngRegion | null;
};

/**
 * Finds the largest visible canvas box for screenshot analysis.
 */
async function largestVisibleCanvasBox(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  let visibleCanvasBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null = null;

  await expect
    .poll(async () => {
      visibleCanvasBox = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>(
          '[data-panel-id="panel-Visualizer"] canvas[aria-label="3D visualizer viewport"]',
        );
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        const x = Math.max(0, rect.left);
        const y = Math.max(0, rect.top);
        const right = Math.min(window.innerWidth, rect.right);
        const bottom = Math.min(window.innerHeight, rect.bottom);
        const width = Math.max(0, right - x);
        const height = Math.max(0, bottom - y);
        if (width <= 10 || height <= 10) return null;
        return {
          x,
          y,
          width,
          height,
        };
      });
      return visibleCanvasBox;
    })
    .not.toBeNull();

  return visibleCanvasBox!;
}

/**
 * Computes the luma range of decoded PNG pixels.
 */
function pngLumaRange(png: Buffer): number {
  const decoded = decodePng(png);
  let minLuma = 255;
  let maxLuma = 0;

  for (let y = 0; y < decoded.height; y++) {
    const rowOffset = y * decoded.width * decoded.channels;
    for (let x = 0; x < decoded.width; x++) {
      const offset = rowOffset + x * decoded.channels;
      const luma =
        decoded.data[offset] * 0.2126 +
        decoded.data[offset + 1] * 0.7152 +
        decoded.data[offset + 2] * 0.0722;
      minLuma = Math.min(minLuma, luma);
      maxLuma = Math.max(maxLuma, luma);
    }
  }

  return maxLuma - minLuma;
}

/**
 * Counts red-dominant pixels in a decoded PNG region.
 */
function pngRedDominantStats(
  png: Buffer,
  region?: PngRegion,
): RedDominantStats {
  const decoded = decodePng(png);
  const scanRegion = clampRegion(
    region ?? {
      x: 0,
      y: 0,
      width: decoded.width,
      height: decoded.height,
    },
    decoded.width,
    decoded.height,
  );

  let count = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = 0;
  let maxY = 0;

  for (let y = scanRegion.y; y < scanRegion.y + scanRegion.height; y++) {
    const rowOffset = y * decoded.width * decoded.channels;
    for (let x = scanRegion.x; x < scanRegion.x + scanRegion.width; x++) {
      const offset = rowOffset + x * decoded.channels;
      const red = decoded.data[offset];
      const green = decoded.data[offset + 1];
      const blue = decoded.data[offset + 2];

      if (red > 120 && red > green * 1.8 && red > blue * 1.8) {
        count++;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  return {
    count,
    bounds:
      count > 0
        ? {
            x: minX,
            y: minY,
            width: maxX - minX + 1,
            height: maxY - minY + 1,
          }
        : null,
  };
}

/**
 * Clamps a pixel sampling region to decoded PNG bounds.
 */
function clampRegion(
  region: PngRegion,
  width: number,
  height: number,
): PngRegion {
  const x = Math.max(0, Math.floor(region.x));
  const y = Math.max(0, Math.floor(region.y));
  return {
    x,
    y,
    width: Math.max(0, Math.min(width - x, Math.ceil(region.width))),
    height: Math.max(0, Math.min(height - y, Math.ceil(region.height))),
  };
}

/**
 * Decodes a PNG buffer into raw image metadata and pixels.
 */
function decodePng(png: Buffer): DecodedPng {
  const signature = png.subarray(0, 8).toString("hex");
  expect(signature).toBe("89504e470d0a1a0a");

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  expect(bitDepth).toBe(8);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  expect(channels).toBeGreaterThan(0);

  const inflated = inflateSync(Buffer.concat(idatChunks));
  const stride = width * channels;
  const previous = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);
  const data = Buffer.alloc(height * stride);
  let inputOffset = 0;

  for (let y = 0; y < height; y++) {
    const filter = inflated[inputOffset++];
    inflated.copy(current, 0, inputOffset, inputOffset + stride);
    inputOffset += stride;

    unfilterScanline(current, previous, filter, channels);

    current.copy(data, y * stride);
    current.copy(previous);
  }

  return {
    width,
    height,
    channels,
    data,
  };
}

/**
 * Reverses PNG scanline filtering for one decoded row.
 */
function unfilterScanline(
  scanline: Buffer,
  previous: Buffer,
  filter: number,
  bytesPerPixel: number,
): void {
  for (let index = 0; index < scanline.length; index++) {
    const left = index >= bytesPerPixel ? scanline[index - bytesPerPixel] : 0;
    const up = previous[index] ?? 0;
    const upLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;

    if (filter === 1) {
      scanline[index] = (scanline[index] + left) & 0xff;
    } else if (filter === 2) {
      scanline[index] = (scanline[index] + up) & 0xff;
    } else if (filter === 3) {
      scanline[index] = (scanline[index] + Math.floor((left + up) / 2)) & 0xff;
    } else if (filter === 4) {
      scanline[index] = (scanline[index] + paeth(left, up, upLeft)) & 0xff;
    }
  }
}

/**
 * Computes the Paeth predictor used by PNG scanline decoding.
 */
function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);

  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) {
    return left;
  }
  return upDistance <= upLeftDistance ? up : upLeft;
}

/** Verifies repository-defined generic bars render without installed fixture files. */
test("generic sample bars render their complete segment layouts", async ({
  page,
}, testInfo) => {
  await page.goto("/?visualizer:offscreenCanvas=false");
  await waitForVisualizerReady(page);
  const fixtures: string[] = [];
  for (const [index, model] of [
    "12-segment RGBW Bar",
    "100-segment LED Bar",
    "10-segment Rotating RGBW Bar",
  ].entries()) {
    fixtures.push(
      await installOwnedBackendFixture(page, {
        id: 800 + index,
        make: "Generic",
        model,
        mode: index === 1 ? "RGB" : "RGBW",
        label: model,
        update_existing_ids: [],
        update_existing_only: false,
        placement: {
          position: { x: (index - 1) * 2, y: 1, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
        },
      }),
    );
  }
  await expect
    .poll(() => rotatingWashBeamSceneStats(page, fixtures[2]))
    .toMatchObject({
      lensCount: 10,
      beamCount: 10,
      topStripCount: 0,
      bottomStripCount: 0,
    });
  await expect
    .poll(() =>
      page.evaluate((uids) => {
        const scene = (window as any).visualizerApi?.getScene?.();
        return uids.map((uid) =>
          Boolean(scene?.getObjectByName(`Fixture_${uid}`)),
        );
      }, fixtures),
    )
    .toEqual([true, true, true]);
  await waitForFixtureStoreHydration(page);
  await submitCommand(page, "fix 800>802 int @ 100 red @ 100");
  await expect
    .poll(() =>
      page.evaluate((uids) => {
        const scene = (window as any).visualizerApi?.getScene?.();
        return uids
          .slice(0, 2)
          .map(
            (uid) =>
              scene
                ?.getObjectByName(`Fixture_${uid}`)
                ?.getObjectByName("Pixels")?.count,
          );
      }, fixtures),
    )
    .toEqual([12, 100]);
  await expect
    .poll(() =>
      page.evaluate((uid) => {
        const root = (window as any).visualizerApi
          ?.getScene?.()
          ?.getObjectByName(`Fixture_${uid}`);
        let count = 0;
        root?.traverse((object: any) => {
          if (
            object.name.startsWith("Lens_") &&
            object.material?.color?.r > 0.25
          )
            count += 1;
        });
        return count;
      }, fixtures[2]),
    )
    .toBe(10);
  const canvasBox = await largestVisibleCanvasBox(page);
  await testInfo.attach("generic-sample-bars", {
    body: await page.screenshot({ clip: canvasBox }),
    contentType: "image/png",
  });
});
