// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  beamConeAngleDegrees,
  MIN_CONE_ANGLE_DEGREES,
  renderableConeAngleDegrees,
} from "./beam-zoom";

/** Verifies a profile-stated zoom angle replaces the normalized zoom range. */
test("renderable cone angle prefers a stated zoom angle", () => {
  assert.equal(renderableConeAngleDegrees(8, 40, 0, 12), 12);
  assert.equal(renderableConeAngleDegrees(8, 40, 0), 40);
});

/** Verifies zero or negative stated zoom angles still render a visible cone. */
test("renderable cone angle floors nonpositive zoom angles", () => {
  assert.equal(renderableConeAngleDegrees(8, 40, 0, 0), MIN_CONE_ANGLE_DEGREES);
  assert.equal(
    renderableConeAngleDegrees(8, 40, 0, -5),
    MIN_CONE_ANGLE_DEGREES,
  );
  assert.equal(renderableConeAngleDegrees(0, 0, 1), MIN_CONE_ANGLE_DEGREES);
});

/** Verifies a non-finite stated zoom angle falls back to the beam spec range. */
test("renderable cone angle ignores non-finite zoom angles", () => {
  assert.equal(renderableConeAngleDegrees(8, 40, 1, Number.NaN), 8);
});

/** Verifies normalized zoom follows operator semantics where 100% is focused. */
test("beam cone angle narrows as zoom increases", () => {
  assert.equal(beamConeAngleDegrees(8, 40, 0), 40);
  assert.equal(beamConeAngleDegrees(8, 40, 0.5), 24);
  assert.equal(beamConeAngleDegrees(8, 40, 1), 8);
});

/** Verifies out-of-range zoom values clamp to the physical beam range. */
test("beam cone angle clamps zoom to the physical range", () => {
  assert.equal(beamConeAngleDegrees(8, 40, -1), 40);
  assert.equal(beamConeAngleDegrees(8, 40, 2), 8);
});
