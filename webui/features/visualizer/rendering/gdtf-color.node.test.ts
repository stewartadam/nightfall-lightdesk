// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Tests for rendering GDTF emitter colors and color wheel slots. */

import assert from "node:assert/strict";
import test from "node:test";
import { cieChromaticityToFullBrightnessRgb } from "../../../lib/color-path-preview";
import {
  type Attribute,
  DmxValueResolution,
  type FixtureElement,
  MergeStrategy,
  type ParameterFunction,
  type ParameterMetadata,
  ParameterValuePolarity,
} from "../../../types";
import {
  elementGoboMedia,
  extractVisualizerDmx,
  resetDmxPool,
} from "./visualizer-dmx";

/** Builds 8-bit parameter metadata with optional profile functions. */
function parameter(
  attribute: Attribute,
  functions?: ParameterFunction[],
): ParameterMetadata {
  return {
    resolution: DmxValueResolution.Coarse,
    attribute,
    value_polarity: ParameterValuePolarity.Unsigned,
    min: 0,
    max: 255,
    offset: { type: "Absolute", data: { value: 0 } },
    is_inverted: false,
    is_snap: false,
    merge_type: MergeStrategy.LTP,
    use_grandmaster: false,
    functions,
  };
}

/** Builds a whole-range function with optional emitter color and wheel sets. */
function fn(
  attribute: string,
  extra: Partial<ParameterFunction> = {},
): ParameterFunction {
  return {
    name: attribute,
    attribute,
    dmx_from: 0,
    dmx_to: 255,
    physical_from: 0,
    physical_to: 1,
    ...extra,
  };
}

/** Asserts a value lies within a tolerance of the expected value. */
function near(actual: number, expected: number, message: string): void {
  assert.ok(
    Math.abs(actual - expected) < 0.02,
    `${message}: expected ${expected}, got ${actual}`,
  );
}

/** Verifies sRGB primaries and the D65 white point convert to their display colors. */
test("CIE chromaticities convert to full-brightness display colors", () => {
  const white = cieChromaticityToFullBrightnessRgb({ x: 0.3127, y: 0.329 });
  near(white.red, 1, "white red");
  near(white.green, 1, "white green");
  near(white.blue, 1, "white blue");
  const red = cieChromaticityToFullBrightnessRgb({ x: 0.64, y: 0.33 });
  near(red.red, 1, "red primary");
  near(red.green, 0, "red primary green");
});

/** Verifies an additive emitter mixes its measured chromaticity rather than an attribute-name guess. */
test("emitter colors drive additive mixing", () => {
  resetDmxPool();
  const element: FixtureElement = {
    label: "Cell",
    parameters: [
      parameter({ type: "Intensity" }),
      parameter({ type: "Custom", data: { label: "ColorAdd_Lime" } }, [
        fn("ColorAdd_Lime", {
          emitter_color: { x: 0.405, y: 0.54, Y: 60 },
        }),
      ]),
    ],
  };
  const dmx = extractVisualizerDmx(
    { Intensity: 255, ColorAdd_Lime: 255 },
    element,
  );
  assert.ok(dmx.green > dmx.red, "lime is greener than red");
  assert.ok(dmx.red > dmx.blue + 0.3, "lime has a strong red component");
  near(dmx.intensity, 1, "intensity");
});

/** Verifies the active color wheel slot filters a lamp that has no additive color. */
test("color wheel slots filter a white lamp", () => {
  resetDmxPool();
  const wheel = fn("Color1", {
    wheel: "Color Wheel",
    sets: [
      {
        name: "Open",
        dmx_from: 0,
        dmx_to: 9,
        wheel_slot: 1,
        color: { x: 0.3127, y: 0.329, Y: 100 },
      },
      {
        name: "Red",
        dmx_from: 10,
        dmx_to: 255,
        wheel_slot: 2,
        color: { x: 0.64, y: 0.33, Y: 21 },
      },
    ],
  });
  const element: FixtureElement = {
    label: "Head",
    parameters: [
      parameter({ type: "Intensity" }),
      parameter({ type: "Custom", data: { label: "Color1" } }, [wheel]),
    ],
  };

  const open = extractVisualizerDmx({ Intensity: 255, Color1: 0 }, element);
  near(open.red, 1, "open red");
  near(open.green, 1, "open green");

  const red = extractVisualizerDmx({ Intensity: 255, Color1: 20 }, element);
  near(red.red, 1, "red slot red");
  near(red.green, 0, "red slot green");
  near(red.blue, 0, "red slot blue");
});

/** Verifies the active gobo slot is reported as a 1-based index into the element's gobo images. */
test("gobo wheel slots report their image index", () => {
  resetDmxPool();
  const element: FixtureElement = {
    label: "Head",
    parameters: [
      parameter({ type: "Intensity" }),
      parameter({ type: "Gobo" }, [
        fn("Gobo1", {
          wheel: "Gobo Wheel",
          sets: [
            { name: "Open", dmx_from: 0, dmx_to: 9 },
            { name: "Stars", dmx_from: 10, dmx_to: 19, media: "stars" },
            { name: "Dots", dmx_from: 20, dmx_to: 255, media: "dots" },
          ],
        }),
      ]),
    ],
  };
  assert.deepEqual(elementGoboMedia(element), ["stars", "dots"]);
  assert.equal(
    extractVisualizerDmx({ Intensity: 255, Gobo: 0 }, element).gobo,
    0,
  );
  assert.equal(
    extractVisualizerDmx({ Intensity: 255, Gobo: 25 }, element).gobo,
    2,
  );
});
