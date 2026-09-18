// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { FixtureGeometry } from "../../../types";
import { GeometryType, PrimitiveType } from "../../../types";
import {
  buildSequentialFixturePlacementUpdates,
  FIRST_INSERT_Y,
  FIXTURE_INSERT_MARGIN,
  FIXTURE_INSERT_STEP,
} from "./fixture-insert-placement";

const IDENTITY_TRANSFORM = {
  elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ],
};

function buildGeometryWithModelHeight(height: number): FixtureGeometry {
  return {
    nodes: [
      {
        name: "Body",
        geometryType: GeometryType.Generic,
        transform: IDENTITY_TRANSFORM,
        model: {
          name: "Body",
          primitiveType: PrimitiveType.Cube,
          width: 0.4,
          length: 0.6,
          height,
        },
        parentIndex: -1,
        children: [],
      },
    ],
    roots: [0],
    meshResources: {},
  };
}

function buildGeometryOffsetBelowOrigin(): FixtureGeometry {
  return {
    nodes: [
      {
        name: "Body",
        geometryType: GeometryType.Generic,
        transform: {
          elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -0.8, 1],
        },
        model: {
          name: "Body",
          primitiveType: PrimitiveType.Cube,
          width: 0.4,
          length: 0.4,
          height: 0.6,
        },
        parentIndex: -1,
        children: [],
      },
    ],
    roots: [0],
    meshResources: {},
  };
}

test("buildSequentialFixturePlacementUpdates lifts a single fixture above the floor", () => {
  assert.deepEqual(buildSequentialFixturePlacementUpdates([101]), [
    {
      id: 101,
      position: {
        type: "All",
        data: {
          x: 0,
          y: FIRST_INSERT_Y,
          z: 0,
        },
      },
    },
  ]);
});

test("buildSequentialFixturePlacementUpdates applies sequential x and y offsets with z fixed to zero", () => {
  assert.deepEqual(buildSequentialFixturePlacementUpdates([3, 7, 11]), [
    {
      id: 3,
      position: {
        type: "All",
        data: {
          x: 0,
          y: FIRST_INSERT_Y,
          z: 0,
        },
      },
    },
    {
      id: 7,
      position: {
        type: "All",
        data: {
          x: FIXTURE_INSERT_STEP,
          y: FIRST_INSERT_Y + FIXTURE_INSERT_STEP,
          z: 0,
        },
      },
    },
    {
      id: 11,
      position: {
        type: "All",
        data: {
          x: FIXTURE_INSERT_STEP * 2,
          y: FIRST_INSERT_Y + FIXTURE_INSERT_STEP * 2,
          z: 0,
        },
      },
    },
  ]);
});

test("buildSequentialFixturePlacementUpdates uses fixture height for stagger when geometry is available", () => {
  assert.deepEqual(
    buildSequentialFixturePlacementUpdates(
      [21, 22, 23],
      buildGeometryWithModelHeight(1.2),
    ),
    [
      {
        id: 21,
        position: {
          type: "All",
          data: {
            x: 0,
            y: 1.2 + FIXTURE_INSERT_MARGIN,
            z: 0,
          },
        },
      },
      {
        id: 22,
        position: {
          type: "All",
          data: {
            x: 1.2 + FIXTURE_INSERT_MARGIN,
            y: (1.2 + FIXTURE_INSERT_MARGIN) * 2,
            z: 0,
          },
        },
      },
      {
        id: 23,
        position: {
          type: "All",
          data: {
            x: (1.2 + FIXTURE_INSERT_MARGIN) * 2,
            y: 4.2,
            z: 0,
          },
        },
      },
    ],
  );
});

test("buildSequentialFixturePlacementUpdates lifts fixtures above the floor using geometry bounds", () => {
  assert.deepEqual(
    buildSequentialFixturePlacementUpdates(
      [44],
      buildGeometryOffsetBelowOrigin(),
    ),
    [
      {
        id: 44,
        position: {
          type: "All",
          data: {
            x: 0,
            y: 0.8,
            z: 0,
          },
        },
      },
    ],
  );
});
