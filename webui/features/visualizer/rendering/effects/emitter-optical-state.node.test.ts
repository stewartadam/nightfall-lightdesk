// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Mesh } from "three/webgpu";
import { EmitterOpticalState } from "./emitter-optical-state";

/** Ancestor zoom follows physical profiles and resets when its multifunction channel changes. */
test("inherited zoom evaluates percentage profiles and clears inactive functions", () => {
  const state = new EmitterOpticalState(
    {
      mesh: new Mesh(),
      controlledElement: "Lens",
      opticalChannels: [
        {
          geometry: "Head",
          attribute: "Zoom",
          parameterKey: "Control",
          dmxMax: 1000,
          functions: [
            {
              attribute: "Zoom",
              physicalUnit: "Angle",
              dmxFrom: 0,
              dmxTo: 800,
              physicalFrom: 5,
              physicalTo: 45,
              dmxProfile: "Linear",
              profileCurve: {
                min: 5,
                max: 45,
                points: [{ dmxPercentage: 0, coefficients: [0, 1, 0, 0] }],
              },
              sets: [],
            },
            {
              attribute: "NoFeature",
              dmxFrom: 801,
              dmxTo: 1000,
              physicalFrom: 0,
              physicalTo: 0,
              sets: [],
            },
          ],
        },
      ],
    },
    () => {
      throw new Error("Zoom must not load media");
    },
  );
  const values = {
    red: 1,
    green: 1,
    blue: 1,
    intensity: 1,
    "optical:Control": 0.4,
  };
  state.update(new Map([["Head", values]]));
  assert.equal(state.zoomDegrees, 25);
  values["optical:Control"] = 0.8;
  state.update(new Map([["Head", values]]));
  assert.equal(state.zoomDegrees, 45);
  values["optical:Control"] = 0.9;
  state.update(new Map([["Head", values]]));
  assert.equal(state.zoomDegrees, undefined);
  state.update(new Map());
  assert.equal(state.zoomDegrees, undefined);
});

/** Independent wheels retain both masks and rotations without allocating new stage records during playback. */
test("gobo stages preserve separate wheel selection and rotation", () => {
  let slot = 0;
  const state = new EmitterOpticalState(
    {
      mesh: new Mesh(),
      controlledElement: "Head",
      gdtfPath: "fixture.gdtf",
      opticalWheels: [1, 2].map((i) => ({
        name: `Wheel${i}`,
        slots: [{ mediaName: `mask${i}`, facets: [] }],
      })),
      opticalChannels: [1, 2].flatMap((i) => [
        {
          geometry: "Head",
          attribute: `Gobo${i}`,
          parameterKey: `Gobo${i}`,
          dmxMax: 255,
          functions: [
            {
              attribute: `Gobo${i}`,
              wheel: `Wheel${i}`,
              dmxFrom: 0,
              dmxTo: 255,
              physicalFrom: 0,
              physicalTo: 1,
              sets: [
                {
                  dmxFrom: 0,
                  dmxTo: 255,
                  physicalFrom: 0,
                  physicalTo: 1,
                  wheelSlot: 1,
                },
              ],
            },
          ],
        },
        {
          geometry: "Head",
          attribute: `Gobo${i}Pos`,
          parameterKey: `Gobo${i}Pos`,
          dmxMax: 255,
          functions: [
            {
              attribute: `Gobo${i}Pos`,
              dmxFrom: 0,
              dmxTo: 255,
              physicalFrom: 0,
              physicalTo: 180,
              sets: [],
            },
          ],
        },
      ]),
    },
    () => ({ index: ++slot, status: "ready" }),
  );
  const stages = [...state.gobos];
  state.update(
    new Map([
      [
        "Head",
        {
          red: 1,
          green: 1,
          blue: 1,
          intensity: 1,
          "optical:Gobo1": 1,
          "optical:Gobo2": 1,
          "optical:Gobo1Pos": 0,
          "optical:Gobo2Pos": 1,
        },
      ],
    ]),
  );
  assert.deepEqual(state.gobos, [
    { slot: 1, rotation: 0 },
    { slot: 2, rotation: Math.PI },
  ]);
  state.update(new Map());
  assert.deepEqual(state.gobos, [
    { slot: 0, rotation: 0 },
    { slot: 0, rotation: 0 },
  ]);
  assert.equal(state.gobos[0], stages[0]);
  assert.equal(state.gobos[1], stages[1]);
});

/** A fixture's potential split must not warn until DMX activates enough facets to exceed its budget. */
test("prism reduction follows active DMX combinations", () => {
  const state = new EmitterOpticalState(
    {
      mesh: new Mesh(),
      controlledElement: "Head",
      opticalWheels: [
        {
          name: "Split",
          slots: [
            { facets: [] },
            {
              facets: Array.from({ length: 33 }, (_, x) => ({
                transform: [1, 0, 0, 0, 1, 0, x, 0, 1],
                colorCie: [0.3127, 0.329, 100],
              })),
            },
          ],
        },
      ],
      opticalChannels: [1, 2].map((i) => ({
        geometry: "Head",
        attribute: `Prism${i}`,
        parameterKey: `Prism${i}`,
        dmxMax: 255,
        functions: [
          {
            attribute: `Prism${i}`,
            wheel: "Split",
            dmxFrom: 0,
            dmxTo: 255,
            physicalFrom: 0,
            physicalTo: 1,
            sets: [
              {
                dmxFrom: 0,
                dmxTo: 127,
                physicalFrom: 0,
                physicalTo: 0,
                wheelSlot: 1,
              },
              {
                dmxFrom: 128,
                dmxTo: 255,
                physicalFrom: 1,
                physicalTo: 1,
                wheelSlot: 2,
              },
            ],
          },
        ],
      })),
    },
    () => {
      throw new Error("Prisms must not load media");
    },
  );
  const values = {
    red: 1,
    green: 1,
    blue: 1,
    intensity: 1,
    "optical:Prism1": 1,
    "optical:Prism2": 0,
  };
  const colors = new Map([["Head", values]]);
  assert.equal(state.prismCapacityExceeded, true);
  assert.equal(state.maxFacetCount, 1024);
  state.update(colors);
  assert.equal(state.prismReduced, false);
  assert.equal(state.prism?.length, 33);
  values["optical:Prism2"] = 1;
  state.update(colors);
  assert.equal(state.prismReduced, true);
  assert.equal(state.prism?.length, 1024);
  colors.clear();
  state.update(colors);
  assert.equal(state.prismReduced, false);
  assert.equal(state.prism, undefined);
});

/** Independent DMX selectors combine their prism facets and return to one stage or open without rebuilding. */
test("two active prism wheels compose instead of overwriting", () => {
  const state = new EmitterOpticalState(
    {
      mesh: new Mesh(),
      controlledElement: "Head",
      opticalWheels: [2, 3].map((count, index) => ({
        name: `Wheel${index}`,
        slots: [
          { facets: [] },
          {
            facets: Array.from({ length: count }, (_, i) => ({
              transform: [
                1,
                0,
                0,
                0,
                1,
                0,
                index === 0 ? i : 0,
                index === 1 ? i : 0,
                1,
              ],
              colorCie: [0.3127, 0.329, 100],
            })),
          },
        ],
      })),
      opticalChannels: [0, 1].map((i) => ({
        geometry: "Head",
        attribute: `Prism${i + 1}`,
        parameterKey: `Prism${i + 1}`,
        dmxMax: 255,
        functions: [
          {
            attribute: `Prism${i + 1}`,
            wheel: `Wheel${i}`,
            dmxFrom: 0,
            dmxTo: 255,
            physicalFrom: 0,
            physicalTo: 1,
            sets: [
              {
                dmxFrom: 0,
                dmxTo: 127,
                physicalFrom: 0,
                physicalTo: 0,
                wheelSlot: 1,
              },
              {
                dmxFrom: 128,
                dmxTo: 255,
                physicalFrom: 1,
                physicalTo: 1,
                wheelSlot: 2,
              },
            ],
          },
        ],
      })),
    },
    () => {
      throw new Error("Prisms must not load images");
    },
  );
  const values = {
    red: 1,
    green: 1,
    blue: 1,
    intensity: 1,
    "optical:Prism1": 1,
    "optical:Prism2": 1,
  };
  const colors = new Map([["Head", values]]);
  assert.equal(state.maxFacetCount, 6);
  state.update(colors);
  assert.deepEqual(
    state.prism?.map(({ x, y }) => [x, y]),
    [
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
      [1, 1],
      [1, 2],
    ],
  );
  const result = state.prism;
  values["optical:Prism2"] = 0;
  state.update(colors);
  assert.equal(state.prism?.length, 2);
  values["optical:Prism2"] = 1;
  state.update(colors);
  assert.equal(state.prism, result);
  assert.equal(state.prism?.length, 6);
  colors.clear();
  state.update(colors);
  assert.equal(state.prism, undefined);
});

/** Switching control channels preserves the same wheel's indexed orientation and isolates other wheels. */
test("separate index and speed channels share only their wheel rotation", () => {
  for (const family of ["Gobo", "Prism"]) {
    const state = new EmitterOpticalState(
      {
        mesh: new Mesh(),
        controlledElement: "Head",
        opticalChannels: ["1Pos", "2Pos", "1PosRotate"].map((suffix) => ({
          geometry: "Head",
          attribute: `${family}${suffix}`,
          parameterKey: suffix,
          dmxMax: 255,
          functions: [
            {
              attribute: `${family}${suffix}`,
              dmxFrom: 0,
              dmxTo: 255,
              physicalFrom: suffix === "2Pos" ? 180 : 90,
              physicalTo: suffix === "2Pos" ? 180 : 90,
              sets: [],
            },
          ],
        })),
      },
      () => {
        throw new Error("Rotation must not request media");
      },
    );
    const values: Record<string, number> & {
      red: number;
      green: number;
      blue: number;
      intensity: number;
    } = {
      red: 1,
      green: 1,
      blue: 1,
      intensity: 1,
      "optical:1Pos": 1,
    };
    const colors = new Map([["Head", values]]);
    /** Reads the active projection family without exposing private angle storage. */
    const angle = () =>
      family === "Gobo" ? state.goboRotation : state.prismRotation;
    state.update(colors, 0);
    assert.equal(angle(), Math.PI / 2);
    delete values["optical:1Pos"];
    values["optical:2Pos"] = 1;
    state.update(colors, 1);
    assert.equal(angle(), Math.PI);
    delete values["optical:2Pos"];
    values["optical:1PosRotate"] = 1;
    state.update(colors, 2);
    assert.equal(angle(), Math.PI);
    state.update(colors, 3);
    assert.equal(angle(), Math.PI * 1.5);
  }
});

/** Fixture-wide wheels belonging to other emitters must not consume media or facet capacity. */
test("unreferenced wheels do not load images or reserve split beams", () => {
  const state = new EmitterOpticalState(
    {
      mesh: new Mesh(),
      controlledElement: "Pixel",
      gdtfPath: "fixture.gdtf",
      opticalWheels: [
        {
          name: "OtherHead",
          slots: [
            {
              mediaName: "unused-mask",
              facets: [-2, 0, 2].map((x) => ({
                transform: [1, 0, 0, 0, 1, 0, x, 0, 1],
                colorCie: [0.3127, 0.329, 100],
              })),
            },
          ],
        },
      ],
    },
    () => {
      throw new Error("An unrelated wheel must not load media");
    },
  );
  assert.equal(state.maxFacetCount, 1);
  state.update(new Map());
  assert.equal(state.goboSlot, 0);
  assert.equal(state.prism, undefined);
});

/** A nonlinear distance control must reach the projector's focal plane rather than be skipped. */
test("profiled focus drives the physical focal plane", () => {
  const state = new EmitterOpticalState(
    {
      mesh: new Mesh(),
      controlledElement: "Head",
      opticalChannels: [
        {
          geometry: "Head",
          attribute: "Focus1Distance",
          parameterKey: "FocusDistance",
          dmxMax: 1000,
          functions: [
            {
              attribute: "Focus1Distance",
              physicalUnit: "Length",
              dmxFrom: 0,
              dmxTo: 1000,
              physicalFrom: 2,
              physicalTo: 10,
              dmxProfile: "Quadratic",
              profileCurve: {
                min: 2,
                max: 10,
                points: [{ dmxPercentage: 0, coefficients: [0, 0, 0.01, 0] }],
              },
              sets: [],
            },
          ],
        },
      ],
    },
    () => {
      throw new Error("Focus must not load media");
    },
  );
  const colors = new Map([
    [
      "Head",
      {
        red: 1,
        green: 1,
        blue: 1,
        intensity: 1,
        "optical:FocusDistance": 0.5,
      },
    ],
  ]);
  state.update(colors);
  assert.equal(state.focusDistance, 4);
  colors.clear();
  state.update(colors);
  assert.equal(state.focusDistance, 0);
});

/** Only calibrated length values control the focal plane; generic positions remain uncalibrated. */
test("focus distance preserves physical units and clears missing input", () => {
  for (const physicalUnit of ["Length", "None"]) {
    const state = new EmitterOpticalState(
      {
        mesh: new Mesh(),
        controlledElement: "Head",
        opticalChannels: [
          {
            geometry: "Head",
            attribute: "Focus1",
            parameterKey: "Focus",
            dmxMax: 255,
            functions: [
              {
                attribute: "Focus1",
                physicalUnit,
                dmxFrom: 0,
                dmxTo: 255,
                physicalFrom: 2,
                physicalTo: 20,
                sets: [],
              },
            ],
          },
        ],
      },
      () => {
        throw new Error("Focus must not load media");
      },
    );
    const colors = new Map([
      ["Head", { red: 1, green: 1, blue: 1, intensity: 1, "optical:Focus": 1 }],
    ]);
    state.update(colors);
    assert.equal(state.focusDistance, physicalUnit === "Length" ? 20 : 0);
    colors.clear();
    state.update(colors);
    assert.equal(state.focusDistance, 0);
  }
});

/** Angular speed accumulates elapsed time, preserves indexing, and supports reverse rotation. */
test("indexed and continuous optical rotation have distinct physical semantics", () => {
  for (const prefix of ["Gobo1", "Prism1"]) {
    const state = new EmitterOpticalState(
      {
        mesh: new Mesh(),
        controlledElement: "Head",
        opticalChannels: [
          {
            geometry: "Head",
            attribute: `${prefix}Pos`,
            parameterKey: "Rotation",
            dmxMax: 255,
            functions: [
              {
                attribute: `${prefix}Pos`,
                dmxFrom: 0,
                dmxTo: 127,
                physicalFrom: 90,
                physicalTo: 90,
                sets: [],
              },
              {
                attribute: `${prefix}PosRotate`,
                dmxFrom: 128,
                dmxTo: 255,
                physicalFrom: -180,
                physicalTo: 180,
                sets: [],
              },
            ],
          },
        ],
      },
      () => {
        throw new Error("Rotation must not load images");
      },
    );
    const values = {
      red: 1,
      green: 1,
      blue: 1,
      intensity: 1,
      "optical:Rotation": 0,
    };
    const colors = new Map([["Head", values]]);
    /** Reads the selected family without coupling the test to private channel state. */
    const angle = () =>
      prefix.startsWith("Gobo") ? state.goboRotation : state.prismRotation;
    state.update(colors, 10);
    assert.equal(angle(), Math.PI / 2);
    values["optical:Rotation"] = 1;
    state.update(colors, 10.5);
    assert.equal(angle(), Math.PI);
    values["optical:Rotation"] = 128 / 255;
    state.update(colors, 11);
    assert.equal(angle(), Math.PI / 2);
    state.update(colors, 5);
    assert.equal(angle(), Math.PI / 2);
    values["optical:Rotation"] = 0;
    state.update(colors, 6);
    assert.equal(angle(), Math.PI / 2);
  }
});

/** Open wheel slots and absent DMX clear a previously selected prism without rebuilding its facets. */
test("prism DMX selects source facets and resets to an unsplit aperture", () => {
  const state = new EmitterOpticalState(
    {
      mesh: new Mesh(),
      controlledElement: "Pixel",
      opticalWheels: [
        {
          name: "Prisms",
          slots: [
            { facets: [] },
            {
              facets: [-2, 0, 2].map((x) => ({
                transform: [1, 0, 0, 0, 1, 0, x, 0, 1],
                colorCie: [0.3127, 0.329, 100],
              })),
            },
          ],
        },
      ],
      opticalChannels: [
        {
          geometry: "Head",
          attribute: "Prism1",
          parameterKey: "Prism1",
          dmxMax: 255,
          functions: [
            {
              attribute: "Prism1",
              dmxFrom: 0,
              dmxTo: 255,
              physicalFrom: 0,
              physicalTo: 1,
              wheel: "Prisms",
              sets: [
                {
                  dmxFrom: 0,
                  dmxTo: 127,
                  physicalFrom: 0,
                  physicalTo: 0,
                  wheelSlot: 1,
                },
                {
                  dmxFrom: 128,
                  dmxTo: 255,
                  physicalFrom: 1,
                  physicalTo: 1,
                  wheelSlot: 2,
                },
              ],
            },
          ],
        },
      ],
    },
    () => {
      throw new Error("Prism facets must not request gobo media");
    },
  );
  const values = {
    red: 1,
    green: 1,
    blue: 1,
    intensity: 1,
    "optical:Prism1": 1,
  };
  const colors = new Map([["Head", values]]);
  state.update(colors);
  const compiled = state.prism;
  assert.deepEqual(
    compiled?.map((facet) => facet.x),
    [-2, 0, 2],
  );
  values["optical:Prism1"] = 0;
  state.update(colors);
  assert.equal(state.prism, undefined);
  values["optical:Prism1"] = 1;
  state.update(colors);
  assert.equal(state.prism, compiled);
  colors.clear();
  state.update(colors);
  assert.equal(state.prism, undefined);
});

/** A head-level DMX channel selects a descendant's imported mask without playback-time image requests. */
test("emitter optical state selects imported wheel masks and restores open slots", () => {
  let loads = 0;
  const state = new EmitterOpticalState(
    {
      mesh: new Mesh(),
      controlledElement: "Pixel",
      gdtfPath: "fixture.gdtf",
      opticalWheels: [
        {
          name: "Gobos",
          slots: [{ facets: [] }, { mediaName: "stars", facets: [] }],
        },
      ],
      opticalChannels: [
        {
          geometry: "Head",
          attribute: "Gobo1",
          parameterKey: "Gobo",
          dmxMax: 255,
          functions: [
            {
              attribute: "Gobo1",
              dmxFrom: 0,
              dmxTo: 255,
              physicalFrom: 1,
              physicalTo: 2,
              wheel: "Gobos",
              sets: [
                {
                  dmxFrom: 0,
                  dmxTo: 127,
                  physicalFrom: 1,
                  physicalTo: 1,
                  wheelSlot: 1,
                },
                {
                  dmxFrom: 128,
                  dmxTo: 255,
                  physicalFrom: 2,
                  physicalTo: 2,
                  wheelSlot: 2,
                },
              ],
            },
          ],
        },
      ],
    },
    (path, media) => {
      assert.equal(path, "fixture.gdtf");
      assert.equal(media, "stars");
      loads++;
      return { index: 7, status: "ready" };
    },
  );
  const values = { red: 1, green: 1, blue: 1, intensity: 1, "optical:Gobo": 1 };
  const colors = new Map([["Head", values]]);
  state.update(colors);
  assert.equal(state.goboSlot, 7);
  values["optical:Gobo"] = 0;
  state.update(colors);
  assert.equal(state.goboSlot, 0);
  assert.equal(loads, 1);
});
