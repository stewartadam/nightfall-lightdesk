// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../../../types/index";

export const FIXTURE_INSERT_STEP = 0.5;
export const FIRST_INSERT_Y = 0.5;
export const FIXTURE_INSERT_MARGIN = 0.2;

function normalizeInsertCoordinate(value: number): number {
  return Number(value.toFixed(6));
}

function computeFixtureModelHeight(
  geometry: types.FixtureGeometry | null | undefined,
): number | null {
  if (!geometry || geometry.nodes.length === 0) {
    return null;
  }

  let maxModelHeight = 0;

  for (const node of geometry.nodes) {
    const model = node.model;
    if (!model || node.geometryType === "beam") {
      continue;
    }

    maxModelHeight = Math.max(maxModelHeight, model.height);
  }

  if (maxModelHeight <= 0) {
    return null;
  }

  return maxModelHeight;
}

function getFixtureInsertMetrics(
  geometry: types.FixtureGeometry | null | undefined,
) {
  const modelHeight = computeFixtureModelHeight(geometry);
  if (!modelHeight) {
    return {
      firstInsertY: FIRST_INSERT_Y,
      step: FIXTURE_INSERT_STEP,
    };
  }

  const stackedStep = modelHeight + FIXTURE_INSERT_MARGIN;

  return {
    firstInsertY: Math.max(FIRST_INSERT_Y, stackedStep),
    step: stackedStep,
  };
}

export function buildSequentialFixturePlacementUpdates(
  fixtureIds: readonly number[],
  geometry?: types.FixtureGeometry | null,
): types.FixturePlacementUpdateEntry[] {
  const { firstInsertY, step } = getFixtureInsertMetrics(geometry);

  return fixtureIds.map((id, index) => {
    const offset = index * step;

    return {
      id,
      position: {
        type: "All",
        data: {
          x: normalizeInsertCoordinate(offset),
          y: normalizeInsertCoordinate(firstInsertY + offset),
          z: 0,
        },
      },
    };
  });
}
