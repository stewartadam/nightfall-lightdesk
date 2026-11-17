// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as types from "../../../types";
import {
  addressLabel,
  attributeSuggestions,
  channelFunctions,
  hasErrors,
  hexToSlotColor,
  maxDmxValue,
  nextName,
  nextRangeStart,
  problemLocation,
  renamedInfo,
  slotFields,
  slotFieldsWithout,
  slotHex,
} from "./draft-editing";

/** Builds a function at a DMX start, with no named ranges. */
function fn(name: string, dmxFrom: number): types.DraftFunction {
  return {
    name,
    attribute: "Dimmer",
    dmx_from: dmxFrom,
    default: dmxFrom,
    physical_from: 0,
    physical_to: 1,
    sets: [],
  };
}

/** Builds a draft view with one mode holding the given channel names. */
function draft(
  channels: string[],
  problems: types.DraftProblem[] = [],
): types.FixtureDraftView {
  return {
    draft_id: 1,
    origin: { type: "Blank" },
    dirty: false,
    version: 0,
    can_undo: false,
    can_redo: false,
    info: {
      name: "Test",
      short_name: "",
      long_name: "",
      manufacturer: "Acme",
      description: "",
    },
    modes: [
      {
        name: "Default",
        geometry: "Body",
        footprint: channels.length,
        channels: channels.map((name, index) => ({
          name,
          geometry: "Body",
          offset: [index + 1],
          resolution: 1,
          logical_channels: [],
        })),
      },
    ],
    wheels: [],
    attributes: [],
    geometries: [],
    problems,
    lost_content: [],
  };
}

/** A wheel with a red slot, a gobo image slot and a blue slot. */
const wheel: types.DraftWheel = {
  name: "Colors",
  slots: [
    { name: "Red", color: [0.64, 0.33, 21] },
    { name: "Gobo", media: "gobo.png" },
    { name: "Blue", color: [0.15, 0.06, 7] },
  ],
};

/** Value bounds and address labels follow the channel's byte count. */
test("labels resolutions and addresses", () => {
  assert.equal(maxDmxValue(1), 255);
  assert.equal(maxDmxValue(2), 65535);
  assert.equal(addressLabel([]), "Virtual");
  assert.equal(addressLabel([3]), "3");
  assert.equal(addressLabel([4, 3]), "3–4");
});

/** Function indices run across logical channels, matching what edits address. */
test("numbers functions across logical channels", () => {
  const channel: types.DraftChannel = {
    name: "Shutter",
    geometry: "Body",
    offset: [1],
    resolution: 1,
    logical_channels: [
      { attribute: "Shutter1", snap: false, functions: [fn("Closed", 0)] },
      {
        attribute: "Shutter1Strobe",
        snap: false,
        functions: [fn("Strobe", 64), fn("Pulse", 128)],
      },
    ],
  };
  assert.deepEqual(
    channelFunctions(channel).map((item) => [item.index, item.function.name]),
    [
      [0, "Closed"],
      [1, "Strobe"],
      [2, "Pulse"],
    ],
  );
});

/** A new range goes halfway into the free space, and none fits once the end is taken. */
test("places new ranges after the last one", () => {
  assert.equal(nextRangeStart([], 10, 255), 10);
  assert.equal(nextRangeStart([0], 0, 255), 128);
  assert.equal(nextRangeStart([0, 254], 0, 255), 255);
  assert.equal(nextRangeStart([255], 0, 255), undefined);
});

/** Only a changed slot sends a color, so other slots keep theirs. */
test("builds slot edits that keep untouched colors", () => {
  assert.deepEqual(slotFields(wheel, { index: 2, color: [0.3, 0.3, 50] }), [
    { name: "Red", from: 0, color: undefined },
    { name: "Gobo", from: 1, color: undefined },
    { name: "Blue", from: 2, color: [0.3, 0.3, 50] },
  ]);
});

/** Removing a slot keeps each remaining slot pointed at its own optics, so none takes its neighbor's. */
test("removes a slot without shifting colors", () => {
  assert.deepEqual(slotFieldsWithout(wheel, 0), [
    { name: "Gobo", from: 1, color: undefined },
    { name: "Blue", from: 2, color: undefined },
  ]);
});

/** A picked color round-trips through CIE and keeps the slot's luminance. */
test("converts swatch colors to slot colors", () => {
  const [x, y, luminance] = hexToSlotColor("#ff0000", [0.3, 0.3, 21]);
  assert.equal(luminance, 21);
  assert.equal(slotHex([x, y, luminance]), "#ff0000");
  assert.equal(hexToSlotColor("#ffffff")[2], 100);
  assert.equal(slotHex(undefined), undefined);
});

/** The catalog comes first, then the fixture's own attributes, each once. */
test("suggests catalog and fixture attributes", () => {
  const catalog = [{ name: "Dimmer", pretty: "Dim", group: "Dimmer" }];
  assert.deepEqual(
    attributeSuggestions(catalog, ["Dimmer", "Custom", "Custom"]).map(
      (option) => option.name,
    ),
    ["Dimmer", "Custom"],
  );
});

/** Problems name their mode and channel, falling back to positions for stale ones. */
test("locates problems", () => {
  const view = draft(["Dimmer"]);
  const problem = (mode?: number, channel?: number): types.DraftProblem => ({
    severity: types.ProblemSeverity.Warning,
    message: "",
    mode,
    channel,
  });
  assert.equal(problemLocation(view, problem()), undefined);
  assert.equal(problemLocation(view, problem(0)), "Default");
  assert.equal(problemLocation(view, problem(0, 0)), "Default › Dimmer");
  assert.equal(problemLocation(view, problem(0, 5)), "Default › Channel 6");
});

/** Only error-level problems block saving. */
test("detects blocking problems", () => {
  const problem = (severity: types.ProblemSeverity): types.DraftProblem => ({
    severity,
    message: "",
  });
  assert.equal(
    hasErrors(draft([], [problem(types.ProblemSeverity.Warning)])),
    false,
  );
  assert.equal(
    hasErrors(draft([], [problem(types.ProblemSeverity.Error)])),
    true,
  );
});

/** New names skip ones already taken. */
test("picks unused names", () => {
  assert.equal(nextName("Mode", ["Default"]), "Mode 2");
  assert.equal(nextName("Mode", ["Default", "Mode 2"]), "Mode 3");
});

/** A rename carries along short and long names the user never set apart. */
test("keeps unset names linked on rename", () => {
  const info = {
    name: "Dimmer",
    short_name: "Dimmer",
    long_name: "Acme Dimmer 2000",
    manufacturer: "Acme",
    description: "",
  };
  assert.deepEqual(renamedInfo(info, "Par"), {
    ...info,
    name: "Par",
    short_name: "Par",
  });
  assert.equal(renamedInfo({ ...info, long_name: "" }, "Par").long_name, "Par");
});
