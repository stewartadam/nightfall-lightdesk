// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type * as types from "../../../types";
import {
  ColorInterpolationSpace,
  FxDirection,
  HueDirection,
} from "../../../types";
import {
  addStepFxColorLane,
  blueprintStepFxColor,
  createStepFxColorStep,
  findBlueprint,
  sampleStepFxColorLane,
  stepFxColorFromHex,
  stepFxColorLaneShadows,
  stepFxColorLaneStepIndexAt,
  stepFxColorToHex,
  stepFxLanesReplacedByColor,
} from "./step-fx-color-model";
import { validateStepFxDraft } from "./step-fx-editor-model";

/** Builds a valid draft with one lane per named attribute and no color lane. */
function draft(attributes: string[] = ["Intensity"]): types.StepFx {
  return {
    identifiers: {
      id: 12,
      uid: "11111111111111111111111111111111",
      label: "Colors",
    },
    selection: {
      source: { type: "Fixture", data: { fixture_id: 1 } },
      clauses: [],
    },
    timing: { beat_duration: { secs: 1, nanos: 0 } },
    phase: { waypoints: [0, 1] },
    direction: FxDirection.Forward,
    cycle_scale: { type: "Auto" },
    lanes: attributes.map((name, laneIndex) => ({
      attribute: { type: name } as types.Attribute,
      absolute: {
        steps: [1, 0].map((value, index) => ({
          uid: `${laneIndex + 1}${index + 1}`.repeat(16),
          target: { type: "AbsolutePercent", data: { value } },
          width_beats: 1,
          transition: { start: 0, end: 1 },
          curve: { type: "Snap", data: {} },
        })),
      },
    })),
  };
}

/** Builds a color lane of fading steps in the requested space. */
function colorLane(
  colors: types.ColorPathRgb[],
  space = ColorInterpolationSpace.Rgb,
): types.FxColorLane {
  return {
    interpolation_space: space,
    hue_direction: HueDirection.Shortest,
    steps: colors.map((color) => createStepFxColorStep(color)),
  };
}

/** Builds a Blueprint holding the given inline values. */
function blueprint(
  values: Record<string, types.ParameterValue>,
): types.Blueprint {
  return {
    identifiers: { id: 1, uid: "b".repeat(32), label: "Blueprint" },
    values: Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        { type: "Inline", data: value },
      ]),
    ),
  } as types.Blueprint;
}

/** Builds one single-element fixture exposing the named attributes. */
function fixture(uid: string, attributes: string[]): types.Fixture {
  return {
    identifiers: { id: 1, uid, label: "Fixture" },
    make: "Test",
    model: "Color fixture",
    mode: "Default",
    elements: [
      {
        label: "Main",
        parameters: attributes.map(
          (name) => ({ attribute: { type: name } }) as types.ParameterMetadata,
        ),
      },
    ],
  };
}

/** Verifies hex conversion round-trips normalized 8-bit colors. */
test("stepFxColorToHex and stepFxColorFromHex round-trip", () => {
  const color = { red: 1, green: 0.5019607843137255, blue: 0 };
  assert.equal(stepFxColorToHex(color), "#FF8000");
  assert.deepEqual(stepFxColorFromHex("#FF8000"), color);
});

/** Verifies adding a color lane removes only primary-emitter attribute lanes. */
test("addStepFxColorLane replaces primary emitter lanes", () => {
  const stepFx = draft(["Red", "Green", "Blue", "White", "Intensity"]);
  assert.deepEqual(
    stepFxLanesReplacedByColor(stepFx).map((lane) => lane.attribute.type),
    ["Red", "Green", "Blue"],
  );
  const updated = addStepFxColorLane(stepFx);
  assert.deepEqual(
    updated.lanes.map((lane) => lane.attribute.type),
    ["White", "Intensity"],
  );
  assert.equal(updated.color?.steps.length, 2);
  assert.deepEqual(validateStepFxDraft(updated), []);
});

/** Verifies a color-only draft is valid and out-of-range components are localized. */
test("validateStepFxDraft accepts color-only drafts and flags bad components", () => {
  const stepFx = {
    ...draft([]),
    color: colorLane([
      { red: 1, green: 0, blue: 0 },
      { red: 0, green: 0, blue: 1 },
    ]),
  };
  assert.deepEqual(validateStepFxDraft(stepFx), []);

  stepFx.color.steps[1].color.blue = 2;
  assert.ok(
    validateStepFxDraft(stepFx).some(
      (issue) => issue.path === "color.steps.1.color.blue",
    ),
  );
});

/** Verifies sampling mirrors the engine's wrap-around RGB and hue-routed HSV fades. */
test("sampleStepFxColorLane fades between steps in the lane's space", () => {
  const red = { red: 1, green: 0, blue: 0 };
  const green = { red: 0, green: 1, blue: 0 };
  const rgb = colorLane([red, green]);
  assert.deepEqual(sampleStepFxColorLane(rgb, FxDirection.Forward, 0.75, 0), {
    red: 0.5,
    green: 0.5,
    blue: 0,
  });
  assert.deepEqual(sampleStepFxColorLane(rgb, FxDirection.Forward, 0.25, 0), {
    red: 0.5,
    green: 0.5,
    blue: 0,
  });

  const hsv = colorLane([red, green], ColorInterpolationSpace.Hsv);
  const midpoint = sampleStepFxColorLane(hsv, FxDirection.Forward, 0.75, 0);
  assert.ok(midpoint);
  assert.ok(Math.abs(midpoint.red - 1) < 1e-9);
  assert.ok(Math.abs(midpoint.green - 1) < 1e-9);
  assert.ok(Math.abs(midpoint.blue) < 1e-9);
});

/** Verifies the live step lookup follows widths, start offsets, and reverse playback. */
test("stepFxColorLaneStepIndexAt locates the playing step", () => {
  const lane = colorLane([
    { red: 1, green: 0, blue: 0 },
    { red: 0, green: 1, blue: 0 },
    { red: 0, green: 0, blue: 1 },
  ]);
  lane.steps[0].width_beats = 2;
  assert.equal(
    stepFxColorLaneStepIndexAt(lane, FxDirection.Forward, 0.1, 0),
    0,
  );
  assert.equal(
    stepFxColorLaneStepIndexAt(lane, FxDirection.Forward, 0.6, 0),
    1,
  );
  assert.equal(
    stepFxColorLaneStepIndexAt(lane, FxDirection.Forward, 0.1, 0.5),
    1,
  );
  assert.equal(
    stepFxColorLaneStepIndexAt(lane, FxDirection.Reverse, 0.1, 0),
    2,
  );
  assert.equal(
    stepFxColorLaneStepIndexAt(
      { ...lane, steps: [] },
      FxDirection.Forward,
      0,
      0,
    ),
    undefined,
  );
});

/** Verifies Blueprint colors resolve from RGB, then CMY, and ignore colorless Blueprints. */
test("blueprintStepFxColor reads RGB or CMY values", () => {
  assert.deepEqual(
    blueprintStepFxColor(
      blueprint({
        Red: { type: "AbsolutePercent", data: { value: 1 } },
        Blue: { type: "Absolute", data: { value: 127.5 } },
      }),
    ),
    { red: 1, green: 0, blue: 0.5 },
  );
  assert.deepEqual(
    blueprintStepFxColor(
      blueprint({ Cyan: { type: "AbsolutePercent", data: { value: 1 } } }),
    ),
    { red: 0, green: 1, blue: 1 },
  );
  assert.equal(
    blueprintStepFxColor(
      blueprint({ Intensity: { type: "AbsolutePercent", data: { value: 1 } } }),
    ),
    undefined,
  );
});

/** Verifies Blueprint references resolve from hyphenated spellings and miss unknown uids. */
test("findBlueprint resolves hyphenated UUID references", () => {
  const green = blueprint({
    Green: { type: "AbsolutePercent", data: { value: 1 } },
  });
  const blueprints = { [green.identifiers.uid]: green };
  assert.equal(
    findBlueprint(blueprints, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
    green,
  );
  assert.equal(findBlueprint(blueprints, "c".repeat(32)), undefined);
});

/** Verifies shadowing counts only elements whose color emitters the color lane owns. */
test("stepFxColorLaneShadows reports per-element color ownership", () => {
  const stepFx = {
    ...draft(["White", "Red"]),
    color: colorLane([
      { red: 1, green: 0, blue: 0 },
      { red: 0, green: 0, blue: 1 },
    ]),
  };
  const rgbw = fixture("1".repeat(32), ["Red", "Green", "Blue", "White"]);
  const strip = fixture("2".repeat(32), ["White"]);
  const shadows = stepFxColorLaneShadows(
    stepFx,
    [rgbw, strip],
    [
      { fixture_uid: rgbw.identifiers.uid },
      { fixture_uid: strip.identifiers.uid },
    ],
  );
  assert.deepEqual(shadows.get("White"), { total: 2, shadowed: 1 });
  assert.deepEqual(shadows.get("Red"), { total: 1, shadowed: 1 });
});
