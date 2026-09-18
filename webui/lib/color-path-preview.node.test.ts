// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type * as types from "../types";
import { ColorInterpolationSpace, FadeCurve, HueDirection } from "../types";
import {
  CIE_1931_SPECTRAL_LOCUS,
  ciePreviewBackgroundColor,
  ciePreviewPointInsideSpectralLocus,
  ciePreviewPointToE154Rgb,
  cieSpectralLocusPreviewPoints,
  colorPathRoutePoints,
  colorPathSamples,
  E154_RGB_PRIMARIES,
  e154RgbToCieChromaticity,
  e154RgbTrianglePreviewPoints,
  rgbToCieChromaticity,
  rgbToHex,
  sampleColorPath,
} from "./color-path-preview";

/** Builds a minimal color path for sampler tests. */
function testPath(
  interpolationSpace: types.ColorInterpolationSpace,
  hueDirection = HueDirection.Shortest,
): types.ColorPath {
  return {
    identifiers: {
      id: 1,
      uid: "00000000000000000000000000000001",
      label: "test",
    },
    interpolation_space: interpolationSpace,
    hue_direction: hueDirection,
    timing: { attributes: {} },
    curve: FadeCurve.Linear,
  };
}

/** Asserts two floating point values are close enough for color coordinate tests. */
function assertClose(
  actual: number,
  expected: number,
  epsilon = 0.000001,
): void {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

test("sampleColorPath interpolates RGB midpoints directly", () => {
  const midpoint = sampleColorPath(
    testPath(ColorInterpolationSpace.Rgb),
    { red: 1, green: 0, blue: 0 },
    { red: 0, green: 0, blue: 1 },
    0.5,
  );

  assert.equal(rgbToHex(midpoint), "#800080");
});

test("sampleColorPath takes the short HSV route through magenta", () => {
  const midpoint = sampleColorPath(
    testPath(ColorInterpolationSpace.Hsv),
    { red: 1, green: 0, blue: 0 },
    { red: 0, green: 0, blue: 1 },
    0.5,
  );

  assert.ok(midpoint.red > 0.9);
  assert.ok(midpoint.green < 0.1);
  assert.ok(midpoint.blue > 0.9);
});

test("colorPathRoutePoints returns bounded overlay coordinates", () => {
  const route = colorPathRoutePoints(
    testPath(ColorInterpolationSpace.Hsv),
    { red: 1, green: 0, blue: 0 },
    { red: 0, green: 0, blue: 1 },
    9,
  );

  assert.equal(route.length, 9);
  for (const point of route) {
    assert.ok(point.x >= 0 && point.x <= 1);
    assert.ok(point.y >= 0 && point.y <= 1);
    assert.ok(point.progress >= 0 && point.progress <= 1);
  }
});

test("colorPathRoutePoints draws RGB straight and HSV through a different CIE route", () => {
  const start = { red: 1, green: 0, blue: 0 };
  const end = { red: 0, green: 0, blue: 1 };
  const rgbRoute = colorPathRoutePoints(
    testPath(ColorInterpolationSpace.Rgb),
    start,
    end,
    5,
  );
  const hsvRoute = colorPathRoutePoints(
    testPath(ColorInterpolationSpace.Hsv),
    start,
    end,
    5,
  );
  const rgbMidpoint = rgbRoute[2];
  const rgbExpectedX = ((rgbRoute[0]?.x ?? 0) + (rgbRoute[4]?.x ?? 0)) / 2;
  const rgbExpectedY = ((rgbRoute[0]?.y ?? 0) + (rgbRoute[4]?.y ?? 0)) / 2;

  assert.ok(rgbMidpoint);
  assertClose(rgbMidpoint.x, rgbExpectedX);
  assertClose(rgbMidpoint.y, rgbExpectedY);
  assert.notDeepEqual(
    hsvRoute.map((point) => [point.x, point.y]),
    rgbRoute.map((point) => [point.x, point.y]),
  );
});

test("rgbToCieChromaticity projects sRGB primaries to expected xy regions", () => {
  const red = rgbToCieChromaticity({ red: 1, green: 0, blue: 0 });
  const green = rgbToCieChromaticity({ red: 0, green: 1, blue: 0 });
  const blue = rgbToCieChromaticity({ red: 0, green: 0, blue: 1 });

  assert.ok(red.x > 0.6 && red.y > 0.3);
  assert.ok(green.x < 0.35 && green.y > 0.55);
  assert.ok(blue.x < 0.2 && blue.y < 0.1);
});

test("e154RgbToCieChromaticity projects RGB controls into E1.54 primaries", () => {
  const red = e154RgbToCieChromaticity({ red: 1, green: 0, blue: 0 });
  const green = e154RgbToCieChromaticity({ red: 0, green: 1, blue: 0 });
  const blue = e154RgbToCieChromaticity({ red: 0, green: 0, blue: 1 });

  assertClose(red.x, E154_RGB_PRIMARIES[0]?.x ?? 0);
  assertClose(red.y, E154_RGB_PRIMARIES[0]?.y ?? 0);
  assertClose(green.x, E154_RGB_PRIMARIES[1]?.x ?? 0);
  assertClose(green.y, E154_RGB_PRIMARIES[1]?.y ?? 0);
  assertClose(blue.x, E154_RGB_PRIMARIES[2]?.x ?? 0);
  assertClose(blue.y, E154_RGB_PRIMARIES[2]?.y ?? 0);
  assert.ok(green.y > rgbToCieChromaticity({ red: 0, green: 1, blue: 0 }).y);
});

test("e154RgbTrianglePreviewPoints includes wide-gamut triangle coordinates", () => {
  const [red, green, blue] = e154RgbTrianglePreviewPoints();

  assert.ok(red && red.x > 0.9);
  assert.ok(green && green.y < 0.1);
  assert.ok(blue && blue.x < 0.1 && blue.y > 0.99);
});

test("ciePreviewPointToE154Rgb maps E1.54 primary points back to RGB controls", () => {
  const [redPoint, greenPoint, bluePoint] = e154RgbTrianglePreviewPoints();

  assert.ok(redPoint && greenPoint && bluePoint);
  const red = ciePreviewPointToE154Rgb(redPoint.x, redPoint.y);
  const green = ciePreviewPointToE154Rgb(greenPoint.x, greenPoint.y);
  const blue = ciePreviewPointToE154Rgb(bluePoint.x, bluePoint.y);

  assert.ok(red.red > 0.99 && red.green < 0.001 && red.blue < 0.001);
  assert.ok(green.green > 0.99 && green.red < 0.001 && green.blue < 0.001);
  assert.ok(blue.blue > 0.99 && blue.red < 0.001 && blue.green < 0.001);
});

test("ciePreviewBackgroundColor returns bounded chromaticity samples", () => {
  const upperLeft = ciePreviewBackgroundColor(0, 0);
  const center = ciePreviewBackgroundColor(0.5, 0.5);
  const lowerRight = ciePreviewBackgroundColor(1, 1);

  assert.match(rgbToHex(upperLeft), /^#[0-9a-f]{6}$/u);
  for (const sample of [upperLeft, center, lowerRight]) {
    assert.ok(sample.red >= 0 && sample.red <= 1);
    assert.ok(sample.green >= 0 && sample.green <= 1);
    assert.ok(sample.blue >= 0 && sample.blue <= 1);
  }
  assert.notEqual(rgbToHex(upperLeft), rgbToHex(center));
  assert.notEqual(rgbToHex(center), rgbToHex(lowerRight));
});

test("ciePreviewPointInsideSpectralLocus identifies masked preview regions", () => {
  assert.equal(ciePreviewPointInsideSpectralLocus(0, 0), false);
  assert.equal(ciePreviewPointInsideSpectralLocus(0.5, 0.5), true);
  assert.equal(ciePreviewPointInsideSpectralLocus(1, 1), false);
});

test("ciePreviewPointInsideSpectralLocus keeps edge primaries aligned with canvas sampling", () => {
  const [redPrimary, , bluePrimary] = e154RgbTrianglePreviewPoints();

  assert.ok(redPrimary && bluePrimary);
  assert.equal(
    ciePreviewPointInsideSpectralLocus(redPrimary.x, redPrimary.y),
    true,
  );
  assert.equal(
    ciePreviewPointInsideSpectralLocus(bluePrimary.x, bluePrimary.y),
    false,
  );
});

test("cieSpectralLocusPreviewPoints uses bounded CIE 1931 locus samples", () => {
  const points = cieSpectralLocusPreviewPoints();
  const greenApex = CIE_1931_SPECTRAL_LOCUS.find(
    (sample) => sample.wavelength === 520,
  );
  const redEndpoint = CIE_1931_SPECTRAL_LOCUS.at(-1);

  assert.equal(points.length, CIE_1931_SPECTRAL_LOCUS.length);
  assert.ok(points.length > 30);
  assert.ok(greenApex && greenApex.y > 0.8);
  assert.ok(redEndpoint && redEndpoint.x > 0.7 && redEndpoint.y > 0.25);
  assert.ok(points.every((point) => point.x >= 0 && point.x <= 1));
  assert.ok(points.every((point) => point.y >= 0 && point.y <= 1));
});

test("colorPathSamples applies per-attribute timing", () => {
  const path = testPath(ColorInterpolationSpace.Rgb);
  path.timing.attributes = {
    Green: {
      delay_percent: 0.5,
      time_percent: 0.5,
      curve: FadeCurve.Linear,
    },
  };

  const samples = colorPathSamples(
    path,
    { red: 1, green: 0, blue: 0 },
    { red: 0, green: 1, blue: 0 },
    3,
  );

  assert.equal(rgbToHex(samples[1]), "#800000");
});

test("colorPathSamples preserves authored anchors when timing delays progress", () => {
  const path = testPath(ColorInterpolationSpace.Rgb);
  path.timing.in_color = {
    delay_percent: 0.25,
    time_percent: 1,
  };

  const samples = colorPathSamples(
    path,
    { red: 1, green: 0, blue: 0 },
    { red: 0, green: 1, blue: 0 },
    5,
  );

  assert.equal(rgbToHex(samples[0]), "#ff0000");
  assert.equal(rgbToHex(samples[1]), "#ff0000");
  assert.equal(rgbToHex(samples[4]), "#00ff00");
});

test("colorPathRoutePoints preserves authored anchor colors when timing delays HSV progress", () => {
  const path = testPath(ColorInterpolationSpace.Hsv);
  path.timing.in_color = {
    delay_percent: 0.25,
    time_percent: 1,
  };

  const route = colorPathRoutePoints(
    path,
    { red: 1, green: 0, blue: 0 },
    { red: 0, green: 1, blue: 0 },
    5,
  );

  assert.equal(
    rgbToHex(route[0]?.color ?? { red: 0, green: 0, blue: 0 }),
    "#ff0000",
  );
  assert.equal(
    rgbToHex(route[4]?.color ?? { red: 0, green: 0, blue: 0 }),
    "#00ff00",
  );
});

test("colorPathSamples applies midpoint brightness without dimming authored anchors", () => {
  const path = testPath(ColorInterpolationSpace.Rgb);
  path.timing.brightness_percent = 0.5;

  const samples = colorPathSamples(
    path,
    { red: 1, green: 0, blue: 0 },
    { red: 0, green: 1, blue: 0 },
    3,
  );

  assert.equal(rgbToHex(samples[0]), "#ff0000");
  assert.equal(rgbToHex(samples[1]), "#404000");
  assert.equal(rgbToHex(samples[2]), "#00ff00");
});
