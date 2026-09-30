// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../../../types";
import {
  ColorInterpolationSpace,
  FxDirection,
  HueDirection,
} from "../../../types";
import { stepFxAttributeName } from "./step-fx-editor-model";

/** Primary emitter attributes whose attribute lanes a new color lane replaces. */
export const STEP_FX_COLOR_PRIMARY_ATTRIBUTES = [
  "Red",
  "Green",
  "Blue",
  "Cyan",
  "Magenta",
  "Yellow",
] as const;

/** Additive emitters that receive the RGB decomposition on color-covered elements. */
const RGB_COLOR_MIX_ATTRIBUTES = ["White", "WarmWhite", "CoolWhite", "Amber"];

/** Interpolation spaces offered by the editor, in presentation order. */
export const STEP_FX_COLOR_SPACES = [
  ColorInterpolationSpace.Rgb,
  ColorInterpolationSpace.Hsv,
  ColorInterpolationSpace.Cmy,
] as const;

/** Builds one color step that fades into its color across its whole width. */
export function createStepFxColorStep(
  color: types.ColorPathRgb,
  blueprintUid?: string,
): types.FxColorStep {
  return {
    uid: crypto.randomUUID(),
    color: { ...color },
    blueprint_uid: blueprintUid,
    width_beats: 1,
    transition: { start: 0, end: 1 },
    curve: { type: "Linear", data: {} },
  };
}

/** Creates the default color lane: two steps fading red into blue and back. */
export function createDefaultStepFxColorLane(): types.FxColorLane {
  return {
    interpolation_space: ColorInterpolationSpace.Rgb,
    hue_direction: HueDirection.Shortest,
    steps: [
      createStepFxColorStep({ red: 1, green: 0, blue: 0 }),
      createStepFxColorStep({ red: 0, green: 0, blue: 1 }),
    ],
  };
}

/** Returns the attribute lanes a new color lane replaces. */
export function stepFxLanesReplacedByColor(
  stepFx: types.StepFx,
): types.FxLane[] {
  const primaries = new Set<string>(STEP_FX_COLOR_PRIMARY_ATTRIBUTES);
  return stepFx.lanes.filter((lane) =>
    primaries.has(stepFxAttributeName(lane.attribute)),
  );
}

/** Adds the default color lane, removing any primary-emitter attribute lanes it replaces. */
export function addStepFxColorLane(stepFx: types.StepFx): types.StepFx {
  const replaced = new Set(stepFxLanesReplacedByColor(stepFx));
  return {
    ...structuredClone(stepFx),
    lanes: stepFx.lanes
      .filter((lane) => !replaced.has(lane))
      .map((lane) => structuredClone(lane)),
    color: createDefaultStepFxColorLane(),
  };
}

/** Formats a normalized color as an uppercase six-digit hex string. */
export function stepFxColorToHex(color: types.ColorPathRgb): string {
  const channel = (value: number) =>
    Math.round(Math.max(0, Math.min(1, value)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(color.red)}${channel(color.green)}${channel(color.blue)}`.toUpperCase();
}

/** Parses a six-digit hex string into a normalized color. */
export function stepFxColorFromHex(hex: string): types.ColorPathRgb {
  const value = Number.parseInt(hex.replace(/^#/, "").slice(0, 6), 16);
  const safe = Number.isFinite(value) ? value : 0;
  return {
    red: ((safe >> 16) & 0xff) / 255,
    green: ((safe >> 8) & 0xff) / 255,
    blue: (safe & 0xff) / 255,
  };
}

/**
 * Derives a normalized color from a Blueprint's inline red/green/blue or cyan/magenta/yellow
 * values, mirroring the engine's live Blueprint color resolution.
 */
export function blueprintStepFxColor(
  blueprint: types.Blueprint,
): types.ColorPathRgb | undefined {
  const component = (attribute: string): number | undefined => {
    const source = blueprint.values[attribute];
    if (source?.type !== "Inline") return undefined;
    const value = source.data;
    if (value.type === "AbsolutePercent") return value.data.value;
    if (value.type === "Absolute") return value.data.value / 255;
    return undefined;
  };
  const clamp = (value: number | undefined) =>
    Math.max(0, Math.min(1, value ?? 0));
  const rgb = ["Red", "Green", "Blue"].map(component);
  if (rgb.some((value) => value !== undefined)) {
    return { red: clamp(rgb[0]), green: clamp(rgb[1]), blue: clamp(rgb[2]) };
  }
  const cmy = ["Cyan", "Magenta", "Yellow"].map(component);
  if (cmy.some((value) => value !== undefined)) {
    return {
      red: 1 - clamp(cmy[0]),
      green: 1 - clamp(cmy[1]),
      blue: 1 - clamp(cmy[2]),
    };
  }
  return undefined;
}

/** Resolves one step's color, preferring its live Blueprint when that Blueprint holds a color. */
export function resolvedStepFxColor(
  step: types.FxColorStep,
  blueprints: Record<string, types.Blueprint>,
): types.ColorPathRgb {
  const blueprint = step.blueprint_uid
    ? findBlueprint(blueprints, step.blueprint_uid)
    : undefined;
  return (blueprint && blueprintStepFxColor(blueprint)) ?? step.color;
}

/** Finds a Blueprint by UUID regardless of compact or hyphenated spelling. */
export function findBlueprint(
  blueprints: Record<string, types.Blueprint>,
  uid: string,
): types.Blueprint | undefined {
  const compact = normalizeUid(uid);
  return Object.values(blueprints).find(
    (blueprint) => normalizeUid(blueprint.identifiers.uid) === compact,
  );
}

/** Interpolates two normalized colors through the lane's color space at a curved ratio. */
export function interpolateStepFxColor(
  space: types.ColorInterpolationSpace,
  hueDirection: types.HueDirection,
  start: types.ColorPathRgb,
  end: types.ColorPathRgb,
  ratio: number,
): types.ColorPathRgb {
  const t = Math.max(0, Math.min(1, ratio));
  if (space === ColorInterpolationSpace.Hsv) {
    const from = rgbToHsv(start);
    const to = rgbToHsv(end);
    return hsvToRgb({
      hue: interpolateHue(from.hue, to.hue, t, hueDirection),
      saturation: lerp(from.saturation, to.saturation, t),
      value: lerp(from.value, to.value, t),
    });
  }
  // CMY interpolation is the complement of RGB interpolation, so both are channel lerps.
  return {
    red: clamp01(lerp(start.red, end.red, t)),
    green: clamp01(lerp(start.green, end.green, t)),
    blue: clamp01(lerp(start.blue, end.blue, t)),
  };
}

/**
 * Samples the color lane at a normalized cycle position for one authored start position.
 *
 * Mirrors the engine's beat-native step location, including transition windows, curves,
 * wrap interpolation from the last step, and reverse or bounce traversal.
 */
export function sampleStepFxColorLane(
  lane: types.FxColorLane,
  direction: FxDirection,
  cyclePosition: number,
  startPosition: number,
  blueprints: Record<string, types.Blueprint> = {},
): types.ColorPathRgb | undefined {
  const steps = lane.steps;
  if (steps.length === 0) return undefined;
  const color = (index: number) =>
    resolvedStepFxColor(steps[index], blueprints);
  if (steps.length === 1) return color(0);
  const located = locateStepFxColorStep(
    lane,
    direction,
    cyclePosition,
    startPosition,
  );
  if (!located) return undefined;
  const { index, beat, start } = located;
  if (beat >= start + steps[index].width_beats) return color(index);
  const step = steps[index];
  const previous = index === 0 ? steps.length - 1 : index - 1;
  const transitionStart = step.width_beats * clamp01(step.transition.start);
  const transitionEnd = step.width_beats * clamp01(step.transition.end);
  const segment = Math.max(0, Math.min(step.width_beats, beat - start));
  if (segment < transitionStart) return color(previous);
  if (transitionEnd - transitionStart <= 0 || segment >= transitionEnd)
    return color(index);
  const factor = evaluateCurve(
    step.curve,
    (segment - transitionStart) / (transitionEnd - transitionStart),
  );
  return interpolateStepFxColor(
    lane.interpolation_space,
    lane.hue_direction,
    color(previous),
    color(index),
    factor,
  );
}

/** Returns the index of the step a fixture is in at one cycle position, if the lane can play. */
export function stepFxColorLaneStepIndexAt(
  lane: types.FxColorLane,
  direction: FxDirection,
  cyclePosition: number,
  startPosition: number,
): number | undefined {
  if (lane.steps.length === 1) return 0;
  return locateStepFxColorStep(lane, direction, cyclePosition, startPosition)
    ?.index;
}

/**
 * Finds the step containing a cycle position, mirroring the engine's step lookup.
 *
 * Returns the authored beat and the located step's starting beat. Positions at the very
 * end of a pass resolve to the last step with `beat` equal to the pass length.
 */
function locateStepFxColorStep(
  lane: types.FxColorLane,
  direction: FxDirection,
  cyclePosition: number,
  startPosition: number,
): { index: number; beat: number; start: number } | undefined {
  const steps = lane.steps;
  if (steps.length === 0) return undefined;
  const passBeats = steps.reduce((total, step) => total + step.width_beats, 0);
  if (!Number.isFinite(passBeats) || passBeats <= 0) return undefined;
  const passes = direction === FxDirection.Bounce ? 2 : 1;
  const position = mod1(cyclePosition + mod1(startPosition / passes));
  const beat = authoredBeatPosition(position, passBeats, direction);
  let start = 0;
  for (let index = 0; index < steps.length; index++) {
    if (beat < start + steps[index].width_beats) return { index, beat, start };
    start += steps[index].width_beats;
  }
  const last = steps.length - 1;
  return { index: last, beat, start: passBeats - steps[last].width_beats };
}

/** Builds a CSS gradient of one complete color cycle for one authored start position. */
export function stepFxColorCycleGradient(
  lane: types.FxColorLane,
  direction: FxDirection,
  startPosition: number,
  blueprints: Record<string, types.Blueprint> = {},
  samples = 96,
): string {
  const stops: string[] = [];
  for (let sample = 0; sample <= samples; sample++) {
    const position = sample / samples;
    const color = sampleStepFxColorLane(
      lane,
      direction,
      Math.min(position, 1 - 1e-6),
      startPosition,
      blueprints,
    );
    if (color)
      stops.push(`${stepFxColorToHex(color)} ${(position * 100).toFixed(2)}%`);
  }
  return stops.length > 0
    ? `linear-gradient(to right, ${stops.join(", ")})`
    : "none";
}

/** Coverage of one attribute lane by the color lane across the targeted fixture elements. */
export interface StepFxColorLaneShadow {
  /** Targeted elements exposing the lane's attribute. */
  total: number;
  /** Elements among those whose attribute the color lane controls instead. */
  shadowed: number;
}

/**
 * Reports, per attribute lane name, how many targeted elements the color lane controls
 * instead of that lane, mirroring the engine's per-element color emitter ownership.
 */
export function stepFxColorLaneShadows(
  stepFx: types.StepFx,
  fixtures: readonly types.Fixture[],
  targets: readonly types.FixtureRef[],
): Map<string, StepFxColorLaneShadow> {
  const shadows = new Map<string, StepFxColorLaneShadow>();
  if (!stepFx.color) return shadows;
  const laneNames = stepFx.lanes.map((lane) =>
    stepFxAttributeName(lane.attribute),
  );
  for (const name of laneNames) shadows.set(name, { total: 0, shadowed: 0 });
  const fixturesByUid = new Map(
    fixtures.map((fixture) => [normalizeUid(fixture.identifiers.uid), fixture]),
  );
  for (const target of targets) {
    const fixture = fixturesByUid.get(normalizeUid(target.fixture_uid));
    if (!fixture) continue;
    const elements =
      target.index === undefined || target.index === null
        ? fixture.elements
        : [fixture.elements[target.index - 1]].filter(Boolean);
    for (const element of elements) {
      const attributes = new Set(
        (element.parameters ?? []).map((parameter) =>
          stepFxAttributeName(parameter.attribute),
        ),
      );
      const claimed = colorClaimedAttributes(attributes);
      for (const name of laneNames) {
        if (!attributes.has(name)) continue;
        const shadow = shadows.get(name);
        if (!shadow) continue;
        shadow.total++;
        if (claimed.has(name)) shadow.shadowed++;
      }
    }
  }
  return shadows;
}

/** Returns the attributes the color lane controls on an element with the given attributes. */
function colorClaimedAttributes(attributes: ReadonlySet<string>): Set<string> {
  const hasAll = (names: readonly string[]) =>
    names.every((name) => attributes.has(name));
  if (hasAll(["Red", "Green", "Blue"])) {
    return new Set([
      "Red",
      "Green",
      "Blue",
      ...RGB_COLOR_MIX_ATTRIBUTES.filter((name) => attributes.has(name)),
    ]);
  }
  if (hasAll(["Cyan", "Magenta", "Yellow"]))
    return new Set(["Cyan", "Magenta", "Yellow"]);
  return new Set();
}

/** Maps one normalized cycle position onto the forward-authored step sequence. */
function authoredBeatPosition(
  position: number,
  passBeats: number,
  direction: FxDirection,
): number {
  if (direction === FxDirection.Reverse) return (1 - position) * passBeats;
  if (direction === FxDirection.Bounce) {
    const traversal = position * 2;
    return (traversal <= 1 ? traversal : 2 - traversal) * passBeats;
  }
  return position * passBeats;
}

/** Evaluates a step transition curve at normalized transition time. */
function evaluateCurve(curve: types.CurveType, t: number): number {
  if (curve.type === "Snap") return 1;
  if (curve.type === "Linear") return t;
  return cubicBezier(
    curve.data.cp1.x,
    curve.data.cp1.y,
    curve.data.cp2.x,
    curve.data.cp2.y,
    t,
  );
}

/** Evaluates a CSS-style cubic Bézier easing by solving for x with bisection. */
function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  t: number,
): number {
  const axis = (a: number, b: number, s: number) =>
    3 * a * s * (1 - s) ** 2 + 3 * b * s ** 2 * (1 - s) + s ** 3;
  let low = 0;
  let high = 1;
  let s = t;
  for (let iteration = 0; iteration < 24; iteration++) {
    s = (low + high) / 2;
    if (axis(x1, x2, s) < t) low = s;
    else high = s;
  }
  return axis(y1, y2, s);
}

/** Internal HSV representation with hue normalized to 0-1. */
interface Hsv {
  hue: number;
  saturation: number;
  value: number;
}

/** Converts a normalized RGB color to HSV with hue normalized to 0-1. */
function rgbToHsv(color: types.ColorPathRgb): Hsv {
  const red = clamp01(color.red);
  const green = clamp01(color.green);
  const blue = clamp01(color.blue);
  const max = Math.max(red, green, blue);
  const delta = max - Math.min(red, green, blue);
  let hue = 0;
  if (delta !== 0) {
    if (max === red) hue = mod((green - blue) / delta, 6) / 6;
    else if (max === green) hue = ((blue - red) / delta + 2) / 6;
    else hue = ((red - green) / delta + 4) / 6;
  }
  return { hue, saturation: max === 0 ? 0 : delta / max, value: max };
}

/** Converts HSV with hue normalized to 0-1 back to a normalized RGB color. */
function hsvToRgb(color: Hsv): types.ColorPathRgb {
  const hue = mod1(color.hue) * 6;
  const chroma = color.value * color.saturation;
  const x = chroma * (1 - Math.abs((hue % 2) - 1));
  const m = color.value - chroma;
  const [red, green, blue] =
    hue < 1
      ? [chroma, x, 0]
      : hue < 2
        ? [x, chroma, 0]
        : hue < 3
          ? [0, chroma, x]
          : hue < 4
            ? [0, x, chroma]
            : hue < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  return {
    red: clamp01(red + m),
    green: clamp01(green + m),
    blue: clamp01(blue + m),
  };
}

/** Interpolates normalized hue values along the requested route around the circle. */
function interpolateHue(
  start: number,
  end: number,
  t: number,
  direction: types.HueDirection,
): number {
  const from = mod1(start);
  const to = mod1(end);
  let delta: number;
  if (direction === HueDirection.Clockwise) delta = mod1(to - from);
  else if (direction === HueDirection.CounterClockwise)
    delta = -mod1(from - to);
  else {
    delta = to - from;
    if (delta > 0.5) delta -= 1;
    else if (delta < -0.5) delta += 1;
  }
  return mod1(from + delta * t);
}

/** Interpolates two scalars. */
function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

/** Clamps a scalar to the normalized range. */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Returns the Euclidean remainder of a value by a positive modulus. */
function mod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

/** Wraps a value into the half-open unit interval. */
function mod1(value: number): number {
  return mod(value, 1);
}

/** Normalizes UUID spellings so compact and hyphenated identities compare equally. */
function normalizeUid(uid: string): string {
  return uid.replace(/-/g, "").toLowerCase();
}
