// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { inflateSync } from "node:zlib";
import { expect, type Page, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

const PATCH_PANEL_ID = "panel-PatchEditor-visualizer-selection-e2e";

type DecodedPng = {
  width: number;
  height: number;
  channels: number;
  data: Buffer;
};

/**
 * Opens the app with the main-thread visualizer so canvas screenshots are readable.
 */
async function openApp(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall-patch-panel:active-tab", "fixtures");
  });
  await page.goto(
    "/?visualizer:offscreenCanvas=false&e2e=1&scenario=nightfall-6nze-15",
  );
  await expect(page.locator("main#app")).toBeVisible();
  await prepareStoreSeededTestApp(page);
}

/**
 * Waits until the Dockview API is available on appStores.
 */
async function waitForDockApi(page: Page) {
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();

      /** Polls until the app shell has installed the Dockview API. */
      const tick = () => {
        const api = (window as any).appStores?.dockApi?.get?.();
        if (api) {
          resolve();
          return;
        }
        if (Date.now() - started > 15_000) {
          reject(new Error("dock API did not initialize"));
          return;
        }
        window.setTimeout(tick, 100);
      };
      tick();
    });
  });
}

/**
 * Adds a Patch panel directly through Dockview and focuses it.
 */
async function addPatchPanel(page: Page) {
  await waitForDockApi(page);
  await page.evaluate((panelId) => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-PatchEditor")?.api.close();
    api.getPanel(panelId)?.api.close();
    const panel = api.addPanel({
      id: panelId,
      component: "PatchEditor",
      title: "Patch",
      params: { initialPanelId: panelId },
      position: {
        referencePanel: "panel-FixtureGrid",
        direction: "within",
      },
    });
    panel.api.setActive();
    panel.focus();
  }, PATCH_PANEL_ID);
}

/** Returns the fixture grid owned by the isolated Patch panel. */
function patchGrid(page: Page) {
  return page.locator(
    `[data-panel-id="${PATCH_PANEL_ID}"] [data-grid-kind="tanstack"]`,
  );
}

/**
 * Focuses the existing Patch panel used by this test.
 */
async function focusPatchPanel(page: Page) {
  await waitForDockApi(page);
  await page.evaluate((panelId) => {
    const api = (window as any).appStores.dockApi.get();
    const panel = api.getPanel(panelId);
    panel?.api.setActive();
    panel?.focus();
  }, PATCH_PANEL_ID);
  await expect(patchGrid(page).locator("#tanstack-cell-0-0")).toBeVisible();
}

/**
 * Seeds fixture rows that are also visible in the visualizer.
 */
async function seedFixtures(page: Page) {
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    stores.programmerSelection.set([]);
    stores.visualizerEditSelection.set([]);
    stores.fixtures.set({
      "fixture-grid-highlight-1": {
        identifiers: {
          id: 1,
          uid: "fixture-grid-highlight-1",
          label: "Fixture Grid Highlight 1",
        },
        make: "Generic",
        model: "RGB Strobe Bar 168ch",
        mode: "Strobe",
        elements: [],
        placement: {
          position: { x: -1, y: 2, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
        },
      },
      "fixture-grid-highlight-2": {
        identifiers: {
          id: 2,
          uid: "fixture-grid-highlight-2",
          label: "Fixture Grid Highlight 2",
        },
        make: "Generic",
        model: "RGB Strobe Bar 168ch",
        mode: "Strobe",
        elements: [],
        placement: {
          position: { x: 1, y: 2, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
        },
      },
    });
  });
}

/**
 * Focuses the default visualizer panel.
 */
async function focusVisualizer(page: Page) {
  const visualizerTab = page
    .locator(".dv-default-tab")
    .filter({ hasText: "3D Visualizer" })
    .first();
  const keepSavedButton = page
    .getByRole("button", { name: "Keep Saved" })
    .first();
  const firstVisible = await Promise.race([
    visualizerTab
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => "visualizer" as const)
      .catch(() => "timeout" as const),
    keepSavedButton
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => "recovery" as const)
      .catch(() => "timeout" as const),
  ]);

  if (firstVisible === "recovery") {
    await keepSavedButton.click();
    await expect(keepSavedButton).not.toBeVisible();
  }

  await expect(visualizerTab).toBeVisible();
  await visualizerTab.click();
  await expect(page.locator("canvas:visible").first()).toBeVisible();
  await page.waitForFunction(
    () => Boolean((window as any).visualizerApi?.getScene?.()),
    { timeout: 15_000 },
  );
}

/**
 * Finds the largest visible canvas box for visual assertions.
 */
async function largestVisibleCanvasBox(page: Page) {
  let visibleCanvasBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null = null;

  await expect
    .poll(async () => {
      visibleCanvasBox = await page.evaluate(() => {
        const boxes = Array.from(document.querySelectorAll("canvas"))
          .map((canvas) => {
            const rect = canvas.getBoundingClientRect();
            return {
              x: Math.max(0, rect.x),
              y: Math.max(0, rect.y),
              width:
                Math.min(window.innerWidth, rect.right) - Math.max(0, rect.x),
              height:
                Math.min(window.innerHeight, rect.bottom) - Math.max(0, rect.y),
              area: rect.width * rect.height,
            };
          })
          .filter(
            (box) =>
              box.width > 10 &&
              box.height > 10 &&
              box.x < window.innerWidth &&
              box.y < window.innerHeight,
          );

        boxes.sort((left, right) => right.area - left.area);
        const box = boxes[0];
        return box
          ? { x: box.x, y: box.y, width: box.width, height: box.height }
          : null;
      });
      return visibleCanvasBox;
    })
    .not.toBeNull();

  return visibleCanvasBox!;
}

/**
 * Counts yellow-dominant pixels in a PNG screenshot.
 */
function yellowDominantPixelCount(png: Buffer): number {
  const decoded = decodePng(png);
  let count = 0;

  for (let y = 0; y < decoded.height; y++) {
    const rowOffset = y * decoded.width * decoded.channels;
    for (let x = 0; x < decoded.width; x++) {
      const offset = rowOffset + x * decoded.channels;
      const red = decoded.data[offset];
      const green = decoded.data[offset + 1];
      const blue = decoded.data[offset + 2];
      if (red > 150 && green > 120 && blue < 100 && red > blue * 1.8) {
        count++;
      }
    }
  }

  return count;
}

/**
 * Counts red-dominant pixels in a PNG screenshot.
 */
function redDominantPixelCount(png: Buffer): number {
  const decoded = decodePng(png);
  let count = 0;

  for (let y = 0; y < decoded.height; y++) {
    const rowOffset = y * decoded.width * decoded.channels;
    for (let x = 0; x < decoded.width; x++) {
      const offset = rowOffset + x * decoded.channels;
      const red = decoded.data[offset];
      const green = decoded.data[offset + 1];
      const blue = decoded.data[offset + 2];
      if (red > 140 && green < 120 && blue < 120 && red > green * 1.6) {
        count++;
      }
    }
  }

  return count;
}

/**
 * Counts pink pixels produced where white selection and red programmer outlines overlap.
 */
function coincidentOutlinePixelCount(png: Buffer): number {
  const decoded = decodePng(png);
  let count = 0;

  for (let y = 0; y < decoded.height; y++) {
    const rowOffset = y * decoded.width * decoded.channels;
    for (let x = 0; x < decoded.width; x++) {
      const offset = rowOffset + x * decoded.channels;
      const red = decoded.data[offset];
      const green = decoded.data[offset + 1];
      const blue = decoded.data[offset + 2];
      if (
        red > 150 &&
        green > 90 &&
        blue > 90 &&
        red > green * 1.15 &&
        Math.abs(green - blue) < 45
      ) {
        count++;
      }
    }
  }

  return count;
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

  return { width, height, channels, data };
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

/** Verifies patch row selection highlights matching visualizer fixtures. */
test("patch grid row selection highlights visualizer fixtures in yellow", async ({
  page,
}) => {
  await openApp(page);
  await addPatchPanel(page);

  const grid = patchGrid(page);
  await seedFixtures(page);
  await expect(grid).toBeVisible();
  await expect(grid.locator("#tanstack-cell-0-0")).toHaveText("1");

  await grid
    .getByRole("checkbox", { name: "Select row 1", exact: true })
    .click();
  await grid
    .getByRole("checkbox", { name: "Select row 2", exact: true })
    .click();

  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.visualizerEditSelection.get(),
      ),
    )
    .toEqual(["fixture-grid-highlight-1", "fixture-grid-highlight-2"]);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).appStores.programmerSelection.get()),
    )
    .toEqual([]);

  await grid
    .getByRole("checkbox", { name: "Select row 1", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.visualizerEditSelection.get(),
      ),
    )
    .toEqual(["fixture-grid-highlight-2"]);

  await grid
    .getByRole("checkbox", { name: "Select row 1", exact: true })
    .click();
  await focusVisualizer(page);
  const canvasBox = await largestVisibleCanvasBox(page);
  await page.waitForTimeout(300);
  const screenshot = await page.screenshot({ clip: canvasBox });
  expect(yellowDominantPixelCount(screenshot)).toBeGreaterThan(10);

  await focusPatchPanel(page);
  await grid
    .getByRole("checkbox", { name: "Select row 1", exact: true })
    .click();
  await grid
    .getByRole("checkbox", { name: "Select row 2", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.visualizerEditSelection.get(),
      ),
    )
    .toEqual([]);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).appStores.programmerSelection.get()),
    )
    .toEqual([]);
});

/** Verifies programmer value and active selection outlines coexist. */
test("programmer row highlights coexist with active visualizer selection", async ({
  page,
}) => {
  await openApp(page);
  await seedFixtures(page);
  await focusVisualizer(page);

  await page.evaluate(() => {
    const stores = (window as any).appStores;
    stores.visualizerEditSelection.set([]);
    stores.programmerSelection.set([]);
    stores.programmerState.set([
      {
        fixtureUid: "fixture-grid-highlight-1",
        attributes: {
          Intensity: {
            value: 1,
            isPercentage: false,
            isRelative: false,
          },
        },
      },
    ]);
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).appStores.programmerSelection.get()),
    )
    .toEqual([]);

  const canvasBox = await largestVisibleCanvasBox(page);
  await page.waitForTimeout(300);
  const inactiveSelectionScreenshot = await page.screenshot({
    clip: canvasBox,
  });
  expect(redDominantPixelCount(inactiveSelectionScreenshot)).toBeGreaterThan(
    10,
  );

  await page.evaluate(() => {
    const stores = (window as any).appStores;
    stores.programmerSelection.set(["fixture-grid-highlight-1"]);
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).appStores.programmerSelection.get()),
    )
    .toEqual(["fixture-grid-highlight-1"]);

  await expect
    .poll(
      async () => {
        const screenshot = await page.screenshot({ clip: canvasBox });
        return coincidentOutlinePixelCount(screenshot) > 10;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
});

/**
 * Verifies a clicked editable patch cell publishes its fixture without checking a row marker.
 */
test("patch grid active edit row publishes a visualizer target independently of row markers", async ({
  page,
}) => {
  await openApp(page);
  await addPatchPanel(page);

  const grid = patchGrid(page);
  await seedFixtures(page);
  await expect(grid).toBeVisible();
  await expect(grid.locator("#tanstack-cell-0-1")).toHaveText("2");

  const posXCell = grid.locator("#tanstack-cell-6-1");
  await expect(posXCell).toBeVisible();
  await posXCell.click();

  await expect(
    grid.getByRole("checkbox", { name: "Select row 2", exact: true }),
  ).not.toBeChecked();
  await expect(
    grid.getByRole("checkbox", { name: "Select row 1", exact: true }),
  ).not.toBeChecked();
  await expect(posXCell).not.toHaveCSS("color", "rgb(255, 0, 0)");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.visualizerEditSelection.get(),
      ),
    )
    .toEqual(["fixture-grid-highlight-2"]);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).appStores.programmerSelection.get()),
    )
    .toEqual([]);

  await expect(posXCell).toHaveAttribute("aria-selected", "true");
});
