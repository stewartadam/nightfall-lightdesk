// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Interpretation of GDTF physical values for color and optics.
 *
 * Profiles author the same attribute on different scales (CIE x as 0-0.8,
 * 0-1 or 0-8000; hue as 0-360 or 0-1; color temperature in Kelvin or as a
 * 0-1 amount), so each reader normalizes the scales seen in practice. One
 * {@link PhysicalState} collects an element's channels; the visualizer then
 * applies it to the element's color, intensity and beam.
 */

import {
  cieChromaticityToFullBrightnessRgb,
  hsvToRgb,
} from "../../../lib/color-path-preview";
import type { EvaluatedChannel } from "./channel-evaluation";

/** Color temperature a white source is assumed to have, in Kelvin. */
const NATIVE_KELVIN = 6500;
/** Color temperature a 0-1 CTO amount corrects towards, in Kelvin. */
const FULL_CTO_KELVIN = 3200;
/** Color temperatures a 0-1 CTC amount spans, from cool to warm. */
const CTC_FRACTION_KELVIN = [10000, 2000] as const;
/** Lowest strobe frequency rendered, in hertz. */
const MIN_STROBE_HZ = 0.1;
/** Smallest iris aperture rendered, as a fraction of the open beam. */
const MIN_IRIS_APERTURE = 0.05;

/** Physical color and optics values collected from one element's channels. */
export interface PhysicalState {
  /** Color temperature the beam is corrected to, in Kelvin. */
  kelvin?: number;
  /** HSB hue in degrees. */
  hue?: number;
  /** HSB saturation 0-1. */
  saturation?: number;
  /** HSB brightness 0-1. */
  hsbBrightness?: number;
  /** CIE chromaticity x. */
  cieX?: number;
  /** CIE chromaticity y. */
  cieY?: number;
  /** CIE brightness 0-1. */
  cieBrightness?: number;
  /** Subtractive cyan 0-1. */
  cyan: number;
  /** Subtractive magenta 0-1. */
  magenta: number;
  /** Subtractive yellow 0-1. */
  yellow: number;
  /** Fraction of light the shutter passes. */
  transmission: number;
  /** Strobe frequency in hertz, when a strobe function states it. */
  strobeHz?: number;
  /** Iris aperture as a fraction of the open beam. */
  iris?: number;
  /** Beam angle from the zoom function, in degrees. */
  zoomDegrees?: number;
  /** Frost amount 0-1 from any frost function. */
  frost?: number;
}

/** Resets a state for reuse in the render loop. */
export function resetPhysicalState(state: PhysicalState): PhysicalState {
  state.kelvin = undefined;
  state.hue = undefined;
  state.saturation = undefined;
  state.hsbBrightness = undefined;
  state.cieX = undefined;
  state.cieY = undefined;
  state.cieBrightness = undefined;
  state.cyan = 0;
  state.magenta = 0;
  state.yellow = 0;
  state.transmission = 1;
  state.strobeHz = undefined;
  state.iris = undefined;
  state.zoomDegrees = undefined;
  state.frost = undefined;
  return state;
}

/** Returns the largest magnitude of a function's physical range. */
function physicalSpan(channel: EvaluatedChannel): number {
  const fn = channel.function;
  return fn
    ? Math.max(Math.abs(fn.physical_from), Math.abs(fn.physical_to))
    : 0;
}

/** Returns true when the function authors its physical range as a 0-1 amount. */
function isFraction(channel: EvaluatedChannel): boolean {
  return physicalSpan(channel) <= 1;
}

/** Returns a physical value in Kelvin, or undefined when it is not one. */
function kelvinOf(channel: EvaluatedChannel): number | undefined {
  return channel.physical >= 1000 ? channel.physical : undefined;
}

/**
 * Adds one evaluated channel to the element's physical state. Returns true
 * when the channel's function is a color or optics attribute handled here,
 * so the caller does not also treat it by attribute name.
 */
export function collectPhysical(
  state: PhysicalState,
  channel: EvaluatedChannel,
): boolean {
  const attribute = channel.function?.attribute;
  if (!attribute) return false;
  const level = channel.level;
  switch (attribute) {
    case "CTO":
      state.kelvin =
        kelvinOf(channel) ??
        (isFraction(channel)
          ? NATIVE_KELVIN - (NATIVE_KELVIN - FULL_CTO_KELVIN) * level
          : state.kelvin);
      return true;
    case "CTC":
    case "CTB":
    case "CCT":
      state.kelvin =
        kelvinOf(channel) ??
        (isFraction(channel) && physicalSpan(channel) > 0
          ? CTC_FRACTION_KELVIN[0] +
            (CTC_FRACTION_KELVIN[1] - CTC_FRACTION_KELVIN[0]) * level
          : state.kelvin);
      return true;
    case "HSB_Hue":
      state.hue = isFraction(channel)
        ? channel.physical * 360
        : channel.physical;
      return true;
    case "HSB_Saturation":
      state.saturation = isFraction(channel)
        ? channel.physical
        : channel.physical / 100;
      return true;
    case "HSB_Brightness":
      state.hsbBrightness = level;
      return true;
    case "CIE_X":
      state.cieX =
        physicalSpan(channel) > 1 ? channel.physical / 10000 : channel.physical;
      return true;
    case "CIE_Y":
      state.cieY =
        physicalSpan(channel) > 1 ? channel.physical / 10000 : channel.physical;
      return true;
    case "CIE_Brightness":
      state.cieBrightness = level;
      return true;
    case "ColorSub_C":
      state.cyan = level;
      return true;
    case "ColorSub_M":
      state.magenta = level;
      return true;
    case "ColorSub_Y":
      state.yellow = level;
      return true;
    case "Iris":
      state.iris = Math.max(
        MIN_IRIS_APERTURE,
        isFraction(channel) ? channel.physical : 1 - level,
      );
      return true;
    case "Zoom":
      if (physicalSpan(channel) > 1) state.zoomDegrees = channel.physical;
      return false;
  }
  if (/^Frost\d*$/.test(attribute)) {
    state.frost = Math.max(state.frost ?? 0, level);
    return false;
  }
  if (/^Shutter\d+$/.test(attribute)) {
    // Plain shutter functions state how much light passes: 1 open, 0 closed.
    state.transmission *= Math.min(1, Math.max(0, channel.physical));
    return false;
  }
  if (/^Shutter\d+Strobe/.test(attribute) && !isFraction(channel)) {
    state.strobeHz = Math.max(MIN_STROBE_HZ, channel.physical);
  }
  return false;
}

/** Display RGB of Planckian color temperatures, keyed by 10 K steps. */
const kelvinColors = new Map<number, readonly [number, number, number]>();

/**
 * Returns the full-brightness display color of a black body at `kelvin`,
 * from the Kim et al. cubic approximation of the Planckian locus
 * (1667-25000 K).
 */
export function kelvinToRgb(kelvin: number): readonly [number, number, number] {
  const key = Math.round(Math.min(25000, Math.max(1667, kelvin)) / 10) * 10;
  let cached = kelvinColors.get(key);
  if (!cached) {
    const t = key;
    const x =
      t <= 4000
        ? -0.2661239e9 / t ** 3 -
          0.234358e6 / t ** 2 +
          0.8776956e3 / t +
          0.17991
        : -3.0258469e9 / t ** 3 +
          2.1070379e6 / t ** 2 +
          0.2226347e3 / t +
          0.24039;
    const y =
      t <= 2222
        ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683
        : t <= 4000
          ? -0.9549476 * x ** 3 -
            1.37418593 * x ** 2 +
            2.09137015 * x -
            0.16748867
          : 3.081758 * x ** 3 -
            5.8733867 * x ** 2 +
            3.75112997 * x -
            0.37001483;
    const rgb = cieChromaticityToFullBrightnessRgb({ x, y });
    cached = [rgb.red, rgb.green, rgb.blue];
    kelvinColors.set(key, cached);
  }
  return cached;
}

/** An RGB color being built for one element, components 0-1. */
export interface MutableRgb {
  red: number;
  green: number;
  blue: number;
}

/**
 * Applies a physical state's color semantics to an element's color.
 *
 * HSB or CIE channels define the source color outright (scaled by their
 * brightness); a color temperature correction and subtractive CMY then
 * filter it. The correction is relative to a white source, so a beam at its
 * native temperature is unchanged.
 */
export function applyPhysicalColor(
  state: PhysicalState,
  color: MutableRgb,
): void {
  if (state.hue !== undefined || state.saturation !== undefined) {
    const rgb = hsvToRgb({
      hue: state.hue ?? 0,
      saturation: state.saturation ?? 0,
      value: state.hsbBrightness ?? 1,
    });
    color.red = rgb.red;
    color.green = rgb.green;
    color.blue = rgb.blue;
  } else if (state.cieX !== undefined && state.cieY !== undefined) {
    const rgb = cieChromaticityToFullBrightnessRgb({
      x: state.cieX,
      y: state.cieY,
    });
    const brightness = state.cieBrightness ?? 1;
    color.red = rgb.red * brightness;
    color.green = rgb.green * brightness;
    color.blue = rgb.blue * brightness;
  }
  if (state.kelvin !== undefined) {
    const [red, green, blue] = kelvinToRgb(state.kelvin);
    const [nativeRed, nativeGreen, nativeBlue] = kelvinToRgb(NATIVE_KELVIN);
    const r = red / nativeRed;
    const g = green / nativeGreen;
    const b = blue / nativeBlue;
    const peak = Math.max(r, g, b);
    color.red *= r / peak;
    color.green *= g / peak;
    color.blue *= b / peak;
  }
  color.red *= 1 - state.cyan;
  color.green *= 1 - state.magenta;
  color.blue *= 1 - state.yellow;
}

/**
 * Returns true when the state defines the source color itself (HSB or CIE),
 * so an element without additive channels is still lit in that color.
 */
export function definesSourceColor(state: PhysicalState): boolean {
  return (
    state.hue !== undefined ||
    state.saturation !== undefined ||
    (state.cieX !== undefined && state.cieY !== undefined)
  );
}
