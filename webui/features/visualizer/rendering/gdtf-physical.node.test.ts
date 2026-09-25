// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Tests for rendering GDTF color temperature, HSB/CIE, CMY, shutter and optics values. */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type Attribute,
  DmxValueResolution,
  type FixtureElement,
  MergeStrategy,
  type ParameterFunction,
  type ParameterMetadata,
  ParameterValuePolarity,
} from "../../../types";
import { kelvinToRgb } from "./gdtf-physical";
import { extractVisualizerDmx, resetDmxPool } from "./visualizer-dmx";

/** Builds 8-bit parameter metadata with profile functions. */
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

/** Builds a custom-attribute parameter with one whole-range function. */
function custom(
  attribute: string,
  physical_from: number,
  physical_to: number,
): ParameterMetadata {
  return parameter({ type: "Custom", data: { label: attribute } }, [
    fn(attribute, 0, 255, { physical_from, physical_to }),
  ]);
}

/** Builds a function over a DMX range. */
function fn(
  attribute: string,
  dmx_from: number,
  dmx_to: number,
  extra: Partial<ParameterFunction> = {},
): ParameterFunction {
  return {
    name: attribute,
    attribute,
    dmx_from,
    dmx_to,
    physical_from: 0,
    physical_to: 1,
    ...extra,
  };
}

/** A lamp element: a dimmer plus the given parameters. */
function lamp(...parameters: ParameterMetadata[]): FixtureElement {
  return {
    label: "Head",
    parameters: [parameter({ type: "Intensity" }), ...parameters],
  };
}

/** Asserts a value lies within a tolerance of the expected value. */
function near(actual: number | undefined, expected: number, message: string) {
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) < 0.02,
    `${message}: expected ${expected}, got ${actual}`,
  );
}

/** Verifies black-body colors run from warm to cool through white near 6500 K. */
test("kelvin colors follow the Planckian locus", () => {
  const [warmRed, , warmBlue] = kelvinToRgb(2700);
  assert.ok(warmRed > warmBlue, "2700 K is warm");
  const [coolRed, , coolBlue] = kelvinToRgb(12000);
  assert.ok(coolBlue > coolRed, "12000 K is cool");
  const [red, green, blue] = kelvinToRgb(6500);
  assert.ok(Math.min(red, green, blue) > 0.95, "6500 K is near white");
});

/** Verifies a Kelvin CTO function warms an otherwise white lamp. */
test("color temperature correction tints a white lamp", () => {
  resetDmxPool();
  const element = lamp(custom("CTO", 8000, 2700));
  const open = extractVisualizerDmx({ Intensity: 255, CTO: 0 }, element);
  assert.ok(open.blue > open.red, "8000 K is slightly cool");
  const warm = extractVisualizerDmx({ Intensity: 255, CTO: 255 }, element);
  assert.ok(warm.red > 0.9 && warm.blue < 0.6, `2700 K is warm: ${warm.blue}`);
});

/** Verifies HSB channels define the color on their authored scales. */
test("HSB channels define the source color", () => {
  resetDmxPool();
  const element = lamp(
    custom("HSB_Hue", 0, 360),
    custom("HSB_Saturation", 0, 100),
  );
  const green = extractVisualizerDmx(
    { Intensity: 255, HSB_Hue: 85, HSB_Saturation: 255 },
    element,
  );
  near(green.green, 1, "hue 120° is green");
  near(green.red, 0, "saturated green has no red");
});

/** Verifies CIE channels authored on a 0-8000 scale select their chromaticity. */
test("CIE channels define the source color", () => {
  resetDmxPool();
  const element = lamp(custom("CIE_X", 0, 8000), custom("CIE_Y", 0, 8000));
  const red = extractVisualizerDmx(
    { Intensity: 255, CIE_X: 204, CIE_Y: 105.2 },
    element,
  );
  near(red.red, 1, "x 0.64, y 0.33 is red");
  near(red.blue, 0, "red has no blue");
});

/** Verifies subtractive CMY removes its complement from a white lamp. */
test("subtractive CMY filters a white lamp", () => {
  resetDmxPool();
  const element = lamp(custom("ColorSub_C", 0, 1), custom("ColorSub_Y", 0, 1));
  const green = extractVisualizerDmx(
    { Intensity: 255, ColorSub_C: 255, ColorSub_Y: 255 },
    element,
  );
  near(green.red, 0, "cyan removes red");
  near(green.green, 1, "green passes");
  near(green.blue, 0, "yellow removes blue");
});

/**
 * Verifies brightness and subtractive amounts follow their authored physical
 * range rather than the position within the DMX range: HSB brightness from
 * 25% to 100% starts at a quarter, and cyan authored from full to no
 * filtering removes red at DMX 0.
 */
test("brightness and CMY amounts use their authored physical range", () => {
  resetDmxPool();
  const hsb = lamp(
    custom("HSB_Hue", 0, 360),
    custom("HSB_Saturation", 0, 100),
    custom("HSB_Brightness", 25, 100),
  );
  const dim = extractVisualizerDmx(
    { Intensity: 255, HSB_Hue: 0, HSB_Saturation: 255, HSB_Brightness: 0 },
    hsb,
  );
  near(dim.red, 0.25, "lowest brightness is 25%");

  // Full yellow keeps a filter in the beam whatever the cyan amount.
  const cyan = lamp(custom("ColorSub_C", 1, 0), custom("ColorSub_Y", 0, 1));
  const full = extractVisualizerDmx(
    { Intensity: 255, ColorSub_C: 0, ColorSub_Y: 255 },
    cyan,
  );
  near(full.red, 0, "full cyan at DMX 0 removes red");
  const none = extractVisualizerDmx(
    { Intensity: 255, ColorSub_C: 255, ColorSub_Y: 255 },
    cyan,
  );
  near(none.red, 1, "no cyan at DMX 255 passes red");
});

/** Verifies a wheel filter passes only its measured share of light. */
test("wheel filters keep their relative luminance", () => {
  resetDmxPool();
  const element = lamp(
    parameter({ type: "Custom", data: { label: "Color1" } }, [
      fn("Color1", 0, 255, {
        sets: [
          {
            name: "Red",
            dmx_from: 0,
            dmx_to: 255,
            color: { x: 0.64, y: 0.33, Y: 21 },
          },
        ],
      }),
    ]),
  );
  const red = extractVisualizerDmx({ Intensity: 255, Color1: 10 }, element);
  near(red.red, 0.21, "red filter passes 21%");
});

/** Verifies plain shutter functions open or close the beam by their physical transmission. */
test("shutter functions set transmission", () => {
  resetDmxPool();
  const element = lamp(
    parameter({ type: "StrobeShutter" }, [
      fn("Shutter1", 0, 99, { physical_from: 0, physical_to: 0 }),
      fn("Shutter1", 100, 199, { physical_from: 1, physical_to: 1 }),
      fn("Shutter1Strobe", 200, 255, { physical_from: 1, physical_to: 25 }),
    ]),
  );
  near(
    extractVisualizerDmx({ Intensity: 255, StrobeShutter: 50 }, element)
      .intensity,
    0,
    "closed",
  );
  near(
    extractVisualizerDmx({ Intensity: 255, StrobeShutter: 150 }, element)
      .intensity,
    1,
    "open",
  );
  const strobe = extractVisualizerDmx(
    { Intensity: 255, StrobeShutter: 255 },
    element,
  );
  near(strobe.strobeHz, 25, "strobe at its physical frequency");
});

/** Verifies iris and zoom report their physical aperture and beam angle. */
test("iris and zoom use physical values", () => {
  resetDmxPool();
  const element = lamp(
    custom("Iris", 1, 0.16),
    parameter({ type: "Zoom" }, [
      fn("Zoom", 0, 255, { physical_from: 50, physical_to: 3 }),
    ]),
  );
  const dmx = extractVisualizerDmx(
    { Intensity: 255, Iris: 255, Zoom: 0 },
    element,
  );
  near(dmx.iris, 0.16, "iris closed to its authored aperture");
  near(dmx.zoomDegrees, 50, "zoom at its widest angle");
});

/**
 * Verifies functions left at GDTF's 0-1 default physical range keep their
 * conventional meaning: the iris is open at DMX 0, and an open shutter
 * passes light from its first DMX value.
 */
test("default physical ranges keep iris open and shutters passing light", () => {
  resetDmxPool();
  const element = lamp(
    custom("Iris", 0, 1),
    parameter({ type: "StrobeShutter" }, [
      fn("Shutter1", 0, 31, { name: "Closed" }),
      fn("Shutter1", 32, 255, { name: "Open" }),
    ]),
  );
  const open = extractVisualizerDmx(
    { Intensity: 255, Iris: 0, StrobeShutter: 32 },
    element,
  );
  near(open.iris, 1, "iris open at DMX 0");
  near(open.intensity, 1, "open shutter passes light");
  const closed = extractVisualizerDmx(
    { Intensity: 255, Iris: 255, StrobeShutter: 0 },
    element,
  );
  near(closed.iris, 0.05, "iris fully closed");
  near(closed.intensity, 0, "closed shutter blocks light");
});
