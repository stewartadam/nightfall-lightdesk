// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type OpticalChannel,
  type OpticalDmxProfile,
  type OpticalModeCondition,
  PhysicalUnit,
} from "../../../../types";
import {
  createOpticalChannelState,
  evaluateOpticalChannel,
} from "./optical-channel";

/** Unitless, linear and ungated source function defaults. */
const PLAIN = {
  physicalUnit: PhysicalUnit.None,
  profile: { type: "Linear" },
  modeMaster: { type: "None" },
} as const;

const channel: OpticalChannel = {
  parameterKey: "Gobo",
  geometry: "Head",
  attribute: "Gobo1",
  dmxMax: 65535,
  functions: [
    {
      ...PLAIN,
      attribute: "Gobo1",
      dmxFrom: 0,
      dmxTo: 32895,
      physicalFrom: 1,
      physicalTo: 2,
      wheel: "Gobos",
      sets: [
        {
          dmxFrom: 0,
          dmxTo: 16447,
          physicalFrom: 1,
          physicalTo: 1,
          wheelSlot: 1,
        },
        {
          dmxFrom: 16448,
          dmxTo: 32895,
          physicalFrom: 2,
          physicalTo: 2,
          wheelSlot: 2,
        },
      ],
    },
    {
      ...PLAIN,
      attribute: "Gobo1PosRotate",
      dmxFrom: 32896,
      dmxTo: 65535,
      physicalFrom: 60,
      physicalTo: -60,
      sets: [],
    },
  ],
};

/** Overlapping functions follow the master channel, preserving inclusive coarse/fine boundaries. */
test("mode masters select indexed or rotating optics and clear inactive output", () => {
  const rotateConditions: OpticalModeCondition[] = [
    {
      geometry: "Base",
      parameterKey: "Control",
      dmxMax: 65535,
      dmxFrom: 32896,
      dmxTo: 65535,
    },
  ];
  const conditional: OpticalChannel = {
    ...channel,
    dmxMax: 255,
    functions: [
      {
        ...PLAIN,
        attribute: "Gobo1Pos",
        dmxFrom: 0,
        dmxTo: 255,
        physicalFrom: 0,
        physicalTo: 360,
        sets: [],
        modeMaster: {
          type: "Resolved",
          data: [
            {
              geometry: "Base",
              parameterKey: "Control",
              dmxMax: 65535,
              dmxFrom: 0,
              dmxTo: 32895,
            },
          ],
        },
      },
      {
        ...PLAIN,
        attribute: "Gobo1PosRotate",
        dmxFrom: 0,
        dmxTo: 255,
        physicalFrom: -180,
        physicalTo: 180,
        sets: [],
        modeMaster: { type: "Resolved", data: rotateConditions },
      },
    ],
  };
  const state = createOpticalChannelState();
  const values: { Control: number | undefined } = { Control: 32895 / 65535 };
  const masters = new Map<string, object>([["Base", values]]);
  evaluateOpticalChannel(conditional, 1, state, masters);
  assert.equal(state.status, "resolved");
  assert.equal(state.function?.attribute, "Gobo1Pos");
  assert.equal(state.physical, 360);
  values.Control = 32896 / 65535;
  evaluateOpticalChannel(conditional, 1, state, masters);
  assert.equal(state.function?.attribute, "Gobo1PosRotate");
  assert.equal(state.physical, 180);
  for (const missing of [undefined, NaN]) {
    values.Control = missing;
    evaluateOpticalChannel(conditional, 1, state, masters);
    assert.equal(state.status, "requires-mode-master");
    assert.equal(state.physical, undefined);
  }
  values.Control = 1;
  rotateConditions.push({
    geometry: "Head",
    parameterKey: "Gobo",
    dmxMax: 255,
    dmxFrom: 20,
    dmxTo: 99,
  });
  masters.set("Head", { Gobo: 100 / 255 });
  evaluateOpticalChannel(conditional, 1, state, masters);
  assert.equal(state.status, "inactive");
  assert.equal(state.physical, undefined);
  masters.set("Head", { Gobo: 99 / 255 });
  evaluateOpticalChannel(conditional, 1, state, masters);
  assert.equal(state.status, "resolved");
  assert.equal(state.physical, 180);
});

/** GDTF profile polynomials use percentage offsets within each segment. */
test("optical profiles evaluate piecewise curves over the function range", () => {
  const curve: OpticalDmxProfile = {
    min: 2,
    max: 10,
    points: [
      { dmxPercentage: 0, coefficients: [0, 0, 0.02, 0] },
      { dmxPercentage: 50, coefficients: [50, 2, -0.02, 0] },
    ],
  };
  const profiled: OpticalChannel = {
    ...channel,
    dmxMax: 1000,
    functions: [
      {
        ...PLAIN,
        attribute: "Focus1Distance",
        physicalUnit: PhysicalUnit.Length,
        dmxFrom: 200,
        dmxTo: 1000,
        physicalFrom: 0,
        physicalTo: 1,
        profile: { type: "Curve", data: curve },
        sets: [
          {
            dmxFrom: 200,
            dmxTo: 600,
            physicalFrom: 99,
            physicalTo: 99,
            wheelSlot: 2,
          },
        ],
      },
    ],
  };
  const state = createOpticalChannelState();
  for (const [dmx, expected] of [
    [200, 2],
    [400, 3],
    [600, 6],
    [800, 9],
    [1000, 10],
  ]) {
    evaluateOpticalChannel(profiled, dmx / 1000, state);
    assert.equal(state.status, "resolved");
    assert.equal(state.physical, expected);
    assert.equal(state.wheelSlot, dmx <= 600 ? 2 : undefined);
  }
  curve.points = [{ dmxPercentage: 50, coefficients: [200, 0, 0, 0] }];
  evaluateOpticalChannel(profiled, 0.4, state);
  assert.equal(state.physical, 2);
  evaluateOpticalChannel(profiled, 0.6, state);
  assert.equal(state.physical, 10);
  curve.points[0].coefficients[0] = NaN;
  evaluateOpticalChannel(profiled, 0.6, state);
  assert.equal(state.status, "requires-profile");
  assert.equal(state.physical, undefined);
});

/** Fine-resolution boundary values select adjacent slots and clear selection when entering rotation. */
test("optical channels resolve exact slot and function boundaries", () => {
  const state = createOpticalChannelState();
  evaluateOpticalChannel(channel, 16447 / 65535, state);
  assert.equal(state.wheelSlot, 1);
  evaluateOpticalChannel(channel, 16448 / 65535, state);
  assert.equal(state.wheelSlot, 2);
  evaluateOpticalChannel(channel, 32895 / 65535, state);
  assert.equal(state.wheelSlot, 2);
  evaluateOpticalChannel(channel, 32896 / 65535, state);
  assert.equal(state.function?.attribute, "Gobo1PosRotate");
  assert.equal(state.wheelSlot, undefined);
  assert.equal(state.wheel, undefined);
  assert.equal(state.physical, 60);
  evaluateOpticalChannel(channel, 1, state);
  assert.equal(state.physical, -60);
  evaluateOpticalChannel(channel, undefined, state);
  assert.equal(state.status, "inactive");
  assert.equal(state.physical, undefined);
});

/** Unsupported transfer curves and mode masters cannot silently become linear optical effects. */
test("optical channels explicitly report unresolved source semantics", () => {
  const state = createOpticalChannelState();
  evaluateOpticalChannel(
    {
      ...channel,
      functions: [{ ...channel.functions[0], profile: { type: "Unresolved" } }],
    },
    0.1,
    state,
  );
  assert.equal(state.status, "requires-profile");
  assert.equal(state.physical, undefined);
  evaluateOpticalChannel(
    {
      ...channel,
      functions: [
        { ...channel.functions[0], modeMaster: { type: "Unresolved" } },
      ],
    },
    0.1,
    state,
  );
  assert.equal(state.status, "requires-mode-master");
  assert.equal(state.wheelSlot, undefined);
  evaluateOpticalChannel(channel, NaN, state);
  assert.equal(state.status, "inactive");
});
