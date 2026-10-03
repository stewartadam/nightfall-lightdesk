// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { Mesh } from "three/webgpu";
import {
  type Attribute,
  DmxValueResolution,
  type FixtureElement,
  type GeometryNode,
  GeometryType,
  MergeStrategy,
  type ParameterFunction,
  type ParameterFunctionSet,
  type ParameterMetadata,
  ParameterValuePolarity,
  PhysicalUnit,
  type PrismFacet,
} from "../../../../types";
import {
  bindElementOpticalParameters,
  bindEmitterOpticalParameters,
} from "../../model/optical-bindings";
import type { EmitterData } from "../../model/types";
import { loadFixtureEvaluation } from "../channel-evaluation";
import type { EmitterColor } from "../geometry-builder";
import { extractFixtureDmxData, resetDmxPool } from "../visualizer-dmx";
import { EmitterOpticalState } from "./emitter-optical-state";
import type { GoboAtlasSlot } from "./gobo-atlas";

before(() => loadFixtureEvaluation());

/** Builds 8-bit parameter metadata with profile functions. */
function parameter(
  attribute: Attribute,
  functions?: ParameterFunction[],
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
  };
}

/** Builds a profile function over a DMX range with a linear physical range. */
function fn(
  attribute: string,
  extra: Partial<ParameterFunction> = {},
): ParameterFunction {
  return {
    name: attribute,
    attribute,
    dmx_from: 0,
    dmx_to: 255,
    physical_from: 0,
    physical_to: 1,
    ...extra,
  };
}

/** Builds a channel set covering a DMX range. */
function set(
  dmx_from: number,
  dmx_to: number,
  extra: Partial<ParameterFunctionSet> = {},
): ParameterFunctionSet {
  return { name: `${dmx_from}-${dmx_to}`, dmx_from, dmx_to, ...extra };
}

/** A white prism facet translated by `x`, `y`. */
function facet(x: number, y = 0): PrismFacet {
  return {
    transform: [1, 0, 0, 0, 1, 0, x, y, 1],
    color: { x: 0.3127, y: 0.329, Y: 100 },
  };
}

/** Builds a head element whose dimmer is open, plus the given optical parameters. */
function head(label: string, parameters: ParameterMetadata[]): FixtureElement {
  return {
    label,
    parameters: [parameter({ type: "Intensity" }), ...parameters],
  };
}

/** Records every image an optical state requests and hands out ready atlas slots. */
function atlas() {
  const requests: [string, string, string | undefined][] = [];
  const load = (path: string, media: string, revision?: string) => {
    requests.push([path, media, revision]);
    return { index: requests.length, status: "ready" } as GoboAtlasSlot;
  };
  return { requests, load };
}

/** Builds an emitter driven by every optical parameter of `elements`. */
function emitter(elements: FixtureElement[]): EmitterData {
  return {
    mesh: new Mesh(),
    controlledElement: elements[0].label,
    opticalParameters: bindElementOpticalParameters(elements),
    gdtfPath: "fixture.gdtf",
    gdtfRevision: "rev-1",
  };
}

/**
 * Evaluates element outputs with develop's fixture evaluator and returns the
 * element records renderers receive, keyed by element label.
 */
function records(
  elements: FixtureElement[],
  outputs: (Record<string, number> | undefined)[],
): Map<string, EmitterColor> {
  resetDmxPool();
  return new Map(
    extractFixtureDmxData(elements, outputs).map(([label, dmx]) => [
      label,
      dmx as unknown as EmitterColor,
    ]),
  );
}

/** Ancestor zoom follows the evaluated physical angle and clears when another function becomes active. */
test("inherited zoom follows the evaluated angle and clears inactive functions", () => {
  const optics = head("Head", [
    parameter({ type: "Zoom" }, [
      fn("Zoom", {
        dmx_to: 200,
        physical_from: 5,
        physical_to: 45,
        physical_unit: PhysicalUnit.Angle,
      }),
      fn("NoFeature", { dmx_from: 201, physical_from: 0, physical_to: 0 }),
    ]),
  ]);
  const cell: FixtureElement = { label: "Cell", parameters: [] };
  const geometry = {
    nodes: [
      node("Head", -1),
      { ...node("Cell", 0), geometryType: GeometryType.Beam },
    ],
    roots: [0],
  };
  const state = new EmitterOpticalState(
    {
      mesh: new Mesh(),
      controlledElement: "Cell",
      opticalParameters: bindEmitterOpticalParameters(geometry, [
        optics,
        cell,
      ]).get("Cell"),
    },
    () => {
      throw new Error("Zoom must not load media");
    },
  );
  state.update(records([optics, cell], [{ Intensity: 255, Zoom: 100 }, {}]));
  assert.equal(state.zoomDegrees, 25);
  state.update(records([optics, cell], [{ Intensity: 255, Zoom: 230 }, {}]));
  assert.equal(state.zoomDegrees, undefined);
});

/** Profiles may end a zoom range at zero or below; the angle is kept so the renderer can floor it. */
test("zoom accepts finite nonpositive physical angles", () => {
  const optics = head("Head", [
    parameter({ type: "Zoom" }, [
      fn("Zoom", {
        physical_from: -5,
        physical_to: 30,
        physical_unit: PhysicalUnit.Angle,
      }),
    ]),
  ]);
  const state = new EmitterOpticalState(emitter([optics]), atlas().load);
  state.update(records([optics], [{ Intensity: 255, Zoom: 0 }]));
  assert.equal(state.zoomDegrees, -5);
});

/**
 * GDTF defaults PhysicalFrom/To to 0/1, so an Angle zoom that omits its range states no degrees
 * and must leave the aperture to its normalized zoom instead of a sub-degree pencil beam, while a
 * real descending angular range (34°→1°) is read as degrees.
 */
test("angle zoom reads degrees only from a real angular range", () => {
  const zoomHead = (physical_from: number, physical_to: number) =>
    head("Head", [
      parameter({ type: "Zoom" }, [
        fn("Zoom", {
          physical_from,
          physical_to,
          physical_unit: PhysicalUnit.Angle,
        }),
      ]),
    ]);
  const unitRange = zoomHead(0, 1);
  const unit = new EmitterOpticalState(emitter([unitRange]), atlas().load);
  unit.update(records([unitRange], [{ Intensity: 255, Zoom: 128 }]));
  assert.equal(unit.zoomDegrees, undefined);

  const angular = zoomHead(34, 1);
  const degrees = new EmitterOpticalState(emitter([angular]), atlas().load);
  degrees.update(records([angular], [{ Intensity: 255, Zoom: 0 }]));
  assert.equal(degrees.zoomDegrees, 34);
});

/** Zoom functions without an angular unit give no beam angle to replace the aperture's own. */
test("zoom without an angle unit leaves the native beam", () => {
  const optics = head("Head", [
    parameter({ type: "Zoom" }, [
      fn("Zoom", { physical_unit: PhysicalUnit.Percent }),
    ]),
  ]);
  const state = new EmitterOpticalState(emitter([optics]), atlas().load);
  state.update(records([optics], [{ Intensity: 255, Zoom: 128 }]));
  assert.equal(state.zoomDegrees, undefined);
});

/** Independent gobo wheels stack in wheel order with their own selection and rotation. */
test("gobo wheels stack with separate selection and rotation", () => {
  const optics = head("Head", [
    parameter({ type: "Custom", data: { label: "Gobo2" } }, [
      fn("Gobo2", {
        sets: [set(0, 127), set(128, 255, { media: "dots" })],
      }),
    ]),
    parameter({ type: "Gobo" }, [
      fn("Gobo1", {
        sets: [set(0, 9), set(10, 255, { media: "stars" })],
      }),
    ]),
    parameter({ type: "Custom", data: { label: "Gobo1Pos" } }, [
      fn("Gobo1Pos", {
        physical_from: 0,
        physical_to: 360,
        physical_unit: PhysicalUnit.Angle,
      }),
    ]),
  ]);
  const { requests, load } = atlas();
  const state = new EmitterOpticalState(emitter([optics]), load);
  assert.deepEqual(requests, [
    ["fixture.gdtf", "dots", "rev-1"],
    ["fixture.gdtf", "stars", "rev-1"],
  ]);
  assert.equal(state.gobos.length, 2);
  const [first, second] = state.gobos;
  state.update(
    records([optics], [{ Intensity: 255, Gobo: 20, Gobo2: 200, Gobo1Pos: 0 }]),
  );
  assert.equal(first.slot, 2, "Gobo1 comes first in the optical path");
  assert.equal(second.slot, 1);
  state.update(
    records([optics], [{ Intensity: 255, Gobo: 0, Gobo2: 200, Gobo1Pos: 255 }]),
  );
  assert.equal(first.slot, 0, "open Gobo1 slot transmits fully");
  assert.equal(second.slot, 1, "Gobo2 still projects behind an open Gobo1");
  assert.ok(Math.abs(first.rotation - Math.PI * 2) < 1e-9);
  assert.equal(second.rotation, 0);
  assert.equal(state.gobos[0], first, "stages are reused across frames");
});

/** Colour wheel images are swatches, never masks, and cost no atlas space. */
test("colour wheels never project", () => {
  const optics = head("Head", [
    parameter({ type: "Custom", data: { label: "Color1" } }, [
      fn("Color1", { sets: [set(0, 255, { media: "swatch" })] }),
    ]),
  ]);
  const { requests, load } = atlas();
  const state = new EmitterOpticalState(emitter([optics]), load);
  state.update(records([optics], [{ Intensity: 255, Color1: 100 }]));
  assert.deepEqual(requests, []);
  assert.equal(state.gobos.length, 0);
});

/** An unnumbered `Gobo` wheel is wheel 1 and projects its images. */
test("unnumbered gobo wheels project", () => {
  const optics = head("Head", [
    parameter({ type: "Gobo" }, [
      fn("Gobo", { sets: [set(0, 9), set(10, 255, { media: "stars" })] }),
    ]),
  ]);
  const state = new EmitterOpticalState(emitter([optics]), atlas().load);
  state.update(records([optics], [{ Intensity: 255, Gobo: 20 }]));
  assert.equal(state.gobos.length, 1);
  assert.equal(state.gobos[0].slot, 1);
});

/** Images still loading, and fixtures without output, leave the aperture unmasked. */
test("pending images and absent output leave the aperture open", () => {
  const optics = head("Head", [
    parameter({ type: "Gobo" }, [
      fn("Gobo1", { sets: [set(0, 255, { media: "stars" })] }),
    ]),
  ]);
  const slot: GoboAtlasSlot = { index: 3, status: "loading" };
  const state = new EmitterOpticalState(emitter([optics]), () => slot);
  const colors = records([optics], [{ Intensity: 255, Gobo: 20 }]);
  state.update(colors);
  assert.equal(state.gobos[0].slot, 0);
  slot.status = "ready";
  state.update(colors);
  assert.equal(state.gobos[0].slot, 3);
  state.update(new Map());
  assert.equal(state.gobos[0].slot, 0);
});

/** Continuous rotation accumulates elapsed time at the evaluated speed; indexing sets an absolute angle. */
test("indexed and continuous rotation have distinct physical semantics", () => {
  const optics = head("Head", [
    parameter({ type: "Gobo" }, [
      fn("Gobo1", { sets: [set(0, 255, { media: "stars" })] }),
    ]),
    parameter({ type: "Custom", data: { label: "Gobo1Rot" } }, [
      fn("Gobo1Pos", {
        dmx_to: 127,
        physical_from: 0,
        physical_to: 360,
        physical_unit: PhysicalUnit.Angle,
      }),
      fn("Gobo1PosRotate", {
        dmx_from: 128,
        physical_from: -90,
        physical_to: 90,
        physical_unit: PhysicalUnit.AngularSpeed,
      }),
    ]),
  ]);
  const state = new EmitterOpticalState(emitter([optics]), atlas().load);
  state.update(
    records([optics], [{ Intensity: 255, Gobo: 10, Gobo1Rot: 0 }]),
    0,
  );
  assert.equal(state.gobos[0].rotation, 0);
  const spin = records([optics], [{ Intensity: 255, Gobo: 10, Gobo1Rot: 255 }]);
  state.update(spin, 1);
  assert.ok(Math.abs(state.gobos[0].rotation - Math.PI / 2) < 1e-9);
  state.update(spin, 2);
  assert.ok(Math.abs(state.gobos[0].rotation - Math.PI) < 1e-9);
});

/** Prism sets select their imported facets and reset to an unsplit aperture on open slots and absent DMX. */
test("prism sets select facets and reset to an unsplit aperture", () => {
  const optics = head("Head", [
    parameter({ type: "Prism" }, [
      fn("Prism1", {
        sets: [set(0, 127), set(128, 255, { facets: [facet(0), facet(1)] })],
      }),
    ]),
  ]);
  const state = new EmitterOpticalState(emitter([optics]), () => {
    throw new Error("Prisms must not load media");
  });
  assert.equal(state.maxFacetCount, 2);
  state.update(records([optics], [{ Intensity: 255, Prism: 200 }]));
  assert.deepEqual(
    state.prism?.map(({ x }) => x),
    [0, 1],
  );
  state.update(records([optics], [{ Intensity: 255, Prism: 0 }]));
  assert.equal(state.prism, undefined);
  state.update(new Map());
  assert.equal(state.prism, undefined);
});

/** Independent prism wheels combine their facets instead of overwriting each other. */
test("two active prism wheels compose instead of overwriting", () => {
  const optics = head("Head", [
    parameter({ type: "Prism" }, [
      fn("Prism1", {
        sets: [set(0, 127), set(128, 255, { facets: [facet(0), facet(1)] })],
      }),
    ]),
    parameter({ type: "Custom", data: { label: "Prism2" } }, [
      fn("Prism2", {
        sets: [
          set(0, 127),
          set(128, 255, {
            facets: [facet(0, 0), facet(0, 1), facet(0, 2)],
          }),
        ],
      }),
    ]),
  ]);
  const state = new EmitterOpticalState(emitter([optics]), atlas().load);
  assert.equal(state.maxFacetCount, 6);
  state.update(
    records([optics], [{ Intensity: 255, Prism: 200, Prism2: 200 }]),
  );
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
  state.update(records([optics], [{ Intensity: 255, Prism: 200, Prism2: 0 }]));
  assert.equal(state.prism?.length, 2);
});

/** A fixture's potential split must not warn until DMX activates enough facets to exceed its budget. */
test("prism reduction follows active DMX combinations", () => {
  const split = Array.from({ length: 33 }, (_, x) => facet(x));
  const optics = head("Head", [
    parameter({ type: "Prism" }, [
      fn("Prism1", { sets: [set(0, 127), set(128, 255, { facets: split })] }),
    ]),
    parameter({ type: "Custom", data: { label: "Prism2" } }, [
      fn("Prism2", { sets: [set(0, 127), set(128, 255, { facets: split })] }),
    ]),
  ]);
  const state = new EmitterOpticalState(emitter([optics]), atlas().load);
  assert.equal(state.prismCapacityExceeded, true);
  assert.equal(state.maxFacetCount, 1024);
  state.update(records([optics], [{ Intensity: 255, Prism: 200, Prism2: 0 }]));
  assert.equal(state.prismReduced, false);
  assert.equal(state.prism?.length, 33);
  state.update(
    records([optics], [{ Intensity: 255, Prism: 200, Prism2: 200 }]),
  );
  assert.equal(state.prismReduced, true);
  assert.equal(state.prism?.length, 1024);
  state.update(new Map());
  assert.equal(state.prismReduced, false);
  assert.equal(state.prism, undefined);
});

/** Only calibrated length values move the focal plane; uncalibrated positions keep default focus. */
test("focus distance follows length-valued functions only", () => {
  const calibrated = head("Head", [
    parameter({ type: "Focus" }, [
      fn("Focus1", {
        physical_from: 2,
        physical_to: 20,
        physical_unit: PhysicalUnit.Length,
      }),
    ]),
  ]);
  const state = new EmitterOpticalState(emitter([calibrated]), atlas().load);
  state.update(records([calibrated], [{ Intensity: 255, Focus: 255 }]));
  assert.equal(state.focusDistance, 20);
  state.update(new Map());
  assert.equal(state.focusDistance, 0);

  const generic = head("Head", [
    parameter({ type: "Focus" }, [
      fn("Focus1", { physical_unit: PhysicalUnit.Percent }),
    ]),
  ]);
  const uncalibrated = new EmitterOpticalState(
    emitter([generic]),
    atlas().load,
  );
  uncalibrated.update(records([generic], [{ Intensity: 255, Focus: 255 }]));
  assert.equal(uncalibrated.focusDistance, 0);
});

/** Builds minimal geometry without fixture-specific classification. */
function node(name: string, parentIndex: number): GeometryNode {
  return {
    name,
    parentIndex,
    children: [],
    geometryType: GeometryType.Generic,
    transform: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
  };
}
