// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Visualizer DMX transformation utilities.
 * Derives normalized visualizer values from ParameterState output.
 */

import {
  type FixtureElement,
  ParameterUnit,
  ParameterValuePolarity,
} from "../../../types";

/** Visualizer-friendly parameter state */
export interface VisualizerDmx {
  intensity: number;
  red: number;
  green: number;
  blue: number;
  white: number;
  frost: number;
  prism: number;
  uv: number;
  pan?: number;
  tilt?: number;
  zoom: number;
  zoomDegrees?: number;
  focus?: number;
  tiltSpeed: number;
  strobeShutter: number;
}

export const STROBE_SHUTTER_MIN_HZ = 1;
export const STROBE_SHUTTER_MAX_HZ = 20;
const DEFAULT_TILT_SPEED_NORMALIZED = 3 / 13;
const DEFAULT_PAN_RANGE_DEG = 540;
const DEFAULT_TILT_RANGE_DEG = 270;

const TILT_SPEED_LABELS = new Set([
  "Tilt Speed",
  "Pan/Tilt Speed",
  "Rotation Speed",
]);

/** Reusable DMX object pool to avoid allocations in hot path */
const dmxPool: VisualizerDmx[] = [];
let dmxPoolIndex = 0;

/** Reset pool index at start of frame */
export function resetDmxPool(): void {
  dmxPoolIndex = 0;
}

/** Get a DMX object from pool, creating if needed */
function getDmxFromPool(): VisualizerDmx {
  if (dmxPoolIndex >= dmxPool.length) {
    dmxPool.push({
      intensity: 0,
      red: 0,
      green: 0,
      blue: 0,
      white: 0,
      frost: 0,
      prism: 0,
      uv: 0,
      zoom: 0.5,
      tiltSpeed: DEFAULT_TILT_SPEED_NORMALIZED,
      strobeShutter: 0,
    });
  }
  const dmx = dmxPool[dmxPoolIndex++];
  // Reset to defaults
  dmx.intensity = 0;
  dmx.red = 0;
  dmx.green = 0;
  dmx.blue = 0;
  dmx.white = 0;
  dmx.frost = 0;
  dmx.prism = 0;
  dmx.uv = 0;
  dmx.pan = undefined;
  dmx.tilt = undefined;
  dmx.zoom = 0.5;
  dmx.zoomDegrees = undefined;
  dmx.focus = undefined;
  dmx.tiltSpeed = DEFAULT_TILT_SPEED_NORMALIZED;
  dmx.strobeShutter = 0;
  return dmx;
}

type ColorContribution = {
  r: number;
  g: number;
  b: number;
  scale?: number;
};

/** Mapping from attribute type string to DMX property name */
const ATTR_TO_PROP: Record<string, keyof VisualizerDmx> = {
  Intensity: "intensity",
  VirtualIntensity: "intensity",
  Red: "red",
  Green: "green",
  Blue: "blue",
  White: "white",
  Frost: "frost",
  Prism: "prism",
  Pan: "pan",
  Tilt: "tilt",
  Zoom: "zoom",
  Focus: "focus",
  StrobeShutter: "strobeShutter",
};

/** Approximate RGB contributions for non-RGB attributes */
const ATTR_TO_COLOR: Record<string, ColorContribution> = {
  White: { r: 1.0, g: 1.0, b: 1.0 },
  WarmWhite: { r: 1.0, g: 0.85, b: 0.7 },
  CoolWhite: { r: 0.75, g: 0.85, b: 1.0 },
  Amber: { r: 1.0, g: 0.6, b: 0.1 },
  Cyan: { r: 0.0, g: 1.0, b: 1.0 },
  Magenta: { r: 1.0, g: 0.0, b: 1.0 },
  Yellow: { r: 1.0, g: 1.0, b: 0.0 },
  UV: { r: 0.3, g: 0.0, b: 0.5, scale: 0.6 },
};

/** Convert a parameter-space output value into the normalized visualizer range. */
function normalizeParameterOutput(
  value: number,
  param: Pick<
    FixtureElement["parameters"][number],
    "min" | "max" | "value_polarity"
  >,
): number {
  const range = param.max - param.min;
  if (range <= 0) return 0;
  if (param.value_polarity === ParameterValuePolarity.Signed) {
    const center = param.min >= 0 ? 0 : (param.min + param.max) / 2;
    return (value - center) / range;
  }
  return (value - param.min) / range;
}

/**
 * Convert signed pan/tilt logical degree offsets to the renderer's normalized range.
 */
function normalizeSignedPositionOutput(
  value: number,
  attrType: string,
): number {
  if (attrType === "Pan") {
    return value / DEFAULT_PAN_RANGE_DEG;
  }
  if (attrType === "Tilt") {
    return value / DEFAULT_TILT_RANGE_DEG;
  }
  return value;
}

/** Converts a normalized strobe shutter value into the visualizer strobe frequency. */
export function strobeShutterFrequencyHz(strobeShutter: number): number {
  const normalized = Math.min(1, Math.max(0, strobeShutter));
  return (
    STROBE_SHUTTER_MIN_HZ +
    (STROBE_SHUTTER_MAX_HZ - STROBE_SHUTTER_MIN_HZ) * normalized
  );
}

/** Returns the on/off intensity scale for a strobe shutter at a render time. */
export function strobeShutterOutputScale(
  strobeShutter: number | undefined,
  timeSeconds: number,
): number {
  if (strobeShutter === undefined || strobeShutter <= 0) {
    return 1;
  }

  const frequencyHz = strobeShutterFrequencyHz(strobeShutter);
  const phase = (timeSeconds * frequencyHz) % 1;
  return phase < 0.5 ? 1 : 0;
}

/** Applies strobe shutter gating to an already-normalized intensity value. */
export function applyStrobeShutterIntensity(
  intensity: number,
  strobeShutter: number | undefined,
  timeSeconds: number,
): number {
  return intensity * strobeShutterOutputScale(strobeShutter, timeSeconds);
}

/**
 * Extract normalized DMX values from ParameterState output for a single element.
 * Uses object pooling to avoid allocations in hot path.
 * @param output The output record from ParameterState (attribute name -> value)
 * @param element Element metadata containing parameter definitions
 * @returns Normalized DMX values for visualizer rendering (pooled object, valid until resetDmxPool)
 */
export function extractVisualizerDmx(
  output: Record<string, number>,
  element: FixtureElement,
  fixtureIntensity: number | undefined = undefined,
  normalizedAttributes?: Record<string, number>,
): VisualizerDmx {
  const dmx = getDmxFromPool();
  let baseRed = 0;
  let baseGreen = 0;
  let baseBlue = 0;
  let addRed = 0;
  let addGreen = 0;
  let addBlue = 0;
  let hasIntensity = false;
  const declaresIntensityControl = elementDeclaresIntensityControl(element);

  for (const param of element.parameters) {
    const attrType = param.attribute.type;
    const prop = ATTR_TO_PROP[attrType];
    const color = ATTR_TO_COLOR[attrType];

    const value = attributeOutputValue(output, param.attribute);
    if (value === undefined || param.max <= 0) continue;
    if (
      attrType === "Zoom" &&
      param.native_unit === ParameterUnit.Degrees &&
      Number.isFinite(value)
    ) {
      dmx.zoomDegrees = value;
    }
    const normalized =
      param.value_polarity === ParameterValuePolarity.Signed &&
      (attrType === "Pan" || attrType === "Tilt")
        ? normalizeSignedPositionOutput(value, attrType)
        : normalizeParameterOutput(value, param);
    // Optical channels read their normalized control by this same output key.
    if (normalizedAttributes)
      normalizedAttributes[attributeOutputKey(param.attribute)] = normalized;
    if (attrType === "Custom") {
      if (TILT_SPEED_LABELS.has(param.attribute.data.label)) {
        dmx.tiltSpeed = normalized;
      }
      continue;
    }
    if (!prop && !color) continue;
    if (color) {
      const scale = color.scale ?? 1.0;
      if (attrType === "UV") {
        dmx.uv = Math.max(dmx.uv, normalized);
      }
      addRed += color.r * normalized * scale;
      addGreen += color.g * normalized * scale;
      addBlue += color.b * normalized * scale;
    }
    if (prop) {
      if (prop === "red") {
        baseRed = normalized;
      } else if (prop === "green") {
        baseGreen = normalized;
      } else if (prop === "blue") {
        baseBlue = normalized;
      } else {
        if (prop === "intensity") {
          hasIntensity = true;
        }
        dmx[prop] = normalized;
      }
    }
  }

  dmx.red = Math.min(1, baseRed + addRed);
  dmx.green = Math.min(1, baseGreen + addGreen);
  dmx.blue = Math.min(1, baseBlue + addBlue);
  if (!hasIntensity && !declaresIntensityControl) {
    if (fixtureIntensity !== undefined) {
      dmx.intensity = fixtureIntensity;
      return dmx;
    }
    dmx.intensity = Math.max(dmx.red, dmx.green, dmx.blue);
  }

  return dmx;
}

/** Returns true when an element contains a real or virtual dimmer attribute. */
export function elementDeclaresIntensityControl(
  element: FixtureElement,
): boolean {
  return element.parameters.some((parameter) =>
    ["Intensity", "VirtualIntensity"].includes(parameter.attribute.type),
  );
}

/**
 * Derives the fixture-level dimmer from element outputs when any element declares intensity control.
 */
export function fixtureIntensityValueFromOutputs(
  elementOutputs: Record<string, number>[],
  elements: FixtureElement[],
): number | undefined {
  let fixtureDeclaresIntensity = false;
  let fixtureIntensity = 0;

  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    if (!elementDeclaresIntensityControl(element)) continue;

    fixtureDeclaresIntensity = true;
    const output = elementOutputs[i];
    if (!output) continue;

    for (const param of element.parameters) {
      if (!["Intensity", "VirtualIntensity"].includes(param.attribute.type)) {
        continue;
      }

      const value = attributeOutputValue(output, param.attribute);
      if (value === undefined || param.max <= 0) continue;
      fixtureIntensity = Math.max(
        fixtureIntensity,
        normalizeParameterOutput(value, param),
      );
    }
  }

  return fixtureDeclaresIntensity ? fixtureIntensity : undefined;
}

/**
 * Extract dynamic normalized DMX parameter state for a single element.
 *
 * Includes:
 * - All element parameters by attribute type (e.g. "Red", "Dimmer", "Pan")
 * - Derived visualizer-friendly aliases (red/green/blue/intensity/etc.) for rendering
 */
export function extractElementDmxData(
  output: Record<string, number>,
  element: FixtureElement,
  fixtureIntensity: number | undefined = undefined,
): Record<string, number> {
  const elementDmx: Record<string, number> = {};

  const dmx = extractVisualizerDmx(
    output,
    element,
    fixtureIntensity,
    elementDmx,
  );
  elementDmx.red = dmx.red;
  elementDmx.green = dmx.green;
  elementDmx.blue = dmx.blue;
  elementDmx.intensity = dmx.intensity;
  elementDmx.white = dmx.white;
  elementDmx.frost = dmx.frost;
  elementDmx.prism = dmx.prism;
  if (dmx.focus !== undefined) elementDmx.focus = dmx.focus;
  elementDmx.uv = dmx.uv;
  elementDmx.tiltSpeed = dmx.tiltSpeed;
  if (elementDmx.StrobeShutter !== undefined) {
    elementDmx.strobeShutter = dmx.strobeShutter;
  }

  if (elementDmx.Pan !== undefined && dmx.pan !== undefined) {
    elementDmx.pan = dmx.pan;
  }
  if (elementDmx.Tilt !== undefined && dmx.tilt !== undefined) {
    elementDmx.tilt = dmx.tilt;
  }
  if (elementDmx.Zoom !== undefined) {
    elementDmx.zoom = dmx.zoom;
    if (dmx.zoomDegrees !== undefined) elementDmx.zoomDegrees = dmx.zoomDegrees;
  }

  return elementDmx;
}

/**
 * Resolve the output key used by parameter state records for an attribute.
 */
function attributeOutputKey(
  attribute: FixtureElement["parameters"][number]["attribute"],
): string {
  return attribute.type === "Custom" ? attribute.data.label : attribute.type;
}

/**
 * Read a parameter output value by its canonical attribute key.
 */
function attributeOutputValue(
  output: Record<string, number>,
  attribute: FixtureElement["parameters"][number]["attribute"],
): number | undefined {
  const key = attributeOutputKey(attribute);
  if (attribute.type === "VirtualIntensity") {
    return output.VirtualIntensity ?? output.Intensity;
  }
  return output[key];
}
