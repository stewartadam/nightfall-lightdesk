// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { normalizeAttributeName } from "../../../lib/utils";
import type * as types from "../../../types";

const COLOR_ATTRIBUTES = new Set([
  "Red",
  "Green",
  "Blue",
  "Cyan",
  "Magenta",
  "Yellow",
  "White",
  "WarmWhite",
  "CoolWhite",
  "Amber",
  "UV",
]);

/** Identifies emitter lanes that conflict with whole-color ownership. */
export function isStepFxColorAttribute(name: string): boolean {
  return COLOR_ATTRIBUTES.has(normalizeAttributeName(name));
}

/** Creates two ready-to-edit colors with a smooth transition across each step. */
export function createStepFxColorLane(): types.FxColorLane {
  return {
    steps: [
      { red: 1, green: 0, blue: 0 },
      { red: 0, green: 0, blue: 1 },
    ].map((target) => ({
      uid: crypto.randomUUID(),
      target,
      width_beats: 1,
      transition: { start: 0, end: 1 },
      curve: { type: "Linear", data: {} },
    })),
  };
}

/** Reads complete normalized RGB values from a Blueprint without dropping its reference. */
export function stepFxBlueprintColor(
  blueprint: types.Blueprint,
): types.ColorPathRgb | undefined {
  const components = ["Red", "Green", "Blue"].map((attribute) => {
    const source = Object.entries(blueprint.values).find(
      ([key]) => normalizeAttributeName(key) === attribute,
    )?.[1];
    return source?.type === "Inline" && source.data.type === "AbsolutePercent"
      ? source.data.data.value
      : undefined;
  });
  if (
    components.some(
      (value) =>
        value === undefined ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 1,
    )
  )
    return undefined;
  return { red: components[0]!, green: components[1]!, blue: components[2]! };
}

/** Resolves the displayed color from a live Blueprint, with the saved target as fallback. */
export function resolvedStepFxColor(
  step: types.FxColorStep,
  blueprints: types.Blueprint[],
): types.ColorPathRgb {
  const blueprint = step.blueprint_uid
    ? blueprints.find(
        (item) =>
          item.identifiers.uid.replace(/-/g, "") ===
          step.blueprint_uid!.replace(/-/g, ""),
      )
    : undefined;
  return (blueprint && stepFxBlueprintColor(blueprint)) || step.target;
}

/** Projects one color component into the existing scalar timing and waveform utilities. */
export function stepFxColorComponentTrack(
  lane: types.FxColorLane,
  component: keyof types.ColorPathRgb = "red",
  blueprints: types.Blueprint[] = [],
): types.FxTrack {
  return {
    steps: lane.steps.map((step) => ({
      ...step,
      target: {
        type: "AbsolutePercent",
        data: { value: resolvedStepFxColor(step, blueprints)[component] },
      },
    })),
  };
}

/** Formats normalized RGB values for swatches and the existing color picker. */
export function stepFxColorCss(color: types.ColorPathRgb): string {
  return `rgb(${color.red * 255} ${color.green * 255} ${color.blue * 255})`;
}
