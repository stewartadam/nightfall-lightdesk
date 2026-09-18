// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const BUILTIN_COLOR_PATHS = [
  { id: 1, label: "RGB", space: "Rgb" },
  { id: 2, label: "HSV", space: "Hsv" },
  { id: 3, label: "CMY", space: "Cmy" },
] as const;

type OwnedRgbFixture = {
  id: number;
  uid: string;
};

/** Replaces each backend and proves only the immutable color-path catalog remains. */
test.afterEach(async ({ backendSlot, page }) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  if (page.isClosed() || page.url() === "about:blank") return;
  await page.reload();
  await waitForDockviewApp(page);
  await expect
    .poll(() => ownedColorPathStoreState(page))
    .toEqual({
      colorPaths: BUILTIN_COLOR_PATHS,
      cues: 0,
      fixtures: 0,
      sequences: 0,
    });
});

/** Reads the immutable catalog and mutable stores exercised by this suite. */
async function ownedColorPathStoreState(page: Page): Promise<object> {
  return page.evaluate(() => {
    const stores = (window as any).appStores;
    return {
      colorPaths: (
        Object.values(stores.colorPaths.get()) as Array<{
          identifiers: { id: number; label: string };
          interpolation_space: string;
        }>
      )
        .map((path) => ({
          id: path.identifiers.id,
          label: path.identifiers.label,
          space: path.interpolation_space,
        }))
        .sort((left, right) => left.id - right.id),
      cues: Object.keys(stores.cues.get()).length,
      fixtures: Object.keys(stores.fixtures.get()).length,
      sequences: Object.keys(stores.sequences.get()).length,
    };
  });
}

/** Opens one color-path scenario against a fresh backend showfile. */
async function openOwnedColorPathApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.colorPaths?.get) &&
      Boolean((window as any).appStores?.cues?.get) &&
      Boolean((window as any).appStores?.fixtures?.get) &&
      Boolean((window as any).appStores?.sequences?.get),
  );
  await expect
    .poll(() => ownedColorPathStoreState(page))
    .toEqual({
      colorPaths: BUILTIN_COLOR_PATHS,
      cues: 0,
      fixtures: 0,
      sequences: 0,
    });
}

/** Focuses a Dockview panel by stable panel id rather than displayed tab title. */
async function focusDockPanel(page: Page, panelId: string): Promise<void> {
  await page.evaluate((targetPanelId) => {
    const api = (window as any).appStores.dockApi.get();
    const panel = api.getPanel(targetPanelId);
    if (!panel) {
      throw new Error(`Expected Dockview panel ${targetPanelId}`);
    }
    panel.api.setActive();
    const location = panel.api.location;
    if (location?.type === "edge" && location.position) {
      api.getEdgeGroup(location.position)?.expand();
    }
    panel.focus();
  }, panelId);
}

/** Reads an element's rendered background color as lowercase CSS hex. */
async function backgroundColorHex(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const channels = window
      .getComputedStyle(element)
      .backgroundColor.match(/\d+(?:\.\d+)?/gu)
      ?.slice(0, 3)
      .map((channel) => Number(channel));
    if (!channels || channels.length < 3) {
      throw new Error("Expected an RGB background color");
    }
    return `#${channels
      .map((channel) =>
        Math.round(channel).toString(16).padStart(2, "0").slice(0, 2),
      )
      .join("")}`;
  });
}

/** Reads the CIE canvas pixel color located under the center of an SVG anchor. */
async function canvasColorUnderAnchorHex(
  canvasLocator: Locator,
  anchorLocator: Locator,
): Promise<string> {
  const canvasBox = await canvasLocator.boundingBox();
  const anchorBox = await anchorLocator.boundingBox();
  if (!canvasBox || !anchorBox) {
    throw new Error("Expected canvas and anchor bounds");
  }
  const relativeX =
    (anchorBox.x + anchorBox.width / 2 - canvasBox.x) / canvasBox.width;
  const relativeY =
    (anchorBox.y + anchorBox.height / 2 - canvasBox.y) / canvasBox.height;
  return canvasLocator.evaluate(
    (element, point) => {
      const canvas = element as HTMLCanvasElement;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Expected CIE canvas context");
      }
      const x = Math.min(
        canvas.width - 1,
        Math.max(0, Math.floor(point.x * canvas.width)),
      );
      const y = Math.min(
        canvas.height - 1,
        Math.max(0, Math.floor(point.y * canvas.height)),
      );
      const [red = 0, green = 0, blue = 0] = context.getImageData(
        x,
        y,
        1,
        1,
      ).data;
      return `#${[red, green, blue]
        .map((channel) => channel.toString(16).padStart(2, "0"))
        .join("")}`;
    },
    { x: relativeX, y: relativeY },
  );
}

/** Reads a color path gradient canvas pixel at a normalized horizontal position. */
async function gradientCanvasColorHex(
  canvasLocator: Locator,
  progress: number,
): Promise<string> {
  return canvasLocator.evaluate((element, sampleProgress) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (!context || canvas.width < 1 || canvas.height < 1) {
      throw new Error("Expected gradient canvas context");
    }
    const x = Math.min(
      canvas.width - 1,
      Math.max(0, Math.round(sampleProgress * (canvas.width - 1))),
    );
    const y = Math.floor(canvas.height / 2);
    const [red = 0, green = 0, blue = 0] = context.getImageData(
      x,
      y,
      1,
      1,
    ).data;
    return `#${[red, green, blue]
      .map((channel) => channel.toString(16).padStart(2, "0"))
      .join("")}`;
  }, progress);
}

/** Parses CSS hex notation into integer RGB channels for preview assertions. */
function rgbChannelsFromHex(hex: string): {
  red: number;
  green: number;
  blue: number;
} {
  const normalized = hex.replace(/^#/u, "");
  return {
    red: Number.parseInt(normalized.slice(0, 2), 16),
    green: Number.parseInt(normalized.slice(2, 4), 16),
    blue: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

/** Returns whether two CSS hex colors match within a per-channel tolerance. */
function hexColorsMatchWithinTolerance(
  actual: string | null,
  expected: string,
  tolerance = 1,
): boolean {
  if (!actual) return false;
  const actualChannels = rgbChannelsFromHex(actual);
  const expectedChannels = rgbChannelsFromHex(expected);
  return (
    Math.abs(actualChannels.red - expectedChannels.red) <= tolerance &&
    Math.abs(actualChannels.green - expectedChannels.green) <= tolerance &&
    Math.abs(actualChannels.blue - expectedChannels.blue) <= tolerance
  );
}

/** Returns whether an SVG anchor fill matches the CIE canvas pixel below it. */
async function anchorFillMatchesCanvasColor(
  canvasLocator: Locator,
  anchorLocator: Locator,
  tolerance = 6,
): Promise<boolean> {
  return hexColorsMatchWithinTolerance(
    await anchorLocator.getAttribute("fill"),
    await canvasColorUnderAnchorHex(canvasLocator, anchorLocator),
    tolerance,
  );
}

/** Builds an inline absolute-percent cue value for seeded RGB cues. */
function inlinePercent(value: number): object {
  return {
    type: "Inline",
    data: { type: "AbsolutePercent", data: { value } },
  };
}

/** Builds a fixed transition mode for seeded sequences. */
function fixed(secs: number, nanos = 0): object {
  return {
    type: "Fixed",
    data: { secs, nanos },
  };
}

/** Builds a deterministic metadata cue UID from a sequence UID and suffix. */
function sequenceMetaCueUid(sequenceUid: string, suffix: string): string {
  return sequenceUid.replace(/[0-9a-f]{12}$/i, suffix);
}

/** Builds an empty setup or release meta-cue for a sequence definition. */
function metaCue(cueUid: string, label: string): object {
  return {
    identifiers: {
      id: 0,
      uid: cueUid,
      label,
    },
    trigger: { type: "Manual" },
    transitions: {},
    transitions_by_attribute: {},
    instructions: [],
    parts: [],
    references: {},
    tracking_flags: "HTP",
  };
}

/** Builds a cue with one RGB whole-fixture row. */
function rgbCue(
  cueId: number,
  cueUid: string,
  fixtureUid: string,
  red: number,
  green: number,
  blue: number,
): object {
  return {
    identifiers: {
      id: cueId,
      uid: cueUid,
      label: `Color Path Cue ${cueId}`,
    },
    trigger: { type: "Manual" },
    transitions: {},
    transitions_by_attribute: {},
    instructions: [
      {
        selection: {
          source: {
            type: "Resolved",
            data: [{ fixture_uid: fixtureUid, index: null }],
          },
          clauses: [],
        },
        cue_instruction: {
          values: {
            Red: inlinePercent(red),
            Green: inlinePercent(green),
            Blue: inlinePercent(blue),
          },
          transitions: {},
          transitions_by_attribute: {},
          transitions_by_fixture_attribute: [],
        },
      },
    ],
    parts: [],
    references: {},
    tracking_flags: "HTP",
  };
}

/** Builds a sequence containing one cue step. */
function sequence(
  sequenceId: number,
  sequenceUid: string,
  cueUid: string,
): object {
  return {
    identifiers: {
      id: sequenceId,
      uid: sequenceUid,
      label: `Color Path Sequence ${sequenceId}`,
    },
    steps: [cueUid],
    references: {},
    wrap: false,
    release_on_start: false,
    setup_cue: metaCue(
      sequenceMetaCueUid(sequenceUid, "000000000000"),
      "Setup",
    ),
    release_cue: metaCue(
      sequenceMetaCueUid(sequenceUid, "000000000002"),
      "Release",
    ),
    default_timing: {
      delay_in: fixed(0),
      fade_in: fixed(1),
      curve_in: "Linear",
      delay_out: fixed(0),
      fade_out: fixed(0),
      curve_out: "Linear",
    },
  };
}

/** Opens the color path panel through the app's dockview API. */
async function openColorPathPanel(page: Page) {
  await page.waitForFunction(
    () =>
      Boolean((window as any).appStores?.dockApi?.get?.()) &&
      Object.keys((window as any).appStores?.colorPaths?.get?.() ?? {}).length >
        0,
  );
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    const api = stores.dockApi.get();
    if (!api.getPanel("panel-ColorPathPanel-e2e")) {
      api.addPanel({
        id: "panel-ColorPathPanel-e2e",
        component: "ColorPathPanel",
        title: "Color Paths",
        params: {},
      });
    }
    api.getPanel("panel-ColorPathPanel-e2e")?.focus();
  });
}

/** Waits for app stores needed by color path assignment tests. */
async function waitForAssignmentStores(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.dockApi?.get?.()) &&
      Object.keys((window as any).appStores?.fixtures?.get?.() ?? {}).length >
        0 &&
      Object.keys((window as any).appStores?.colorPaths?.get?.() ?? {}).length >
        0,
  );
}

/** Sends a websocket command and rejects a failed terminal outcome. */
async function sendCommand(page: Page, data: object): Promise<void> {
  await page.evaluate(async (commandData) => {
    const stores = (window as any).appStores;
    if (typeof stores?.sendAndAwait !== "function") {
      throw new Error("appStores.sendAndAwait did not initialize");
    }
    const result = await stores.sendAndAwait(commandData);
    if (result.outcome.type !== "Succeeded") {
      throw new Error(
        `color-path panel command failed: ${JSON.stringify(result)}`,
      );
    }
  }, data);
}

/** Creates the exact RGB fixture used by cue assignment coverage. */
async function storeOwnedRgbFixture(page: Page): Promise<OwnedRgbFixture> {
  const fixtureId = Math.floor(900_000 + Math.random() * 50_000);
  await sendCommand(page, {
    module: "FixtureLibraryCommand",
    command: {
      type: "CreateFixtureFromLibrary",
      data: {
        id: fixtureId,
        make: "Generic",
        model: "Moving Head RGBW",
        mode: "Spot",
        label: `Owned Color Path Fixture ${fixtureId}`,
        update_existing_ids: [],
        update_existing_only: false,
      },
    },
  });
  await expect
    .poll(() =>
      page.evaluate((ownedFixtureId) => {
        const fixtures = Object.values(
          (window as any).appStores.fixtures.get(),
        ) as Array<{ identifiers: { id: number; uid: string } }>;
        return fixtures.find(
          (fixture) => fixture.identifiers.id === ownedFixtureId,
        )?.identifiers.uid;
      }, fixtureId),
    )
    .not.toBeUndefined();
  const uid = await page.evaluate((ownedFixtureId) => {
    const fixtures = Object.values(
      (window as any).appStores.fixtures.get(),
    ) as Array<{ identifiers: { id: number; uid: string } }>;
    const fixture = fixtures.find(
      (candidate) => candidate.identifiers.id === ownedFixtureId,
    );
    if (!fixture) throw new Error(`owned fixture ${ownedFixtureId} not found`);
    return fixture.identifiers.uid;
  }, fixtureId);
  return { id: fixtureId, uid };
}

/** Opens a cue editor panel for a cue that belongs to a sequence. */
async function openCueEditor(
  page: Page,
  cueUid: string,
  sequenceId: number,
): Promise<void> {
  await page.evaluate(
    ({ cueUid, sequenceId }) => {
      const stores = (window as any).appStores;
      const api = stores.dockApi.get();
      const panelId = "panel-CueEditor-color-path-assignment-e2e";
      if (!api.getPanel("panel-PropertiesInspector")) {
        api.addPanel({
          id: "panel-PropertiesInspector",
          component: "PropertiesInspector",
          title: "Properties",
          params: {},
        });
      }
      api.getPanel(panelId)?.api.close();
      const referencePanel = api.getPanel("panel-FixtureGrid");
      const panel = api.addPanel({
        id: panelId,
        component: "CueEditor",
        title: "Color Path Assignment E2E",
        params: {
          initialPanelId: panelId,
          initialCueUid: cueUid,
          initialSequenceId: sequenceId,
        },
        ...(referencePanel
          ? {
              position: {
                referencePanel: referencePanel.id,
                direction: "within",
              },
            }
          : {}),
      });
      panel.api.setActive();
      panel.focus();
    },
    { cueUid, sequenceId },
  );
}

/** Verifies the color path editor renders persisted definitions and live preview geometry. */
test("color path editor renders preview swatches and route overlay", async ({
  backendSlot,
  page,
}) => {
  await openOwnedColorPathApp(page, backendSlot.backendPort);
  await openColorPathPanel(page);

  const panel = page.locator('[data-panel-id="panel-ColorPathPanel-e2e"]');
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("button", { name: /^1\s+RGB\b/u }),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: /HSV/ })).toBeVisible();
  await expect(panel.getByText("Path Type")).toHaveCount(0);
  await expect(panel.getByText("Brightness")).toBeVisible();
  await expect(panel.getByLabel("Red")).toHaveCount(0);
  await expect(panel.getByLabel("Green")).toHaveCount(0);
  await expect(panel.getByLabel("Blue")).toHaveCount(0);
  await expect(panel.getByText(/samples$/u)).toHaveCount(0);
  const labelInput = panel.getByLabel("Label");
  await expect(panel.getByRole("textbox", { name: "ID" })).toHaveCount(0);
  await expect(labelInput).toBeDisabled();
  await expect(panel.getByLabel("Interpolation")).toBeDisabled();
  await expect(panel.getByLabel("Hue Route")).toBeDisabled();
  await expect(panel.getByLabel("Curve")).toBeDisabled();
  await expect(
    panel
      .locator('[data-testid="color-path-timing-row"][data-timing="In Color"]')
      .getByTestId("color-path-timing-slider"),
  ).toBeDisabled();
  await expect(
    panel.getByTestId("color-path-midpoint-brightness"),
  ).toBeDisabled();
  await expect(panel.getByText("Color Paths").first()).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Revert" })).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Delete selected path" }),
  ).toBeDisabled();
  await expect(
    panel.getByRole("button", { name: "Duplicate selected path" }),
  ).toBeEnabled();
  await panel.getByRole("button", { name: "Duplicate selected path" }).click();
  await expect(labelInput).toHaveValue(/ Copy$/u);
  await expect(labelInput).toBeEnabled();
  await expect(panel.getByRole("textbox", { name: "ID" })).toHaveCount(0);
  await expect(panel.getByLabel("Interpolation")).toBeEnabled();
  await expect(panel.getByTestId("color-path-swatch")).toHaveCount(0);
  await expect
    .poll(() =>
      panel.evaluate((element) => {
        const toolbar = element.querySelector(
          '[data-component="PanelToolbar"]',
        );
        const toolbarText = toolbar?.textContent?.trim() ?? "";
        const controls = [...element.querySelectorAll("label")].map((label) => {
          const rect = label.getBoundingClientRect();
          return {
            width: rect.width,
            height: rect.height,
          };
        });
        return {
          toolbarText,
          controlsHaveArea: controls.every(
            (control) => control.width > 0 && control.height > 0,
          ),
        };
      }),
    )
    .toEqual({ toolbarText: "", controlsHaveArea: true });
  const gradientCanvas = panel.getByTestId("color-path-gradient-canvas");
  await expect(gradientCanvas).toBeVisible();
  await expect
    .poll(() =>
      gradientCanvas.evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        return canvas.width > 60 && canvas.height > 0;
      }),
    )
    .toBe(true);
  await expect(panel.getByTestId("color-path-route-overlay")).toBeVisible();
  const background = panel.getByTestId("cie-chromaticity-background");
  await expect(background).toBeVisible();
  await expect
    .poll(async () =>
      background.evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        const context = canvas.getContext("2d");
        if (!context || canvas.width < 2 || canvas.height < 2) {
          return { hasVariation: false, hasDimmedOutside: false };
        }
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const first = image.data.slice(0, 3).join(",");
        let hasVariation = false;
        for (let offset = 4; offset < image.data.length; offset += 4) {
          if (image.data.slice(offset, offset + 3).join(",") !== first) {
            hasVariation = true;
            break;
          }
        }
        const centerOffset =
          (Math.floor(canvas.height / 2) * canvas.width +
            Math.floor(canvas.width / 2)) *
          4;
        const centerBrightness =
          image.data[centerOffset] +
          image.data[centerOffset + 1] +
          image.data[centerOffset + 2];
        const cornerBrightness = image.data[0] + image.data[1] + image.data[2];
        return {
          hasVariation,
          hasDimmedOutside:
            cornerBrightness > 30 && cornerBrightness < centerBrightness,
        };
      }),
    )
    .toEqual({ hasVariation: true, hasDimmedOutside: true });
  await expect(panel.getByTestId("cie-spectral-locus")).toBeVisible();
  await expect(panel.getByTestId("cie-e154-rgb-triangle")).toBeVisible();
  const endpointLine = panel.getByTestId("cie-route-endpoint-line");
  await expect(endpointLine).toBeVisible();
  await expect(endpointLine).toHaveAttribute("stroke", "#050505");
  await expect(endpointLine).toHaveAttribute("stroke-width", "0.8");
  await expect
    .poll(async () => {
      const points = await endpointLine.getAttribute("points");
      return points?.trim().split(/\s+/u).length ?? 0;
    })
    .toBe(60);
  const interpolationSelect = panel.getByLabel("Interpolation");
  await expect(interpolationSelect.locator("option[value='']")).toHaveCount(0);
  await interpolationSelect.selectOption("Rgb");
  await expect
    .poll(async () => endpointLine.getAttribute("points"))
    .not.toBeNull();
  const rgbRoutePoints = await endpointLine.getAttribute("points");
  expect(rgbRoutePoints).not.toBeNull();
  await interpolationSelect.selectOption("Hsv");
  await expect
    .poll(async () => endpointLine.getAttribute("points"))
    .not.toBe(rgbRoutePoints);
  await expect
    .poll(async () => {
      const points = await endpointLine.getAttribute("points");
      return points?.trim().split(/\s+/u).length ?? 0;
    })
    .toBe(60);
  await expect(panel.getByTestId("cie-route-endpoint")).toHaveCount(2);

  const routePointCount = await panel.getByTestId("cie-route-endpoint").count();
  expect(routePointCount).toBe(2);
  const startAnchor = panel.locator(
    '[data-testid="cie-route-endpoint"][data-anchor="start"]',
  );
  const endAnchor = panel.locator(
    '[data-testid="cie-route-endpoint"][data-anchor="end"]',
  );
  const routeOverlay = panel.getByTestId("color-path-route-overlay");
  const startColorControl = panel.locator(
    '[data-testid="color-path-preview-color-control"][data-anchor="start"]',
  );
  const endColorControl = panel.locator(
    '[data-testid="color-path-preview-color-control"][data-anchor="end"]',
  );
  const startInput = panel.getByLabel("Start");
  const endInput = panel.getByLabel("Destination");
  await expect
    .poll(() => gradientCanvasColorHex(gradientCanvas, 0))
    .toBe(await startInput.inputValue());
  await expect
    .poll(() => gradientCanvasColorHex(gradientCanvas, 1))
    .toBe(await endInput.inputValue());
  await expect
    .poll(() => backgroundColorHex(startColorControl))
    .toBe(await startInput.inputValue());
  await expect
    .poll(() => backgroundColorHex(endColorControl))
    .toBe(await endInput.inputValue());
  const authoredStart = await startInput.inputValue();
  const authoredEnd = await endInput.inputValue();
  const inColorTiming = panel.locator(
    '[data-testid="color-path-timing-row"][data-timing="In Color"]',
  );
  const inColorTimingSlider = inColorTiming.getByTestId(
    "color-path-timing-slider",
  );
  await expect(inColorTimingSlider).toHaveValue("0");
  await inColorTimingSlider.fill("25");
  await expect(inColorTimingSlider).toHaveValue("25");
  await expect
    .poll(() => gradientCanvasColorHex(gradientCanvas, 0))
    .toBe(authoredStart);
  await expect
    .poll(() => gradientCanvasColorHex(gradientCanvas, 1))
    .toBe(authoredEnd);
  await expect
    .poll(() => backgroundColorHex(startColorControl))
    .toBe(authoredStart);
  await expect
    .poll(() => backgroundColorHex(endColorControl))
    .toBe(authoredEnd);
  const midpointBeforeBrightness = await gradientCanvasColorHex(
    gradientCanvas,
    0.5,
  );
  const brightnessSlider = panel.getByTestId("color-path-midpoint-brightness");
  await expect(brightnessSlider).toHaveValue("100");
  await brightnessSlider.fill("50");
  await expect(brightnessSlider).toHaveValue("50");
  await expect
    .poll(() => gradientCanvasColorHex(gradientCanvas, 0))
    .toBe(authoredStart);
  await expect
    .poll(() => gradientCanvasColorHex(gradientCanvas, 1))
    .toBe(authoredEnd);
  await expect
    .poll(() => gradientCanvasColorHex(gradientCanvas, 0.5))
    .not.toBe(midpointBeforeBrightness);
  await routeOverlay.scrollIntoViewIfNeeded();
  await expect
    .poll(() => anchorFillMatchesCanvasColor(background, endAnchor))
    .toBe(true);
  await expect(endAnchor).not.toHaveAttribute("fill", "#0000ff");
  await expect.poll(() => backgroundColorHex(endColorControl)).toBe("#0000ff");

  const initialStart = await startInput.inputValue();
  await expect
    .poll(() =>
      routeOverlay.evaluate((element) => {
        const panel = element.closest(
          '[data-panel-id="panel-ColorPathPanel-e2e"]',
        );
        const panelRect = panel?.getBoundingClientRect();
        const overlayRect = element.getBoundingClientRect();
        return Boolean(
          panelRect &&
            overlayRect.left >= panelRect.left &&
            overlayRect.right <= panelRect.right,
        );
      }),
    )
    .toBe(true);
  const routeOverlayBox = await routeOverlay.boundingBox();
  const startAnchorBox = await startAnchor.boundingBox();
  expect(routeOverlayBox).not.toBeNull();
  expect(startAnchorBox).not.toBeNull();
  if (!routeOverlayBox || !startAnchorBox) {
    throw new Error("Expected CIE route overlay and start anchor bounds");
  }
  await page.mouse.move(
    startAnchorBox.x + startAnchorBox.width / 2,
    startAnchorBox.y + startAnchorBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    routeOverlayBox.x + routeOverlayBox.width * 0.45,
    routeOverlayBox.y + routeOverlayBox.height * 0.45,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect.poll(() => startInput.inputValue()).not.toBe(initialStart);
  await expect
    .poll(() => anchorFillMatchesCanvasColor(background, startAnchor))
    .toBe(true);
  await expect
    .poll(() => backgroundColorHex(startColorControl))
    .toBe(await startInput.inputValue());

  const draggedStartAnchorBox = await startAnchor.boundingBox();
  expect(draggedStartAnchorBox).not.toBeNull();
  if (!draggedStartAnchorBox) {
    throw new Error("Expected moved start anchor bounds");
  }
  const e154BluePrimaryPreview = {
    x: 0.0366 / 0.8,
    y: 1 - 0.0001 / 0.9,
  };
  await page.mouse.move(
    draggedStartAnchorBox.x + draggedStartAnchorBox.width / 2,
    draggedStartAnchorBox.y + draggedStartAnchorBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    routeOverlayBox.x + routeOverlayBox.width * e154BluePrimaryPreview.x,
    routeOverlayBox.y + routeOverlayBox.height * e154BluePrimaryPreview.y,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => {
      const color = rgbChannelsFromHex(await startInput.inputValue());
      return {
        blue: color.blue,
        greenBelowTen: color.green <= 10,
        redBelowTen: color.red <= 10,
      };
    })
    .toEqual({ blue: 255, greenBelowTen: true, redBelowTen: true });
  await expect
    .poll(() => anchorFillMatchesCanvasColor(background, startAnchor))
    .toBe(true);
  await expect(startAnchor).not.toHaveAttribute(
    "fill",
    await startInput.inputValue(),
  );
  await expect
    .poll(() => backgroundColorHex(startColorControl))
    .toBe(await startInput.inputValue());
});

/** Verifies operators can create and edit a custom color path from the panel. */
test("color path editor creates a custom path definition", async ({
  backendSlot,
  page,
}) => {
  await openOwnedColorPathApp(page, backendSlot.backendPort);
  await openColorPathPanel(page);

  const panel = page.locator('[data-panel-id="panel-ColorPathPanel-e2e"]');
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "New color path" }).click();

  const labelInput = panel.getByLabel("Label");
  await expect(labelInput).toHaveValue(/^Color Path \d+$/u);
  await labelInput.fill("No Green Route");

  await expect(
    panel.getByRole("button", { name: /No Green Route/ }).first(),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const colorPaths = (window as any).appStores.colorPaths.get();
        const path = Object.values(colorPaths).find(
          (item: any) => item.identifiers.label === "No Green Route",
        ) as any;
        return {
          attributes: path?.timing?.attributes,
          interpolationSpace: path?.interpolation_space,
        };
      }),
    )
    .toEqual({ attributes: {}, interpolationSpace: "Hsv" });
});

/** Verifies a created color path can be assigned to an RGB cue from Cue Properties. */
test("operator creates a path and assigns it to an RGB cue", async ({
  backendSlot,
  page,
}) => {
  test.setTimeout(120_000);

  const sequenceId = 994;
  const cueId = 1;
  const cueUid = "99400000-0000-0000-0000-000000000001";
  const sequenceUid = "99400000-0000-0000-0000-000000000099";
  const label = "Cue Assignment E2E Route";

  await openOwnedColorPathApp(page, backendSlot.backendPort);
  const fixture = await storeOwnedRgbFixture(page);
  await waitForAssignmentStores(page);

  await openColorPathPanel(page);
  const panel = page.locator('[data-panel-id="panel-ColorPathPanel-e2e"]');
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "New color path" }).click();
  await panel.getByLabel("Label").fill(label);

  await expect
    .poll(() =>
      page.evaluate((expectedLabel) => {
        const colorPaths = (window as any).appStores.colorPaths.get();
        const path = Object.values(colorPaths).find(
          (item: any) => item.identifiers.label === expectedLabel,
        ) as any;
        return path?.identifiers.id;
      }, label),
    )
    .not.toBeUndefined();
  const colorPathId = await page.evaluate((expectedLabel) => {
    const colorPaths = (window as any).appStores.colorPaths.get();
    const path = Object.values(colorPaths).find(
      (item: any) => item.identifiers.label === expectedLabel,
    ) as any;
    return path.identifiers.id as number;
  }, label);

  await sendCommand(page, {
    module: "CueCommand",
    command: {
      type: "StoreCue",
      data: rgbCue(cueId, cueUid, fixture.uid, 0, 0, 1),
    },
  });
  await sendCommand(page, {
    module: "CueCommand",
    command: {
      type: "StoreSequence",
      data: sequence(sequenceId, sequenceUid, cueUid),
    },
  });
  await expect
    .poll(() =>
      page.evaluate(
        ({ sequenceId, cueId }) => {
          const stores = (window as any).appStores;
          const sequences = stores.sequences.get();
          const cues = stores.cues.get();
          const sequence = Object.values(sequences).find(
            (item: any) => item.identifiers.id === sequenceId,
          ) as any;
          const cueUid = sequence?.steps?.find(
            (uid: string) => cues[uid]?.identifiers?.id === cueId,
          );
          const cue = cues[cueUid];
          return cue?.instructions?.[0]?.cue_instruction?.values
            ? Object.keys(cue.instructions[0].cue_instruction.values).sort()
            : [];
        },
        { sequenceId, cueId },
      ),
    )
    .toEqual(["Blue", "Green", "Red"]);
  const storedCueUid = await page.evaluate(
    ({ sequenceId, cueId }) => {
      const stores = (window as any).appStores;
      const sequences = stores.sequences.get();
      const cues = stores.cues.get();
      const sequence = Object.values(sequences).find(
        (item: any) => item.identifiers.id === sequenceId,
      ) as any;
      const cueUid = sequence?.steps?.find(
        (uid: string) => cues[uid]?.identifiers?.id === cueId,
      );
      if (!cueUid) throw new Error(`cue ${sequenceId}.${cueId} not found`);
      return cueUid;
    },
    { sequenceId, cueId },
  );

  await openCueEditor(page, storedCueUid, sequenceId);
  const cuePanel = page.locator(
    '[data-panel-id="panel-CueEditor-color-path-assignment-e2e"]',
  );
  await expect(cuePanel).toBeVisible();
  await expect(
    cuePanel.getByRole("button", { name: "Toggle cue preview" }),
  ).toBeVisible();
  await focusDockPanel(page, "panel-CueEditor-color-path-assignment-e2e");
  await focusDockPanel(page, "panel-PropertiesInspector");
  const propertiesPanel = page.locator(
    '[data-panel-id="panel-PropertiesInspector"]',
  );
  await expect(propertiesPanel).toBeVisible();
  const colorPathSelect = propertiesPanel.getByLabel("Color Path");
  await expect(colorPathSelect).toBeVisible();
  await colorPathSelect.selectOption(String(colorPathId));

  await expect
    .poll(() =>
      page.evaluate((targetCueUid) => {
        const cue = (window as any).appStores.cues.get()[targetCueUid];
        return cue?.instructions?.[0]?.cue_instruction?.color_path_id;
      }, storedCueUid),
    )
    .toBe(colorPathId);
});
