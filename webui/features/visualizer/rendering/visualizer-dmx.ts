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

import { cieChromaticityToFullBrightnessRgb } from "../../../lib/color-path-preview";
import {
  type CieColor,
  type FixtureElement,
  type ParameterFunction,
  ParameterValuePolarity,
} from "../../../types";
import {
  attributeOutputKey,
  type EvaluatedChannel,
  evaluateElementChannels,
  evaluateFixtureChannels,
  fixtureDimmerLevel,
} from "./channel-evaluation";
import {
  applyPhysicalColor,
  collectPhysical,
  definesSourceColor,
  type PhysicalState,
  resetPhysicalState,
} from "./gdtf-physical";

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
  /** Pan angle in degrees from the profile's physical range, when it declares one. */
  panDegrees?: number;
  /** Tilt angle in degrees from the profile's physical range, when it declares one. */
  tiltDegrees?: number;
  /** Continuous pan rotation speed in degrees per second; 0 when not spinning. */
  panRotation: number;
  /** Continuous tilt rotation speed in degrees per second; 0 when not spinning. */
  tiltRotation: number;
  zoom: number;
  /** Beam angle in degrees from the profile's zoom function, when it states one. */
  zoomDegrees?: number;
  /** Iris aperture as a fraction of the open beam, when the element has an iris. */
  iris?: number;
  tiltSpeed: number;
  strobeShutter: number;
  /** Strobe frequency in hertz from the profile, while a strobe function is active. */
  strobeHz?: number;
  /** 1-based index into the element's gobo images (see `elementGoboMedia`), or 0 for none. */
  gobo: number;
}

export const STROBE_SHUTTER_MIN_HZ = 1;
export const STROBE_SHUTTER_MAX_HZ = 20;
const DEFAULT_TILT_SPEED_NORMALIZED = 3 / 13;
const DEFAULT_PAN_RANGE_DEG = 540;
const DEFAULT_TILT_RANGE_DEG = 270;

/**
 * Profile function attributes whose physical value drives movement:
 * positions in degrees and continuous rotation in degrees per second.
 */
const MOVEMENT_FUNCTIONS: Record<
  string,
  "panDegrees" | "tiltDegrees" | "panRotation" | "tiltRotation"
> = {
  Pan: "panDegrees",
  Tilt: "tiltDegrees",
  PanRotate: "panRotation",
  TiltRotate: "tiltRotation",
};

/** Smallest physical span, in degrees, taken as a position function's real range. */
const MIN_POSITION_SPAN_DEG = 1;

/**
 * Returns true when a position channel's physical value is a usable angle:
 * its active channel set or, failing that, its function states an angular
 * range. Profiles that leave both empty or at GDTF's 0-1 default fall back
 * to the normalized position instead of moving through at most one degree.
 */
function statesAngles(channel: EvaluatedChannel): boolean {
  const set = channel.set;
  if (set?.physical_from !== undefined && set.physical_to !== undefined) {
    return (
      Math.abs(set.physical_to - set.physical_from) > MIN_POSITION_SPAN_DEG
    );
  }
  const fn = channel.function;
  return (
    fn !== undefined &&
    Math.abs(fn.physical_to - fn.physical_from) > MIN_POSITION_SPAN_DEG
  );
}

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
      panRotation: 0,
      tiltRotation: 0,
      zoom: 0.5,
      tiltSpeed: DEFAULT_TILT_SPEED_NORMALIZED,
      strobeShutter: 0,
      gobo: 0,
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
  dmx.panDegrees = undefined;
  dmx.tiltDegrees = undefined;
  dmx.panRotation = 0;
  dmx.tiltRotation = 0;
  dmx.zoom = 0.5;
  dmx.tiltSpeed = DEFAULT_TILT_SPEED_NORMALIZED;
  dmx.strobeShutter = 0;
  dmx.gobo = 0;
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

/** Gobo image lists per element, computed once per element object. */
const elementGoboMediaCache = new WeakMap<FixtureElement, string[]>();

/** Matches GDTF gobo wheel attributes (`Gobo1`, `Gobo2SelectSpin`, ...), capturing the wheel number. */
const GOBO_WHEEL_ATTRIBUTE = /^Gobo(\d+)/;

/**
 * Returns the gobo wheel number a profile function selects slots on, or
 * undefined for functions on other wheels (color, prism, animation) whose
 * slot images are swatches or effects rather than projected gobos.
 */
function goboWheelNumber(
  fn: ParameterFunction | undefined,
): number | undefined {
  const match = fn && GOBO_WHEEL_ATTRIBUTE.exec(fn.attribute);
  return match ? Number(match[1]) : undefined;
}

/**
 * Returns the distinct gobo images an element's gobo wheels can select, in
 * parameter/function/set order. Renderers and DMX extraction share this
 * ordering so a numeric gobo index identifies the same image on both sides.
 */
export function elementGoboMedia(element: FixtureElement): string[] {
  let media = elementGoboMediaCache.get(element);
  if (!media) {
    const names = new Set<string>();
    for (const parameter of element.parameters) {
      for (const fn of parameter.functions ?? []) {
        if (goboWheelNumber(fn) === undefined) continue;
        for (const set of fn.sets ?? []) {
          if (set.media) names.add(set.media);
        }
      }
    }
    media = [...names];
    elementGoboMediaCache.set(element, media);
  }
  return media;
}

/** Display colors of profile CIE colors, keyed by chromaticity. */
const cieDisplayColors = new Map<string, ColorContribution>();

/** Returns the display RGB of a profile CIE color, caching conversions for the render loop. */
function cieDisplayColor(color: CieColor): ColorContribution {
  const key = `${color.x},${color.y}`;
  let cached = cieDisplayColors.get(key);
  if (!cached) {
    const rgb = cieChromaticityToFullBrightnessRgb(color);
    cached = { r: rgb.red, g: rgb.green, b: rgb.blue };
    cieDisplayColors.set(key, cached);
  }
  return cached;
}

/** Smallest strobe rate that still strobes; zero means an open shutter. */
const MIN_PROFILE_STROBE_RATE = 1e-3;

/**
 * Returns the normalized strobe rate of a profile shutter function at a DMX value.
 *
 * GDTF separates plain `ShutterN` functions (open/closed) from strobe
 * variants such as `ShutterNStrobe`, `...Pulse` and `...Random`. Only the
 * latter strobe, at a rate given by the position within the function's
 * DMX range, reversed when the physical frequency descends across it;
 * plain shutter functions return 0 so the beam stays steady.
 */
function profileStrobeRate(fn: ParameterFunction, dmx: number): number {
  if (!/strobe|pulse|random/i.test(fn.attribute)) return 0;
  const span = fn.dmx_to - fn.dmx_from;
  let position = span > 0 ? (dmx - fn.dmx_from) / span : 1;
  if (fn.physical_from > fn.physical_to) position = 1 - position;
  return Math.max(MIN_PROFILE_STROBE_RATE, Math.min(1, position));
}

/** Converts a normalized strobe shutter value into the visualizer strobe frequency. */
export function strobeShutterFrequencyHz(strobeShutter: number): number {
  const normalized = Math.min(1, Math.max(0, strobeShutter));
  return (
    STROBE_SHUTTER_MIN_HZ +
    (STROBE_SHUTTER_MAX_HZ - STROBE_SHUTTER_MIN_HZ) * normalized
  );
}

/**
 * Returns the on/off intensity scale for a strobe shutter at a render time.
 * `strobeHz`, when the profile states the frequency, replaces the
 * visualizer's 1-20 Hz mapping of the normalized rate.
 */
export function strobeShutterOutputScale(
  strobeShutter: number | undefined,
  timeSeconds: number,
  strobeHz?: number,
): number {
  if (strobeShutter === undefined || strobeShutter <= 0) {
    return 1;
  }

  const frequencyHz = strobeHz ?? strobeShutterFrequencyHz(strobeShutter);
  const phase = (timeSeconds * frequencyHz) % 1;
  return phase < 0.5 ? 1 : 0;
}

/** Applies strobe shutter gating to an already-normalized intensity value. */
export function applyStrobeShutterIntensity(
  intensity: number,
  strobeShutter: number | undefined,
  timeSeconds: number,
  strobeHz?: number,
): number {
  return (
    intensity * strobeShutterOutputScale(strobeShutter, timeSeconds, strobeHz)
  );
}

/**
 * Extract normalized DMX values from ParameterState output for a single element.
 *
 * The element is evaluated on its own, so mode masters and relations naming
 * other elements are ignored; renderers use {@link extractFixtureDmxData}.
 * Uses object pooling to avoid allocations in hot path.
 * @param output The output record from ParameterState (attribute name -> value)
 * @param element Element metadata containing parameter definitions
 * @returns Normalized DMX values for visualizer rendering (pooled object, valid until resetDmxPool)
 */
export function extractVisualizerDmx(
  output: Record<string, number>,
  element: FixtureElement,
  fixtureIntensity: number | undefined = undefined,
): VisualizerDmx {
  return visualizerDmxFromChannels(
    evaluateElementChannels(element, output),
    element,
    fixtureIntensity,
  );
}

/**
 * Derives visualizer values for one element from its evaluated channels.
 *
 * An intensity channel that masters emitter channels of its own element
 * reaches them through relations, so it does not also dim the element. Elements
 * without an effective intensity take their brightness from the brightest
 * color component, with colors rescaled so brightness is not applied twice,
 * scaled by the fixture-level dimmer when one is given.
 */
function visualizerDmxFromChannels(
  channels: (EvaluatedChannel | undefined)[],
  element: FixtureElement,
  fixtureIntensity: number | undefined,
): VisualizerDmx {
  const dmx = getDmxFromPool();
  let baseRed = 0;
  let baseGreen = 0;
  let baseBlue = 0;
  let addRed = 0;
  let addGreen = 0;
  let addBlue = 0;
  let hasIntensity = false;
  let filterRed = 1;
  let filterGreen = 1;
  let filterBlue = 1;
  let hasFilter = false;
  let goboWheel = Number.POSITIVE_INFINITY;
  let declaresIntensityControl = elementDeclaresIntensityControl(element);
  const physical = resetPhysicalState(physicalState);

  for (const channel of channels) {
    if (!channel) continue;
    const param = channel.parameter;
    const attrType = param.attribute.type;
    const prop = ATTR_TO_PROP[attrType];
    const color = ATTR_TO_COLOR[attrType];
    if (prop === "intensity" && channel.mastersOwnEmitters) {
      declaresIntensityControl = false;
      continue;
    }
    if (collectPhysical(physical, channel)) continue;

    const normalized =
      attrType === "Pan" || attrType === "Tilt"
        ? param.value_polarity === ParameterValuePolarity.Signed
          ? normalizeSignedPositionOutput(channel.value, attrType)
          : normalizeParameterOutput(channel.value, param)
        : channel.level;

    // Profile colors take precedence over attribute-name approximations.
    if (channel.function?.emitter_color) {
      const emitter = cieDisplayColor(channel.function.emitter_color);
      addRed += emitter.r * normalized;
      addGreen += emitter.g * normalized;
      addBlue += emitter.b * normalized;
      if (prop === "intensity") {
        hasIntensity = true;
        dmx.intensity = normalized;
      }
      continue;
    }
    const slot = channel.set;
    if (slot?.color) {
      // A filter passes its measured share of white light (Y of 100).
      const filter = cieDisplayColor(slot.color);
      const transmission = Math.min(1, Math.max(0, slot.color.Y / 100));
      filterRed *= filter.r * transmission;
      filterGreen *= filter.g * transmission;
      filterBlue *= filter.b * transmission;
      hasFilter = true;
    }
    const wheel = goboWheelNumber(channel.function);
    // One gobo is projected: the lowest-numbered wheel with an image in place.
    if (slot?.media && wheel !== undefined && wheel < goboWheel) {
      dmx.gobo = elementGoboMedia(element).indexOf(slot.media) + 1;
      goboWheel = wheel;
    }
    if (prop === "strobeShutter" && channel.function) {
      dmx.strobeShutter = profileStrobeRate(channel.function, channel.dmx);
      continue;
    }
    const movement = channel.function
      ? MOVEMENT_FUNCTIONS[channel.function.attribute]
      : undefined;
    if (movement === "panRotation" || movement === "tiltRotation") {
      dmx[movement] = channel.physical;
      continue;
    }
    if (movement && statesAngles(channel)) {
      dmx[movement] = channel.physical;
    }

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
  const filtersSource =
    hasFilter ||
    physical.kelvin !== undefined ||
    physical.cyan + physical.magenta + physical.yellow > 0;
  if (
    filtersSource &&
    !definesSourceColor(physical) &&
    !elementDeclaresAdditiveColor(element) &&
    dmx.red + dmx.green + dmx.blue <= 0
  ) {
    // Filters act on the source; a lamp without additive color is white.
    // Additive emitters at zero stay dark instead.
    dmx.red = 1;
    dmx.green = 1;
    dmx.blue = 1;
  }
  applyPhysicalColor(physical, dmx);
  if (hasFilter) {
    dmx.red *= filterRed;
    dmx.green *= filterGreen;
    dmx.blue *= filterBlue;
  }
  if (!hasIntensity && !declaresIntensityControl) {
    const peak = Math.max(dmx.red, dmx.green, dmx.blue);
    if (peak > 0) {
      dmx.red /= peak;
      dmx.green /= peak;
      dmx.blue /= peak;
    }
    dmx.intensity = peak * (fixtureIntensity ?? 1);
  }
  dmx.intensity *= physical.transmission;
  dmx.frost = Math.max(dmx.frost, physical.frost ?? 0);
  dmx.strobeHz = dmx.strobeShutter > 0 ? physical.strobeHz : undefined;
  dmx.iris = physical.iris;
  dmx.zoomDegrees = physical.zoomDegrees;

  return dmx;
}

/** Physical state reused by every extraction in the render loop. */
const physicalState: PhysicalState = resetPhysicalState({
  cyan: 0,
  magenta: 0,
  yellow: 0,
  transmission: 1,
});

/** Visualizer values of one element, keyed by its label. */
export type LabelledElementDmx = [label: string, dmx: Record<string, number>];

/**
 * Extracts visualizer values for every element of a fixture that has output.
 *
 * Channels are evaluated together so mode masters and relations can name
 * other elements. Dimmers that master no relation dim the elements that
 * have no dimmer of their own (see {@link fixtureDimmerLevel}).
 */
export function extractFixtureDmxData(
  elements: FixtureElement[],
  outputs: (Record<string, number> | undefined)[],
): LabelledElementDmx[] {
  const channels = evaluateFixtureChannels(elements, outputs);
  const fixtureIntensity = fixtureDimmerLevel(elements, channels);
  const result: LabelledElementDmx[] = [];
  for (let i = 0; i < elements.length; i++) {
    const output = outputs[i];
    if (!output) continue;
    result.push([
      elements[i].label,
      elementDmxData(channels[i], output, elements[i], fixtureIntensity),
    ]);
  }
  return result;
}

/** Attribute types that drive an additive emitter; CMY here are subtractive flags. */
const ADDITIVE_COLOR_ATTRIBUTES = new Set([
  "Red",
  "Green",
  "Blue",
  "White",
  "WarmWhite",
  "CoolWhite",
  "Amber",
  "UV",
]);

/** Matches GDTF additive color-mixing attributes (`ColorAdd_R`, `ColorRGB_Red`, ...). */
const ADDITIVE_COLOR_FUNCTION = /^Color(Add|RGB)_/;

/** Additive-color declarations per element, computed once per element object. */
const elementAdditiveColorCache = new WeakMap<FixtureElement, boolean>();

/**
 * Returns true when the element's channels in the active mode mix color
 * additively: RGB-family attributes, GDTF `ColorAdd_*`/`ColorRGB_*`
 * functions, or functions carrying a measured emitter color. Such an element
 * produces its own light color, so all emitters at zero means no light rather
 * than a white lamp behind its filters.
 */
export function elementDeclaresAdditiveColor(element: FixtureElement): boolean {
  let declares = elementAdditiveColorCache.get(element);
  if (declares === undefined) {
    declares = element.parameters.some(
      (parameter) =>
        ADDITIVE_COLOR_ATTRIBUTES.has(parameter.attribute.type) ||
        (parameter.functions ?? []).some(
          (fn) =>
            fn.emitter_color !== undefined ||
            ADDITIVE_COLOR_FUNCTION.test(fn.attribute),
        ),
    );
    elementAdditiveColorCache.set(element, declares);
  }
  return declares;
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
 * Derives the fixture-level dimmer from element outputs: the level of the
 * dimmers that master no relation, or undefined when the fixture has none.
 */
export function fixtureIntensityValueFromOutputs(
  elementOutputs: (Record<string, number> | undefined)[],
  elements: FixtureElement[],
): number | undefined {
  return fixtureDimmerLevel(
    elements,
    evaluateFixtureChannels(elements, elementOutputs),
  );
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
  return elementDmxData(
    evaluateElementChannels(element, output),
    output,
    element,
    fixtureIntensity,
  );
}

/**
 * Builds an element's visualizer record: every parameter's normalized value
 * by attribute key, plus the derived aliases from its evaluated channels.
 */
function elementDmxData(
  channels: (EvaluatedChannel | undefined)[],
  output: Record<string, number>,
  element: FixtureElement,
  fixtureIntensity: number | undefined,
): Record<string, number> {
  const elementDmx: Record<string, number> = {};

  for (const param of element.parameters) {
    const attrKey = attributeOutputKey(param.attribute);
    const value = attributeOutputValue(output, param.attribute);
    if (value === undefined || param.max <= 0) continue;
    elementDmx[attrKey] =
      param.value_polarity === ParameterValuePolarity.Signed &&
      (param.attribute.type === "Pan" || param.attribute.type === "Tilt")
        ? normalizeSignedPositionOutput(value, param.attribute.type)
        : normalizeParameterOutput(value, param);
  }

  const dmx = visualizerDmxFromChannels(channels, element, fixtureIntensity);
  elementDmx.red = dmx.red;
  elementDmx.green = dmx.green;
  elementDmx.blue = dmx.blue;
  elementDmx.intensity = dmx.intensity;
  elementDmx.white = dmx.white;
  elementDmx.frost = dmx.frost;
  elementDmx.prism = dmx.prism;
  elementDmx.uv = dmx.uv;
  elementDmx.tiltSpeed = dmx.tiltSpeed;
  elementDmx.gobo = dmx.gobo;
  if (elementDmx.StrobeShutter !== undefined) {
    elementDmx.strobeShutter = dmx.strobeShutter;
  }
  if (dmx.strobeHz !== undefined) elementDmx.strobeHz = dmx.strobeHz;
  if (dmx.iris !== undefined) elementDmx.iris = dmx.iris;
  if (dmx.zoomDegrees !== undefined) elementDmx.zoomDegrees = dmx.zoomDegrees;

  if (elementDmx.Pan !== undefined && dmx.pan !== undefined) {
    elementDmx.pan = dmx.pan;
  }
  if (elementDmx.Tilt !== undefined && dmx.tilt !== undefined) {
    elementDmx.tilt = dmx.tilt;
  }
  if (dmx.panDegrees !== undefined) elementDmx.panDegrees = dmx.panDegrees;
  if (dmx.tiltDegrees !== undefined) elementDmx.tiltDegrees = dmx.tiltDegrees;
  if (dmx.panRotation !== 0) elementDmx.panRotation = dmx.panRotation;
  if (dmx.tiltRotation !== 0) elementDmx.tiltRotation = dmx.tiltRotation;
  if (elementDmx.Zoom !== undefined) {
    elementDmx.zoom = dmx.zoom;
  }

  return elementDmx;
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
