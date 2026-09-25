// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Tests for evaluating GDTF mode masters, relations, profiles and channel sets. */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type Attribute,
  type DmxSlots,
  DmxValueResolution,
  type FixtureElement,
  MergeStrategy,
  type ParameterFunction,
  type ParameterMetadata,
  ParameterValuePolarity,
  RelationKind,
} from "../../../types";
import {
  evaluateElementChannels,
  evaluateFixtureChannels,
  evaluateProfile,
} from "./channel-evaluation";
import { extractFixtureDmxData, resetDmxPool } from "./visualizer-dmx";

/** Builds 8-bit parameter metadata with optional profile functions and slots. */
function parameter(
  attribute: Attribute,
  functions?: ParameterFunction[],
  dmx_slots?: DmxSlots,
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
    dmx_slots,
  };
}

/** Builds a function over a DMX range with a 0-1 physical scale. */
function fn(
  name: string,
  dmx_from: number,
  dmx_to: number,
  extra: Partial<ParameterFunction> = {},
): ParameterFunction {
  return {
    name,
    attribute: name,
    dmx_from,
    dmx_to,
    physical_from: 0,
    physical_to: 1,
    ...extra,
  };
}

/** Asserts a value lies within a tolerance of the expected value. */
function near(
  actual: number | undefined,
  expected: number,
  message: string,
  tolerance = 0.01,
) {
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) < tolerance,
    `${message}: expected ${expected}, got ${actual}`,
  );
}

const control: Attribute = { type: "Custom", data: { label: "Control" } };

/** Builds a pixel bar: a body dimmer with `slots` and one red pixel following it. */
function pixelBar(slots: DmxSlots, kind: RelationKind): FixtureElement[] {
  return [
    {
      label: "Body",
      parameters: [
        parameter({ type: "Intensity" }, [fn("Dimmer", 0, 255)], slots),
      ],
    },
    {
      label: "Pixel",
      parameters: [
        parameter({ type: "Red" }, [
          fn("ColorAdd_R", 0, 255, {
            relations: [
              {
                master: { element: 0, attribute: { type: "Intensity" } },
                kind,
              },
            ],
          }),
        ]),
      ],
    },
  ];
}

/** Verifies a mode master in another element selects between overlapping functions. */
test("mode masters select overlapping functions across elements", () => {
  const elements: FixtureElement[] = [
    { label: "Base", parameters: [parameter(control)] },
    {
      label: "Head",
      parameters: [
        parameter({ type: "StrobeShutter" }, [
          fn("Shutter1", 0, 255, {
            mode_master: {
              master: { element: 0, attribute: control },
              dmx_from: 0,
              dmx_to: 127,
            },
          }),
          fn("Shutter1Strobe", 0, 255, {
            mode_master: {
              master: { element: 0, attribute: control },
              dmx_from: 128,
              dmx_to: 255,
            },
          }),
        ]),
      ],
    },
  ];
  const shutter = (controlValue: number) =>
    evaluateFixtureChannels(elements, [
      { Control: controlValue },
      { StrobeShutter: 200 },
    ])[1][0]?.function?.name;
  assert.equal(shutter(10), "Shutter1");
  assert.equal(shutter(200), "Shutter1Strobe");
});

/** Verifies relations with real masters scale or replace the follower level. */
test("physical relation masters scale or replace follower levels", () => {
  const slots: DmxSlots = {
    type: "Explicit",
    data: { dmx_break: 1, offsets: [1] },
  };
  const red = (kind: RelationKind) =>
    evaluateFixtureChannels(pixelBar(slots, kind), [
      { Intensity: 127.5 },
      { Red: 255 },
    ])[1][0]?.level;
  near(red(RelationKind.Multiply), 0.5, "multiply");
  near(red(RelationKind.Override), 0.5, "override");
  const dim = evaluateFixtureChannels(pixelBar(slots, RelationKind.Override), [
    { Intensity: 51 },
    { Red: 0 },
  ])[1][0]?.level;
  near(dim, 0.2, "override ignores follower level");
});

/** Verifies virtual masters are left to the console, which already applied them. */
test("virtual relation masters are not applied again", () => {
  const level = evaluateFixtureChannels(
    pixelBar({ type: "Virtual" }, RelationKind.Multiply),
    [{ Intensity: 0 }, { Red: 255 }],
  )[1][0]?.level;
  near(level, 1, "console-scaled follower");
});

/** Verifies a pixel following a body dimmer is lit by its own color, not dimmed twice. */
test("relation followers do not inherit the fixture-level dimmer", () => {
  resetDmxPool();
  const slots: DmxSlots = {
    type: "Explicit",
    data: { dmx_break: 1, offsets: [1] },
  };
  const [, [, pixel]] = extractFixtureDmxData(
    pixelBar(slots, RelationKind.Multiply),
    [{ Intensity: 127.5 }, { Red: 255 }],
  );
  near(pixel.intensity, 0.5, "pixel intensity from relation");
  near(pixel.red, 1, "pixel color normalized");
});

/**
 * Verifies the Pixel Line layout: pixels follow their own virtual dimmer
 * (already applied by the console), while a body dimmer no relation names
 * still masters the whole fixture.
 */
test("unlinked body dimmers master pixels whose own dimmers are virtual", () => {
  resetDmxPool();
  const elements: FixtureElement[] = [
    {
      label: "Body",
      parameters: [parameter({ type: "Intensity" }, [fn("Dimmer", 0, 255)])],
    },
    {
      label: "Pixel",
      parameters: [
        parameter({ type: "Red" }, [
          fn("ColorRGB_Red", 0, 255, {
            relations: [
              {
                master: { element: 1, attribute: { type: "Intensity" } },
                kind: RelationKind.Multiply,
              },
            ],
          }),
        ]),
        parameter({ type: "Intensity" }, [fn("Dimmer", 0, 255)], {
          type: "Virtual",
        }),
      ],
    },
  ];
  // The console already scaled red by the pixel dimmer (255 × 0.4 = 102).
  const [, [, pixel]] = extractFixtureDmxData(elements, [
    { Intensity: 127.5 },
    { Red: 102, Intensity: 102 },
  ]);
  near(pixel.red, 1, "pixel hue");
  near(pixel.intensity, 0.4 * 0.5, "pixel dimmer and body dimmer");
});

/** Verifies relation levels resolve through a chain of physical masters. */
test("physical relation chains compose", () => {
  const slots: DmxSlots = {
    type: "Explicit",
    data: { dmx_break: 1, offsets: [1] },
  };
  const follow = (element: number) => ({
    relations: [
      {
        master: { element, attribute: { type: "Intensity" } as Attribute },
        kind: RelationKind.Multiply,
      },
    ],
  });
  const elements: FixtureElement[] = [
    {
      label: "Group",
      parameters: [parameter({ type: "Intensity" }, [fn("D", 0, 255)], slots)],
    },
    {
      label: "Cell",
      parameters: [
        parameter({ type: "Intensity" }, [fn("D", 0, 255, follow(0))], slots),
      ],
    },
    {
      label: "Pixel",
      parameters: [parameter({ type: "Red" }, [fn("R", 0, 255, follow(1))])],
    },
  ];
  const channels = evaluateFixtureChannels(elements, [
    { Intensity: 127.5 },
    { Intensity: 127.5 },
    { Red: 255 },
  ]);
  near(channels[2][0]?.level, 0.25, "red × cell × group");
});

/** Verifies elements without a dimmer take brightness from their color once. */
test("derived intensity rescales colors instead of squaring brightness", () => {
  resetDmxPool();
  const elements: FixtureElement[] = [
    { label: "Pixel", parameters: [parameter({ type: "Red" })] },
  ];
  const [[, pixel]] = extractFixtureDmxData(elements, [{ Red: 127.5 }]);
  near(pixel.intensity, 0.5, "intensity");
  near(pixel.red, 1, "red");
});

/** Verifies DMX profiles shape a function's physical value and sets override its range. */
test("profiles and channel sets map DMX to physical values", () => {
  const element: FixtureElement = {
    label: "Head",
    parameters: [
      parameter({ type: "Zoom" }, [
        fn("Zoom", 0, 255, {
          physical_from: 10,
          physical_to: 50,
          profile: [{ dmx_percent: 0, cfc0: 0, cfc1: 0, cfc2: 0.01, cfc3: 0 }],
          sets: [
            {
              name: "Narrow",
              dmx_from: 250,
              dmx_to: 255,
              physical_from: 4,
              physical_to: 5,
            },
          ],
        }),
      ]),
    ],
  };
  const half = evaluateElementChannels(element, { Zoom: 127.5 })[0];
  near(half?.fraction, 0.25, "squared profile at half DMX");
  // DMX 128 of 255 sits just past half-way.
  near(half?.physical, 20, "physical from profiled fraction", 0.1);
  const narrow = evaluateElementChannels(element, { Zoom: 255 })[0];
  near(narrow?.physical, 5, "set physical range");
  near(evaluateProfile([], 40), 40, "empty profile is linear");
});

/** Verifies signed parameters convert to DMX around their centre like the engine. */
test("signed outputs convert to DMX around the logical centre", () => {
  const pan: ParameterMetadata = {
    ...parameter({ type: "Pan" }),
    value_polarity: ParameterValuePolarity.Signed,
  };
  const element: FixtureElement = { label: "Head", parameters: [pan] };
  assert.equal(evaluateElementChannels(element, { Pan: 0 })[0]?.dmx, 128);
  assert.equal(evaluateElementChannels(element, { Pan: -127.5 })[0]?.dmx, 0);
});
